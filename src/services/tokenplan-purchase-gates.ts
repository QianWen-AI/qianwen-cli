import type { ApiClient, CallFlatApiOptions } from '../api/api-client.js';
import { site } from '../site.js';
import {
  API_ACTION_GET_BILLING_ACCOUNT_AVAILABLE_AMOUNT,
  API_ACTION_GET_USER_PAYMENT_METHOD,
} from '../types/api-routes.js';
import type { CashPaymentCapabilities } from '../types/tokenplan-payment.js';
import type { TokenPlanEdition } from '../types/tokenplan-subscription.js';
import { classifyHttpError } from '../utils/api-errors.js';
import { DecimalAmount } from '../utils/decimal-amount.js';
import { CliError } from '../utils/errors.js';
import { buildCapabilities, parsePaymentMethods } from './tokenplan-payment-capabilities.js';
import { TOKEN_PLAN_PRICING_URL, TOKEN_PLAN_UNPAID_ORDER_URL } from './tokenplan-urls.js';

const BSS_PRODUCT = 'BssOpenAPI-V3';
const SOLO_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription';
const TIMEOUT_MS = 30_000;
const TOKEN_PLAN_SUBSCRIPTION_URLS: Record<TokenPlanEdition, string> = {
  individual: 'https://platform.qianwenai.com/home/analytics/token-plan/individual',
  team: 'https://platform.qianwenai.com/home/analytics/token-plan/team',
};

export interface TokenPlanPurchaseAvailability {
  available: boolean | null;
  reason?: string;
}

interface GateResult extends TokenPlanPurchaseAvailability {
  instances?: Set<string>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/\s/u.test(value) &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function signedAmountSign(value: unknown): -1 | 0 | 1 | null {
  try {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
      const magnitude = DecimalAmount.fromApi(Math.abs(value));
      if (magnitude.compare(DecimalAmount.parse('0')) === 0) return 0;
      return value < 0 ? -1 : 1;
    }
    if (typeof value !== 'string' || value.length > 100 || value.trim() !== value) return null;
    const negative = value.startsWith('-');
    const magnitude = DecimalAmount.parse(negative ? value.slice(1) : value);
    if (magnitude.compare(DecimalAmount.parse('0')) === 0) return 0;
    return negative ? -1 : 1;
  } catch {
    return null;
  }
}

function successful(value: Record<string, unknown>): boolean {
  return (
    (!Object.hasOwn(value, 'Success') || value.Success === true) &&
    (!Object.hasOwn(value, 'Code') || value.Code === 'Success' || value.Code === '200')
  );
}

function unknown(reason = 'TOKENPLAN_SUBSCRIPTION_UNKNOWN'): GateResult {
  return { available: null, reason };
}

function active(): GateResult {
  return { available: false, reason: 'TOKENPLAN_ACTIVE_SUBSCRIPTION' };
}

function cancelled(signal?: AbortSignal): CliError {
  const reason: unknown = signal?.reason;
  if (
    (reason instanceof Error && reason.name === 'TimeoutError') ||
    (reason instanceof CliError && reason.exitCode === 3)
  ) {
    return new CliError({
      code: 'NETWORK_ERROR',
      message: 'Token Plan check timed out.',
      exitCode: 3,
    });
  }
  return new CliError({
    code: 'TOKENPLAN_CHECK_CANCELLED',
    message: 'Token Plan check cancelled.',
    exitCode: 130,
  });
}

function stopped(signal: AbortSignal): CliError {
  return signal.reason instanceof CliError ? signal.reason : cancelled();
}

function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) throw stopped(signal);
}

function safeError(error: unknown): CliError {
  const classified = classifyHttpError(error);
  if (classified.exitCode === 2) {
    return new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Token Plan authentication failed. Run: qianwen auth login',
      exitCode: 2,
    });
  }
  if (classified.exitCode === 3) {
    return new CliError({
      code: 'NETWORK_ERROR',
      message: 'Token Plan check failed or timed out. Retry the read-only check.',
      exitCode: 3,
    });
  }
  if (classified.exitCode === 4) {
    return new CliError({
      code: 'CONFIG_ERROR',
      message: 'Token Plan check configuration is unavailable.',
      exitCode: 4,
    });
  }
  return new CliError({
    code: 'TOKENPLAN_CHECK_UNKNOWN',
    message: 'Token Plan account state could not be verified.',
    exitCode: 4,
  });
}

