import type { ApiClient } from '../api/api-client.js';
import { HttpResponseError, RequestTimeoutError, ResponseParseError } from '../api/base-client.js';
import {
  GatewayBusinessError,
  GatewayEnvelopeError,
  GatewayShapeError,
} from '../api/request-adapter.js';
import { site } from '../site.js';
import {
  API_ACTION_CREATE_ORDER,
  API_ACTION_CREATE_MULTI_ORDER,
  API_ACTION_MERGE_PAY,
  API_ACTION_QUERY_ORDER_DETAIL,
  API_ACTION_QUERY_PAY_RESULT,
  API_ORCHESTRATION_PATH,
  API_PRODUCT_ACCOUNT_CENTER,
  API_PRODUCT_BSS,
  API_PRODUCT_BSS_PAYMENT,
  API_VERSION_MERGE_PAY,
} from '../types/api-routes.js';
import type {
  TokenPlanCreatedOrders,
  TokenPlanMergePayInput,
  TokenPlanMergePayResult,
  TokenPlanPaymentResult,
  TokenPlanPaymentWaitOptions,
  TokenPlanSettlementInfo,
} from '../types/tokenplan-payment.js';
import { DecimalAmount } from '../utils/decimal-amount.js';
import { PAYMENT_CHANNELS, DEFAULT_CHANNEL } from '../config/payment-channels.js';
import { CliError, invalidArgError } from '../utils/errors.js';
import type { ExitCode } from '../utils/exit-codes.js';
import { PAYMENT_URL_HOSTS, validatePaymentUrl } from '../utils/strings.js';
import { parseOrderSettlement } from './tokenplan-payment-capabilities.js';
import { withTokenPlanDeadline } from './tokenplan-deadline.js';
import { TOKEN_PLAN_ACCOUNT_SETTINGS_URL } from './tokenplan-urls.js';

const POLL_INTERVAL_MS = 3_000;
export const PAYMENT_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const MAX_SAFE_ORDER_ID = BigInt(Number.MAX_SAFE_INTEGER);
const CONFIRMED_REJECTION_CODES = new Set(['ORDER:ORDER.INST_HAS_UNPAID_ORDER']);
const CONFIRMED_PAYMENT_REJECTION_CODES = new Set(['INSUFFICIENT_BALANCE']);
const ORDER_RECOVERY_PAGE_SIZE = 100;

function protocolError(): CliError {
  return new CliError({
    code: 'PAYMENT_PROTOCOL_ERROR',
    message: 'The Token Plan payment response could not be verified.',
    exitCode: 4,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function orderId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) return value;
  throw protocolError();
}

function numericOrderId(value: string): number {
  if (BigInt(value) > MAX_SAFE_ORDER_ID) throw protocolError();
  return Number(value);
}

function uniqueOrderIds(value: string[]): string[] {
  if (new Set(value).size !== value.length) throw protocolError();
  return value;
}

function sameOrderIdSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function aliases<T>(
  record: Record<string, unknown>,
  keys: readonly string[],
  parse: (value: unknown) => T,
): T | undefined {
  const values = keys.filter((key) => Object.hasOwn(record, key)).map((key) => parse(record[key]));
  if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]))) {
    throw protocolError();
  }
  return values[0];
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw protocolError();
  return value.trim();
}

function optionalFailureText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return text(value);
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError();
  const code = aliases(value, ['Code', 'code'], text);
  const success = aliases(value, ['Success', 'success', 'successResponse'], (entry) => {
    if (typeof entry !== 'boolean') throw protocolError();
    return entry;
  });
  if (code !== undefined && code !== 'Success' && code !== '200') {
    if (!code) throw protocolError();
    throw new GatewayBusinessError(code, 'Token Plan request rejected.');
  }
  if (success === false) throw protocolError();
  return value;
}

function checkResponseOrderId(record: Record<string, unknown>, expected: string): void {
  const echoed = aliases(record, ['orderId', 'OrderId'], orderId);
  if (echoed !== undefined && echoed !== expected) throw protocolError();
}

function parseCreatedOrders(value: unknown, team: boolean): TokenPlanCreatedOrders {
  const record = responseRecord(value);
  if (!team) {
    const createdId = aliases(record, ['orderId', 'OrderId'], orderId);
    if (!createdId) throw protocolError();
    return { paymentOrderId: createdId, orderIds: [createdId] };
  }
  const parseIds = (ids: unknown): string[] => {
    if (!Array.isArray(ids) || ids.length === 0) throw protocolError();
    return uniqueOrderIds(Array.from(ids, orderId));
  };
  const ids = aliases(record, ['orderIds', 'OrderIds'], parseIds);
  const itemIds = aliases(record, ['items', 'Items'], (items) => {
    if (!Array.isArray(items) || items.length === 0) throw protocolError();
    return uniqueOrderIds(
      Array.from(items, (item: unknown) => {
        if (!isRecord(item)) throw protocolError();
        const createdId = aliases(item, ['orderId', 'OrderId'], orderId);
        if (!createdId) throw protocolError();
        return createdId;
      }),
    );
  });
  if (ids && itemIds && !sameOrderIdSet(ids, itemIds)) throw protocolError();
  const orderIds = ids ?? itemIds;
  if (!orderIds) throw protocolError();
  const primaryOrderId = aliases(record, ['orderId', 'OrderId'], orderId);
  if (primaryOrderId !== undefined && !orderIds.includes(primaryOrderId)) throw protocolError();
  return { paymentOrderId: primaryOrderId ?? orderIds[0], orderIds };
}

function checkCn(): void {
  const codes = site.features.tokenPlanCommodityCodes;
  if (
    site.features.currency !== 'CNY' ||
    !codes.soloBuy.endsWith('_cn') ||
    !codes.teams.endsWith('_cn')
  ) {
    throw new CliError({
      code: 'PAYMENT_SITE_UNSUPPORTED',
      message: 'Token Plan payments support CN/CNY only.',
      exitCode: 4,
    });
  }
}

function configurationSnapshot(configurations: ReadonlyArray<Record<string, unknown>>): {
  configurations: Record<string, unknown>[];
  team: boolean;
} {
  const invalid = () =>
    invalidArgError('A complete, homogeneous CN Token Plan BUY configuration is required.');
  if (!Array.isArray(configurations) || configurations.length === 0) throw invalid();
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(
      JSON.stringify(configurations, (_key, value: unknown) => {
        if (
          typeof value === 'bigint' ||
          typeof value === 'function' ||
          typeof value === 'symbol' ||
          (typeof value === 'number' && !Number.isFinite(value))
        )
          throw invalid();
        return value;
      }),
    );
  } catch {
    throw invalid();
  }
  if (!Array.isArray(snapshot)) throw invalid();
  const codes = site.features.tokenPlanCommodityCodes;
  const validated: Record<string, unknown>[] = [];
  for (const configuration of snapshot) {
    if (
      !isRecord(configuration) ||
      (configuration.commodityCode !== codes.soloBuy &&
        configuration.commodityCode !== codes.teams) ||
      typeof configuration.specCode !== 'string' ||
      !configuration.specCode.trim() ||
      configuration.chargeType !== 'PREPAY' ||
      configuration.orderType !== 'BUY' ||
      typeof configuration.autoRenew !== 'boolean' ||
      typeof configuration.quantity !== 'number' ||
      !Number.isSafeInteger(configuration.quantity) ||
      configuration.quantity < 1 ||
      typeof configuration.duration !== 'string' ||
      !/^[1-9]\d*$/u.test(configuration.duration) ||
      typeof configuration.pricingCycle !== 'string' ||
      !configuration.pricingCycle.trim() ||
      !isRecord(configuration.orderParams) ||
      !Array.isArray(configuration.components) ||
      configuration.components.length === 0
    )
      throw invalid();
    for (const component of configuration.components) {
      if (
        !isRecord(component) ||
        typeof component.componentCode !== 'string' ||
        !component.componentCode.trim() ||
        !Array.isArray(component.instanceProperty) ||
        component.instanceProperty.length === 0 ||
        component.instanceProperty.some(
          (property: unknown) =>
            !isRecord(property) ||
            typeof property.code !== 'string' ||
            !property.code.trim() ||
            typeof property.value !== 'string',
        )
      )
        throw invalid();
    }
    validated.push(configuration);
  }
  const team = validated[0].commodityCode === codes.teams;
  if (
    (!team && validated.length !== 1) ||
    validated.some((entry) => entry.commodityCode !== validated[0].commodityCode)
  )
    throw invalid();
  return { configurations: validated, team };
}