async function bounded<T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
  assertRunning(signal);
  let onAbort = () => {};
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => reject(stopped(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        assertRunning(signal);
        return invoke();
      }),
      interruption,
    ]);
    assertRunning(signal);
    return value;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function request<T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
  try {
    return await bounded(signal, invoke);
  } catch (error) {
    if (signal.aborted) throw stopped(signal);
    throw safeError(error);
  }
}

function parseIndividual(business: unknown): GateResult {
  const envelope = object(business);
  if (!envelope || envelope.success !== true || envelope.code !== 'SUCCESS') {
    return { available: true };
  }
  return object(envelope.data)?.status === 'VALID' ? active() : { available: true };
}

export class TokenPlanPurchaseGates {
  private identityPromise?: Promise<{ site: string | null; nbid: string | null }>;

  constructor(private readonly apiClient: ApiClient) {}

  async checkAccount(edition: TokenPlanEdition, signal?: AbortSignal): Promise<void> {
    const result = await this.getAvailability(edition, signal);
    if (result.available === true) return;
    const messages: Record<string, string> = {
      TOKENPLAN_ACTIVE_SUBSCRIPTION: `An active Token Plan subscription already exists for this edition. View subscription: ${TOKEN_PLAN_SUBSCRIPTION_URLS[edition]}`,
      TOKENPLAN_UNPAID_ORDER: `An unpaid Token Plan order already exists for this plan type.\nTo complete the payment, cancel the order, or view its details, visit:\n${TOKEN_PLAN_UNPAID_ORDER_URL}`,
      TOKENPLAN_NOT_ELIGIBLE: 'This account is not eligible to purchase this Token Plan edition.',
      TOKENPLAN_ACCOUNT_IN_ARREARS:
        "Your account balance is below 0. Run 'qianwen billing balance recharge' to recharge before purchasing a Token Plan.",
    };
    throw new CliError({
      code: result.reason ?? 'TOKENPLAN_CHECK_UNKNOWN',
      message:
        messages[result.reason ?? ''] ??
        'Token Plan account state is unknown; purchase is blocked.',
      exitCode: result.available === false ? 1 : 4,
    });
  }

  async getAvailability(
    edition: TokenPlanEdition,
    signal?: AbortSignal,
  ): Promise<TokenPlanPurchaseAvailability> {
    return this.withDeadline(signal, async (sharedSignal) => {
      if (edition !== 'individual' && edition !== 'team') {
        throw new CliError({
          code: 'TOKENPLAN_EDITION_INVALID',
          message: 'Unknown Token Plan edition.',
          exitCode: 4,
        });
      }
      const commodity =
        edition === 'individual'
          ? site.features.tokenPlanCommodityCodes.soloBuy
          : site.features.tokenPlanCommodityCodes.teams;
      const checks = [
        this.billingAccountBalance(sharedSignal),
        edition === 'individual' ? this.individual(sharedSignal) : this.discovery(sharedSignal),
        this.orders(commodity, sharedSignal),
        this.eligibility(commodity, sharedSignal),
      ];
      const blocked = new Promise<GateResult>((resolve) => {
        for (const check of checks) {
          void check.then(
            (result) => {
              if (result.available === false) resolve(result);
            },
            () => {},
          );
        }
      });
      const complete = Promise.allSettled(checks).then((results): TokenPlanPurchaseAvailability => {
        const values = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        const denied = values.find((result) => result.available === false);
        if (denied) return { available: false, reason: denied.reason };
        const failures = results.flatMap((result) =>
          result.status === 'rejected'
            ? [result.reason instanceof CliError ? result.reason : safeError(result.reason)]
            : [],
        );
        for (const exitCode of [2, 3, 4]) {
          const failure = failures.find(
            (error) => error.exitCode === exitCode && error.code !== 'TOKENPLAN_CHECK_UNKNOWN',
          );
          if (failure) throw failure;
        }
        if (failures.length) return unknown('TOKENPLAN_CHECK_UNKNOWN');
        const unconfirmed = values.find((result) => result.available === null);
        if (unconfirmed) return { available: null, reason: unconfirmed.reason };
        return { available: true };
      });
      return bounded(sharedSignal, () => Promise.race([blocked, complete]));
    });
  }