function isRealNameRequired(error: unknown): boolean {
  const code =
    error instanceof GatewayBusinessError || error instanceof GatewayEnvelopeError
      ? error.code
      : error instanceof CliError
        ? error.code
        : error instanceof Error
          ? String(Reflect.get(error, 'code') ?? '')
          : '';
  const message = error instanceof Error ? error.message : '';
  return (
    code.includes('NO_REAL_NAME_AUTHENTICATION') || message.includes('NO_REAL_NAME_AUTHENTICATION')
  );
}

function hasNetworkCode(error: unknown, depth = 0): boolean {
  if (!isRecord(error) || depth > 4) return false;
  return (
    (typeof error.code === 'string' && NETWORK_CODES.has(error.code)) ||
    hasNetworkCode(error.cause, depth + 1)
  );
}

function requestFailure(error: unknown): {
  error: CliError;
  transient: boolean;
  rejected: boolean;
} {
  const structured = error instanceof GatewayBusinessError || error instanceof GatewayEnvelopeError;
  const code = error instanceof CliError || structured ? error.code : undefined;
  const httpStatus =
    error instanceof HttpResponseError
      ? error.status
      : structured && /^\d{3}$/u.test(code ?? '')
        ? Number(code)
        : undefined;
  let exitCode: ExitCode = 1;
  let safeCode = 'PAYMENT_QUERY_FAILED';
  let message = 'The Token Plan payment request failed.';
  let transient = false;
  if (
    error instanceof GatewayShapeError ||
    error instanceof ResponseParseError ||
    error instanceof SyntaxError ||
    (error instanceof CliError && error.exitCode === 4)
  ) {
    return { error: protocolError(), transient: false, rejected: false };
  }
  if (
    (error instanceof CliError && error.exitCode === 2) ||
    httpStatus === 401 ||
    [
      'AUTH_REQUIRED',
      'TOKEN_EXPIRED',
      'InvalidSecurityToken',
      'Login.NotLogined',
      'BailianGateway.Login.NotLogined',
    ].includes(code ?? '')
  ) {
    exitCode = 2;
    safeCode = 'AUTH_REQUIRED';
    message = 'Token Plan payment authentication failed. Run: qianwen auth login';
  } else if (
    httpStatus === 403 ||
    httpStatus === 404 ||
    (error instanceof CliError && error.exitCode === 7) ||
    [
      'InvalidOrderId.NotFound',
      'OrderNotFound',
      'ORDER_NOT_FOUND',
      'Forbidden',
      'Forbidden.OrderNotOwned',
    ].includes(code ?? '')
  ) {
    exitCode = 7;
    safeCode = 'PAYMENT_ORDER_NOT_FOUND';
    message = 'The payment order does not exist or is not accessible.';
  } else if (httpStatus === 429 || (error instanceof CliError && error.exitCode === 5)) {
    exitCode = 5;
    safeCode = 'RATE_LIMITED';
    message = 'The payment query was rate limited.';
    transient = true;
  } else if (
    (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) ||
    (error instanceof CliError && error.exitCode === 6)
  ) {
    exitCode = 6;
    safeCode = 'SERVER_ERROR';
    message = 'The payment service is temporarily unavailable.';
    transient = true;
  } else if (
    httpStatus === 408 ||
    error instanceof RequestTimeoutError ||
    (error instanceof CliError && error.exitCode === 3) ||
    hasNetworkCode(error) ||
    (error instanceof Error &&
      (['AbortError', 'TimeoutError', 'ConnectionClosedError'].includes(error.name) ||
        (error instanceof TypeError && error.message === 'fetch failed')))
  ) {
    exitCode = 3;
    safeCode = 'NETWORK_ERROR';
    message = 'The payment request could not reach the service.';
    transient = true;
  }
  return {
    error: new CliError({ code: safeCode, message, exitCode }),
    transient,
    rejected:
      structured && exitCode === 1 && code !== undefined && CONFIRMED_REJECTION_CODES.has(code),
  };
}

async function withSignal<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request();
  signal.throwIfAborted();
  let onAbort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Payment operation interrupted.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return request();
      }),
      stopped,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function sleep(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, POLL_INTERVAL_MS);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function paymentStatus(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/u.test(value.trim()))
    return BigInt(value.trim()).toString();
  throw protocolError();
}

/**
 * Payment responses may wrap business data in a `Data` field:
 * `{ Code: "Success", Success: true, Data: { PayStatus: ..., AuthUrl: ... } }`.
 * Return the `Data` record when present, otherwise fall back to the outer record
 * for forward-compatibility with gateways that flatten the response.
 */
function unwrapBssData(record: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(record, 'Data') && isRecord(record.Data))
    return record.Data as Record<string, unknown>;
  return record;
}

function parsePaymentResult(value: unknown, requestedId: string): TokenPlanPaymentResult {
  const record = responseRecord(value);
  const data = unwrapBssData(record);
  checkResponseOrderId(data, requestedId);
  const status = aliases(data, ['PayStatus', 'payStatus'], paymentStatus);
  const failure = aliases(data, ['PayFailedErrorCode', 'payFailedErrorCode'], optionalFailureText);
  aliases(data, ['PayFailedMessage', 'payFailedMessage'], optionalFailureText);
  const payStatusCode = status === '0' || status === '1' ? status : undefined;
  if (failure && status === '1')
    return {
      orderId: requestedId,
      status: 'unknown',
      reason: 'protocol_error',
      payStatusCode: status,
    };
  if (failure && CONFIRMED_PAYMENT_REJECTION_CODES.has(failure))
    return {
      orderId: requestedId,
      status: 'failed',
      reason: 'payment_failed',
      ...(payStatusCode ? { payStatusCode } : {}),
    };
  if (failure)
    return {
      orderId: requestedId,
      status: 'unknown',
      reason: 'payment_unconfirmed',
      ...(payStatusCode ? { payStatusCode } : {}),
    };
  if (status === '0' || status === '1')
    return {
      orderId: requestedId,
      status: status === '1' ? 'succeeded' : 'pending',
      payStatusCode: status,
    };
  return { orderId: requestedId, status: 'unknown', reason: 'protocol_error' };
}

function parseRecoveredOrderResult(
  value: unknown,
  requestedId: string,
): TokenPlanPaymentResult | null {
  const record = responseRecord(value);
  if (!Array.isArray(record.Data)) throw protocolError();
  let recovered: TokenPlanPaymentResult | null = null;
  for (const entry of record.Data) {
    if (!isRecord(entry)) continue;
    let candidateId: string;
    try {
      candidateId = orderId(entry.OrderId ?? entry.orderId);
    } catch {
      continue;
    }
    if (candidateId !== requestedId) continue;
    const status = aliases(entry, ['OrderStatus', 'Status'], text)?.toUpperCase();
    const candidate =
      status === 'CANCELED' || status === 'CANCELLED'
        ? ({ orderId: requestedId, status: 'cancelled', reason: 'order_cancelled' } as const)
        : null;
    if (!candidate) return null;
    if (recovered) throw protocolError();
    recovered = candidate;
  }
  return recovered;
}