  async getPaymentCapabilities(
    edition: TokenPlanEdition,
    signal?: AbortSignal,
  ): Promise<CashPaymentCapabilities> {
    return this.withDeadline(signal, async (sharedSignal) => {
      const identity = await this.loadIdentity(sharedSignal);
      if (!identity.site || !identity.nbid) {
        throw new CliError({
          code: 'TOKENPLAN_PAYMENT_CAPABILITY_UNKNOWN',
          message: 'Could not determine payment capabilities. Try again later.',
          exitCode: 4,
        });
      }
      const skuCodeList =
        edition === 'individual'
          ? [site.features.tokenPlanCommodityCodes.soloBuy]
          : [site.features.tokenPlanCommodityCodes.teams];
      const raw = await this.flat(
        {
          product: BSS_PRODUCT,
          action: API_ACTION_GET_USER_PAYMENT_METHOD,
          params: {
            TradeScene: 'ORDER_PAY',
            PlatformType: 'PC',
            GetPayerPaymentMethod: 'true',
            Status: 'VALID',
            Site: identity.site,
            Nbid: identity.nbid,
            SkuCodeList: JSON.stringify(skuCodeList),
          },
        },
        sharedSignal,
      );
      const capabilities = buildCapabilities(
        { site: identity.site, nbid: identity.nbid },
        parsePaymentMethods(raw),
      );
      if (capabilities.admissionResult === 'unsupported') {
        throw new CliError({
          code: 'TOKENPLAN_CREDIT_NOT_SUPPORTED',
          message: `Your account uses credit-based payment, which the CLI does not support. Purchase at: ${TOKEN_PLAN_PRICING_URL}`,
          exitCode: 1,
        });
      }
      if (capabilities.admissionResult === 'unknown') {
        throw new CliError({
          code: 'TOKENPLAN_PAYMENT_CAPABILITY_UNKNOWN',
          message: 'Could not determine payment capabilities. Try again later.',
          exitCode: 4,
        });
      }
      return capabilities;
    });
  }