function parseMergePay(value: unknown, requestedId: string): TokenPlanMergePayResult {
  const record = responseRecord(value);
  const data = unwrapBssData(record);
  checkResponseOrderId(data, requestedId);
  const status = aliases(data, ['payStatus', 'PayStatus'], (entry) => text(entry).toUpperCase());
  const url = aliases(data, ['authUrl', 'AuthUrl', 'PayUrl', 'payUrl'], (entry) => {
    if (typeof entry !== 'string') throw protocolError();
    if (entry !== '') validatePaymentUrl(entry, PAYMENT_URL_HOSTS);
    return entry;
  });
  const failure = aliases(data, ['PayFailedErrorCode', 'payFailedErrorCode'], optionalFailureText);
  aliases(data, ['PayFailedMessage', 'payFailedMessage'], optionalFailureText);
  if (failure && status === 'PAY_DONE')
    return { status: 'unknown', url: null, reason: 'protocol_error' };
  if (
    status === 'PAY_FAILED' ||
    status === 'PAY_FAIL' ||
    (failure && CONFIRMED_PAYMENT_REJECTION_CODES.has(failure))
  )
    return { status: 'failed', url: null, reason: 'payment_failed' };
  if (failure) return { status: 'unknown', url: null, reason: 'payment_unconfirmed' };
  if (status === 'PAY_DONE') return { status: 'succeeded', url: null };
  // A validated cashier URL without PayStatus indicates that external payment is pending.
  if (status === 'PAY_NONE' || (status === undefined && url))
    return { status: 'pending', url: url || null };
  return { status: 'unknown', url: null, reason: 'protocol_error' };
}

export class TokenPlanPaymentService {
  constructor(private readonly apiClient: ApiClient) {}