  private async loadIdentity(
    signal: AbortSignal,
  ): Promise<{ site: string | null; nbid: string | null }> {
    if (!this.identityPromise) {
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            new CliError({
              code: 'NETWORK_ERROR',
              message: 'Token Plan identity lookup exceeded its 30-second deadline.',
              exitCode: 3,
            }),
          ),
        TIMEOUT_MS,
      );
      const request = (async () => {
        try {
          const human = object(
            await this.flat(
              { product: 'ea-service', action: 'LoadHumanInfo', params: {} },
              controller.signal,
            ),
          );
          if (!human || !successful(human)) return { site: null, nbid: null };
          const seller = object(object(human.Data)?.SellerInfoDto);
          const nbid = seller?.Nbid;
          const siteValue = seller?.Site;
          return {
            site: identifier(siteValue) ? siteValue : null,
            nbid: identifier(nbid) ? nbid : null,
          };
        } finally {
          clearTimeout(timer);
        }
      })();
      this.identityPromise = request;
      void request.catch(() => {
        if (this.identityPromise === request) this.identityPromise = undefined;
      });
    }
    return bounded(signal, () => this.identityPromise!);
  }

  private async withDeadline<T>(
    signal: AbortSignal | undefined,
    invoke: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw cancelled(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort(cancelled(signal));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new CliError({
            code: 'NETWORK_ERROR',
            message: 'Token Plan check exceeded its 30-second deadline.',
            exitCode: 3,
          }),
        ),
      TIMEOUT_MS,
    );
    try {
      return await invoke(controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort(cancelled());
    }
  }

  private flat(options: CallFlatApiOptions, signal: AbortSignal): Promise<unknown> {
    return request(signal, () => this.apiClient.callFlatApi<unknown>({ ...options, signal }));
  }

  private async individual(signal: AbortSignal): Promise<GateResult> {
    try {
      return await request(signal, () =>
        this.apiClient.callCsDataApi({
          api: SOLO_API,
          data: { commodityCode: site.features.tokenPlanCommodityCodes.soloBuy },
          signal,
          parse: parseIndividual,
        }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return { available: true };
    }
  }

  private async eligibility(commodity: string, signal: AbortSignal): Promise<GateResult> {
    const raw = object(
      await this.flat(
        {
          product: BSS_PRODUCT,
          action: 'QuerySubscriptionGray',
          params: { Group: 'tokenPlan', CommodityCode: commodity },
        },
        signal,
      ),
    );
    if (!raw || !successful(raw) || typeof raw.IsGray !== 'boolean')
      return unknown('TOKENPLAN_ELIGIBILITY_UNKNOWN');
    return raw.IsGray
      ? { available: true }
      : { available: false, reason: 'TOKENPLAN_NOT_ELIGIBLE' };
  }

  private async billingAccountBalance(signal: AbortSignal): Promise<GateResult> {
    const raw = object(
      await this.flat(
        {
          product: BSS_PRODUCT,
          action: API_ACTION_GET_BILLING_ACCOUNT_AVAILABLE_AMOUNT,
          params: {},
        },
        signal,
      ),
    );
    if (!raw || !successful(raw)) return unknown('TOKENPLAN_ACCOUNT_BALANCE_UNKNOWN');
    const sign = signedAmountSign(raw.AvailableAmount);
    if (sign === null) return unknown('TOKENPLAN_ACCOUNT_BALANCE_UNKNOWN');
    return sign < 0
      ? { available: false, reason: 'TOKENPLAN_ACCOUNT_IN_ARREARS' }
      : { available: true };
  }

  private async orders(commodity: string, signal: AbortSignal): Promise<GateResult> {
    const identity = await this.loadIdentity(signal);
    if (!identity.nbid) return unknown('TOKENPLAN_IDENTITY_UNKNOWN');
    const raw = object(
      await this.flat(
        {
          product: BSS_PRODUCT,
          action: 'QueryOrderList',
          params: {
            CurrentPage: 1,
            PageSize: 1,
            CommodityCodeList: commodity,
            Nbid: identity.nbid,
            OrderStatus: 'UNPAID',
          },
        },
        signal,
      ),
    );
    if (
      !raw ||
      !successful(raw) ||
      !Array.isArray(raw.Data) ||
      !integer(raw.TotalCount) ||
      (Object.hasOwn(raw, 'CurrentPage') && raw.CurrentPage !== 1) ||
      (Object.hasOwn(raw, 'PageSize') && raw.PageSize !== 1) ||
      raw.Data.length !== Math.min(raw.TotalCount, 1)
    )
      return unknown('TOKENPLAN_ORDERS_UNKNOWN');
    if (raw.TotalCount === 0) return { available: true };
    const item = object(raw.Data[0]);
    if (!item || item.CommodityCode !== commodity || item.OrderStatus !== 'UNPAID')
      return unknown('TOKENPLAN_ORDERS_UNKNOWN');
    return { available: false, reason: 'TOKENPLAN_UNPAID_ORDER' };
  }

  private async discovery(signal: AbortSignal): Promise<GateResult> {
    const commodity = site.features.tokenPlanCommodityCodes.teams;
    let response: unknown;
    try {
      response = await this.flat(
        {
          product: BSS_PRODUCT,
          action: 'GetUserInstanceSummary',
          version: '2023-09-30',
          params: { ProductCode: commodity },
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return { available: true };
    }
    const raw = object(response);
    if (!Array.isArray(response) && (!raw || !successful(raw))) return { available: true };
    const rows = Array.isArray(response)
      ? response
      : Array.isArray(raw?.Data)
        ? raw.Data
        : Array.isArray(raw?.data)
          ? raw.data
          : Array.isArray(raw?.InstanceList)
            ? raw.InstanceList
            : [];
    for (const value of rows) {
      const item = object(value);
      if (
        item?.ProductCode === commodity &&
        Array.isArray(item.InstanceCodeList) &&
        item.InstanceCodeList.length > 0
      )
        return active();
    }
    return { available: true };
  }
}