  async createOrders(
    configurations: ReadonlyArray<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TokenPlanCreatedOrders> {
    checkCn();
    const snapshot = configurationSnapshot(configurations);
    if (signal?.aborted)
      throw new CliError({
        code: 'INTERRUPTED',
        message: 'Order creation was cancelled before sending.',
        exitCode: 130,
      });
    try {
      return await withSignal(
        () =>
          this.apiClient.callOrchestrationApi({
            action: snapshot.team ? API_ACTION_CREATE_MULTI_ORDER : API_ACTION_CREATE_ORDER,
            path: API_ORCHESTRATION_PATH,
            authMode: 'required',
            params: snapshot.team
              ? { configurations: snapshot.configurations }
              : { configuration: snapshot.configurations[0] },
            signal,
            parse: (value) => parseCreatedOrders(value, snapshot.team),
          }),
        signal,
      );
    } catch (error) {
      if (isRealNameRequired(error))
        throw new CliError({
          code: 'TOKENPLAN_REAL_NAME_REQUIRED',
          message: `Real-name authentication is required. Complete it at: ${TOKEN_PLAN_ACCOUNT_SETTINGS_URL}`,
          exitCode: 1,
        });
      const failure = requestFailure(error);
      if (failure.rejected)
        throw new CliError({
          code: 'TOKENPLAN_ORDER_REJECTED',
          message:
            error instanceof GatewayBusinessError &&
            error.code === 'ORDER:ORDER.INST_HAS_UNPAID_ORDER'
              ? 'An unpaid order prevents this purchase. Check subscription orders before trying again.'
              : 'The service rejected this Token Plan order.',
          exitCode: 1,
        });
      throw new CliError({
        code: 'CREATE_UNKNOWN',
        message:
          'Order creation could not be confirmed. Do not create another order; check subscription orders and Token Plan status.',
        exitCode: signal?.aborted ? 130 : 8,
      });
    }
  }

  async mergePay(input: TokenPlanMergePayInput): Promise<TokenPlanMergePayResult> {
    checkCn();
    const paymentOrderId = orderId(input.paymentOrderId);
    let amount: DecimalAmount;
    let deduction: DecimalAmount;
    try {
      amount = DecimalAmount.parse(input.amount);
      deduction = DecimalAmount.parse(input.balanceDeduction);
      const zero = DecimalAmount.parse('0');
      if (amount.compare(zero) < 0 || deduction.compare(zero) < 0 || deduction.compare(amount) > 0)
        throw invalidArgError('Invalid payment amounts.');
      if (deduction.compare(deduction.roundToCents()) !== 0)
        throw invalidArgError('Cash deduction must be an exact cent amount.');
    } catch {
      throw invalidArgError(
        'Payment amounts must be non-negative decimal strings with deduction no greater than the CNY total.',
      );
    }
    const external = amount.subtract(deduction).roundToCents();
    const zero = DecimalAmount.parse('0');
    if (input.channel !== undefined && input.channel !== DEFAULT_CHANNEL)
      throw invalidArgError(`Unknown payment channel: ${input.channel}`);
    const channel = PAYMENT_CHANNELS[DEFAULT_CHANNEL];
    const params = {
      fromApp: 'maas-payment',
      language: 'zh',
      ...(deduction.compare(zero) > 0 ? { cashMoney: deduction.toCanonicalString() } : {}),
      payOrders: [{ orderId: paymentOrderId, autoUseCoupon: false }],
      ...(external.compare(zero) > 0
        ? {
            fundChargeDTO: {
              amount: external.toCanonicalString(),
              paymentType: channel.paymentType,
              chargeType: channel.chargeType,
              chargeTarget: channel.chargeTarget,
              chargeTargetNo: channel.chargeTargetNo,
              extendInfo: channel.extendInfo,
              riskParams: {},
            },
          }
        : {}),
    };
    if (input.signal?.aborted) return { status: 'unknown', url: null, reason: 'interrupted' };
    let requestStarted = false;
    let responseReceived = false;
    try {
      const result = await withSignal(
        () =>
          this.apiClient.callFlatApi<unknown>({
            product: API_PRODUCT_BSS_PAYMENT,
            action: API_ACTION_MERGE_PAY,
            version: API_VERSION_MERGE_PAY,
            params: { ParamStr: JSON.stringify(params) },
            signal: input.signal,
            onRequestStart: () => {
              input.onRequestStart?.();
              requestStarted = true;
            },
          }),
        input.signal,
      );
      responseReceived = true;
      return parseMergePay(result, paymentOrderId);
    } catch (error) {
      const failure = requestFailure(error);
      if (!requestStarted && !responseReceived) throw failure.error;
      return {
        status: failure.rejected ? 'failed' : 'unknown',
        url: null,
        reason: input.signal?.aborted
          ? 'interrupted'
          : failure.rejected
            ? 'payment_rejected'
            : 'payment_unconfirmed',
      };
    }
  }

  async getOrderSettlement(
    paymentOrderId: string,
    signal?: AbortSignal,
    expectedOrderIds: readonly string[] = [paymentOrderId],
  ): Promise<TokenPlanSettlementInfo> {
    checkCn();
    const normalizedId = orderId(paymentOrderId);
    const numericId = numericOrderId(normalizedId);
    let result: unknown;
    try {
      result = await withSignal(
        () =>
          this.apiClient.callFlatApi<unknown>({
            product: API_PRODUCT_BSS,
            action: API_ACTION_QUERY_ORDER_DETAIL,
            params: { OrderId: numericId, Language: 'zh' },
            signal,
          }),
        signal,
      );
    } catch (error) {
      throw requestFailure(error).error;
    }
    return parseOrderSettlement(result, normalizedId, expectedOrderIds);
  }

  async getPaymentResult(
    requestedId: string,
    signal?: AbortSignal,
  ): Promise<TokenPlanPaymentResult> {
    checkCn();
    const normalizedId = orderId(requestedId);
    const numericId = numericOrderId(normalizedId);
    if (signal?.aborted) return { orderId: normalizedId, status: 'unknown', reason: 'interrupted' };
    try {
      const result = await withSignal(
        () =>
          this.apiClient.callFlatApi<unknown>({
            product: API_PRODUCT_BSS,
            action: API_ACTION_QUERY_PAY_RESULT,
            params: { OrderId: numericId, Language: 'zh' },
            signal,
          }),
        signal,
      );
      const paymentResult = parsePaymentResult(result, normalizedId);
      if (paymentResult.status !== 'unknown') return paymentResult;
      return (await this.recoverPaymentResultFromOrders(normalizedId)) ?? paymentResult;
    } catch (error) {
      if (signal?.aborted)
        return { orderId: normalizedId, status: 'unknown', reason: 'interrupted' };
      const failure = requestFailure(error);
      if (failure.error.exitCode === 4)
        return { orderId: normalizedId, status: 'unknown', reason: 'protocol_error' };
      throw failure.error;
    }
  }

  /**
   * Perform one best-effort order-list lookup after payment polling can no longer
   * provide a trustworthy terminal state. The lookup is intentionally detached
   * from the interrupted payment signal so a user cancellation can still be
   * confirmed without retrying CreateOrder or MergePay.
   */
  async recoverPaymentResultFromOrders(
    requestedId: string,
  ): Promise<TokenPlanPaymentResult | null> {
    checkCn();
    const normalizedId = orderId(requestedId);
    numericOrderId(normalizedId);
    try {
      return await withTokenPlanDeadline(async (signal) => {
        let nbid: string | undefined;
        try {
          const identity = await this.apiClient.callFlatApi<Record<string, unknown>>({
            product: API_PRODUCT_ACCOUNT_CENTER,
            action: 'QueryAccountBaseInfoApi',
            params: {},
            signal,
          });
          const data = isRecord(identity.Data) ? identity.Data : identity;
          const value = data.NbId;
          if (typeof value === 'string' || typeof value === 'number') nbid = String(value);
        } catch {
          // Match `subscription orders`: an unavailable identity lookup does not
          // prevent the order API from attempting its own authenticated lookup.
        }
        const response = await this.apiClient.callFlatApi<unknown>({
          product: API_PRODUCT_BSS,
          action: 'QueryOrderList',
          params: {
            CurrentPage: 1,
            PageSize: ORDER_RECOVERY_PAGE_SIZE,
            OrderType: 'BUY',
            ...(nbid ? { Nbid: nbid } : {}),
          },
          signal,
        });
        return parseRecoveredOrderResult(response, normalizedId);
      });
    } catch {
      return null;
    }
  }

  async waitForPaymentResult(
    requestedId: string,
    options: TokenPlanPaymentWaitOptions = {},
  ): Promise<TokenPlanPaymentResult> {
    checkCn();
    const normalizedId = orderId(requestedId);
    numericOrderId(normalizedId);
    const now = Date.now();
    if (options.deadlineAt !== undefined && !Number.isSafeInteger(options.deadlineAt))
      throw invalidArgError('Payment deadline must be an epoch-millisecond safe integer.');
    const deadlineAt = Math.min(
      options.deadlineAt ?? now + PAYMENT_POLL_TIMEOUT_MS,
      now + PAYMENT_POLL_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const stopped = async (): Promise<TokenPlanPaymentResult> => {
      if (options.signal?.aborted) {
        return (
          (await this.recoverPaymentResultFromOrders(normalizedId)) ?? {
            orderId: normalizedId,
            status: 'unknown',
            reason: 'interrupted',
          }
        );
      }
      return { orderId: normalizedId, status: 'timed_out', reason: 'payment_wait_expired' };
    };
    if (options.signal?.aborted || deadlineAt <= now) return await stopped();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, deadlineAt - now);
    try {
      for (;;) {
        if (controller.signal.aborted || Date.now() >= deadlineAt) return await stopped();
        try {
          const result = await this.getPaymentResult(normalizedId, controller.signal);
          if (
            result.status === 'succeeded' ||
            result.status === 'failed' ||
            result.status === 'cancelled'
          )
            return result;
          if (controller.signal.aborted || Date.now() >= deadlineAt) return await stopped();
          if (result.status !== 'pending') return result;
        } catch (error) {
          if (controller.signal.aborted || Date.now() >= deadlineAt) return await stopped();
          const failure = requestFailure(error);
          if (!failure.transient) throw failure.error;
        }
        if (Date.now() < deadlineAt) await sleep(controller.signal);
      }
      return await stopped();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
}
