/** Pay-as-you-go orchestration and billing-rule utilities. */

import type { ApiClient, CallFlatApiOptions } from '../api/api-client.js';
import { isResponseParseError } from '../api/base-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type {
  ConsumeSummaryLineItem,
  DescribeUsageLimitResponse,
  MaasDescribeCostAnalysisResponse,
  ListSettleBillTotalSummaryResponse,
} from '../types/api-models.js';
import type {
  PayAsYouGo,
  UsageBreakdownResponse,
  UsageBreakdownRow,
  UsageBreakdownTotal,
} from '../types/usage.js';
import type {
  UsageLimit,
  ConsumeBreakdown,
  ConsumeBreakdownByPeriods,
  ConsumeBreakdownDto,
  ConsumeBreakdownOptions,
  ConsumeBreakdownPeriodSlice,
  ConsumeBreakdownRow,
  SettleBillCycle,
  SettleBillSummary,
  SettleBillSummaryDto,
  SettleBillSummaryOptions,
  SettleBillTotals,
} from '../types/billing-extra.js';
import type { GetFundAccountAvailableAmountResponse, BalanceSummaryDto } from '../types/balance.js';
import {
  transformUsageLimit,
  transformConsumeBreakdown,
  transformSettleBillSummary,
  transformBalanceSummary,
} from '../api/adapters/billing-adapter.js';
import {
  aggregatePaygByModel,
  aggregatePaygByDate,
  aggregateMonthly,
  aggregateQuarterly,
  fillDailyGaps,
  mergePaygModelData,
  type PaygItem,
  type PaygDailyRow,
  type AggregatedRow,
} from '../utils/payg-aggregator.js';
import { site } from '../site.js';
import {
  parseRechargeAmount,
  sumAmountStrings,
  subtractAmountStrings,
  toDecimalString,
} from '../utils/amount.js';
import { formatAsiaShanghaiDate, normalizeToFullDate } from '../utils/date.js';
import { PAYMENT_URL_HOSTS, redactPaymentData, validatePaymentUrl } from '../utils/strings.js';
import { classifyRechargeStatus } from '../utils/recharge-status.js';
import { addDiagnostic as writeDiagnostic } from '../api/debug-buffer.js';
import type {
  RechargeCreateOutput,
  RechargeHistoryOutput,
  RechargeResultOutput,
} from '../types/recharge.js';

// Re-export: historical import site for the amount summation helper (now
// shared from utils so the aggregators can use it without a services dep).
export { sumAmountStrings } from '../utils/amount.js';

const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_ACTION_CONSUME_SUMMARY = 'MaasListConsumeSummary';
const BREAKDOWN_CACHE_TTL_MS = 30 * 1000;
const RECHARGE_POLL_INTERVAL_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Default client deadline shared by identity loading and result polling.
export const RECHARGE_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Recharge API boundary whose failure can be mapped to safe CLI copy. */
export type RechargeApiFailureStage =
  | 'load-human-info'
  | 'billing-account-status'
  | 'recharge-url'
  | 'result-query'
  | 'fund-flow'
  | 'available-amount';

const rechargeApiFailureStages = new WeakMap<Error, RechargeApiFailureStage>();

/**
 * Associate a raw API or response-validation error with its recharge stage.
 *
 * The original error remains unchanged so transport classification, retry
 * behavior, and HTTP diagnostics continue to observe the original failure.
 *
 * @param error Original failure raised at the API boundary.
 * @param stage Recharge operation being performed.
 * @returns The original value for direct rethrowing.
 */
function markRechargeApiFailure(error: unknown, stage: RechargeApiFailureStage): unknown {
  if (error instanceof Error) rechargeApiFailureStages.set(error, stage);
  return error;
}

/**
 * Find recharge API context on an error or one of its domain wrappers.
 *
 * @param error Error chain to inspect.
 * @returns The originating recharge stage when one was recorded.
 */
export function findRechargeApiFailureStage(error: unknown): RechargeApiFailureStage | undefined {
  let current: unknown = error;
  let depth = 0;
  while (current instanceof Error && depth < 6) {
    const stage = rechargeApiFailureStages.get(current);
    if (stage) return stage;
    current = current.cause;
    depth += 1;
  }
  return undefined;
}

interface RechargePollOptions {
  rechargeOrderId: string;
  nbid: string;
  query(options: {
    rechargeOrderId: string;
    signal: AbortSignal;
  }): Promise<{ RechargeStatus: string }>;
  signal?: AbortSignal;
  deadlineAt: number;
}

interface RechargeResultFlowOptions {
  rechargeOrderId: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  loadNbid(signal: AbortSignal): Promise<string>;
  query(options: {
    nbid: string;
    rechargeOrderId: string;
    signal: AbortSignal;
  }): Promise<{ RechargeStatus: string }>;
}

/** Marks a structurally invalid result response that must never be retried. */
class RechargeResultProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RechargeResultProtocolError';
  }
}

/** Marks a dispatched create request whose outcome cannot be established safely. */
export class RechargeCreateUnknownError extends Error {
  readonly code = 'CREATE_UNKNOWN';

  /**
   * Create an uncertainty marker while retaining the original failure as cause.
   *
   * @param cause Failure observed after dispatching the create request.
   */
  constructor(cause: unknown) {
    super(
      'Recharge order creation may have succeeded, but its result could not be confirmed. Check recharge history and available balance before creating another order.',
      { cause },
    );
    this.name = 'RechargeCreateUnknownError';
  }
}

/** Marks the generic gateway response returned for an unavailable recharge order. */
export class RechargeOrderNotFoundError extends Error {
  readonly code = 'NOT_FOUND';

  /**
   * Convert the action-specific upstream failure into a useful user message.
   *
   * @param cause Generic gateway error returned by GetRechargeResult.
   */
  constructor(cause: unknown) {
    super(
      "Recharge order not found or unavailable for this account. Check the order ID or run 'qianwen billing balance recharge-history'.",
      { cause },
    );
    this.name = 'RechargeOrderNotFoundError';
  }
}

/** Detect the generic response used by GetRechargeResult for a missing order. */
function isRechargeOrderNotFoundResponse(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'GatewayEnvelopeError' &&
    /^The request processing has failed due to some unknown error\.?$/iu.test(error.message.trim())
  );
}

/** Whether an HTTP-like status is transient for recharge operations. */
function isTransientRechargeStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Recognize transient gateway-envelope failures without relying on message text
 * when the gateway already supplied a numeric status code.
 *
 * @param error Error returned by the gateway response unwrapping boundary.
 * @returns Whether retry/transport classification should treat it as transient.
 */
export function isTransientRechargeGatewayFailure(error: Error): boolean {
  if (error.name !== 'GatewayEnvelopeError') return false;
  const rawCode = Reflect.get(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode : '';
  const numericCode = /^\d{3}$/u.test(code) ? Number(code) : undefined;
  return (
    (numericCode !== undefined && isTransientRechargeStatus(numericCode)) ||
    /(?:thrott|rate.?limit|timeout|tempor|unavailable)/iu.test(`${code} ${error.message}`)
  );
}

/** Determine whether a failed create call may already have reached the server. */
function isUncertainRechargeCreateFailure(error: unknown): boolean {
  if (isResponseParseError(error)) return true;
  if (!(error instanceof Error)) return true;
  if (error instanceof SyntaxError) return true;
  if (error.name === 'RequestTimeoutError') return true;
  if (error.name === 'GatewayShapeError') return true;

  const httpStatus = error.message.match(/\bHTTP\s+(\d{3})\b/iu)?.[1];
  if (httpStatus) {
    return isTransientRechargeStatus(Number(httpStatus));
  }
  if (error.name === 'GatewayEnvelopeError') {
    const rawCode = Reflect.get(error, 'code');
    const code = typeof rawCode === 'string' ? rawCode : '';
    if (!code) return true;
    return isTransientRechargeGatewayFailure(error);
  }
  return (
    /(?:network|timeout|timed out|fetch failed|econn|enotfound|socket|temporarily unavailable)/iu.test(
      error.message,
    ) || error instanceof TypeError
  );
}

/**
 * Poll an existing recharge order until it succeeds, is interrupted, or reaches
 * the configured client deadline. The deadline owns the in-flight request
 * signal, so a slow request cannot extend the overall command duration.
 *
 * @param options Query callback, caller signal, and absolute deadline.
 * @returns A normalized terminal result; this function never creates an order.
 */
async function pollRechargeResult(options: RechargePollOptions): Promise<RechargeResultOutput> {
  const deadline = options.deadlineAt;
  const controller = new AbortController();
  let deadlineReached = false;
  let interrupted = options.signal?.aborted === true;

  const onExternalAbort = () => {
    interrupted = true;
    controller.abort(options.signal?.reason ?? new DOMException('Interrupted', 'AbortError'));
  };
  if (options.signal) options.signal.addEventListener('abort', onExternalAbort, { once: true });
  if (interrupted) onExternalAbort();

  const cancelDeadlineTimer = scheduleRechargeDeadline(deadline, () => {
    deadlineReached = true;
    controller.abort(new DOMException('Recharge polling deadline reached', 'AbortError'));
  });

  try {
    while (true) {
      if (interrupted) return localRechargeResult(options.rechargeOrderId, 'interrupted');
      if (deadlineReached || Date.now() >= deadline) {
        return localRechargeResult(options.rechargeOrderId, 'timed_out');
      }

      try {
        const response = await options.query({
          rechargeOrderId: options.rechargeOrderId,
          signal: controller.signal,
        });
        // Re-check both fences after awaiting the transport. A misbehaving query
        // may ignore AbortSignal and resolve after SIGINT/deadline; it must not
        // turn that already-terminal local state into a false success.
        if (interrupted) {
          return localRechargeResult(options.rechargeOrderId, 'interrupted');
        }
        if (deadlineReached || Date.now() >= deadline) {
          return localRechargeResult(options.rechargeOrderId, 'timed_out');
        }
        const disposition = classifyRechargeStatus(response.RechargeStatus);
        if (disposition === 'success' || disposition === 'failure') {
          return rechargeResultFromResponse(options.rechargeOrderId, response);
        }
        if (disposition === 'unknown') {
          return rechargeResultFromResponse(options.rechargeOrderId, response);
        }
      } catch (error) {
        if (interrupted) return localRechargeResult(options.rechargeOrderId, 'interrupted');
        if (deadlineReached || Date.now() >= deadline) {
          return localRechargeResult(options.rechargeOrderId, 'timed_out');
        }
        if (!isRetryableRechargeResultError(error)) throw error;
        // Transient result-query failures are safe to retry because the action
        // is read-only. Sensitive fields are stripped by the diagnostic sink.
        const message = error instanceof Error ? error.message : String(error);
        const safeWarning = redactPaymentData({
          ChargeOrderId: options.rechargeOrderId,
          Nbid: options.nbid,
          message: `Payment result query will retry: ${message}`,
        }) as { message: string };
        const warning = safeWarning.message;
        writeDiagnostic('Recharge', warning, 'warn');
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return localRechargeResult(options.rechargeOrderId, 'timed_out');
      }
      try {
        await abortableRechargeSleep(
          Math.min(RECHARGE_POLL_INTERVAL_MS, remaining),
          controller.signal,
        );
      } catch {
        if (interrupted) return localRechargeResult(options.rechargeOrderId, 'interrupted');
        return localRechargeResult(options.rechargeOrderId, 'timed_out');
      }
    }
  } finally {
    cancelDeadlineTimer();
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}

/** Preserve an upstream status and annotate only values outside the known enum. */
function rechargeResultFromResponse(
  rechargeOrderId: string,
  response: { RechargeStatus: string },
): RechargeResultOutput {
  return {
    type: 'recharge',
    rechargeOrderId,
    ...response,
    ...(classifyRechargeStatus(response.RechargeStatus) === 'unknown'
      ? { reason: 'unrecognized_status' as const }
      : {}),
  };
}

/**
 * Load identity and poll within one fixed command deadline.
 *
 * The identity request owns the first-stage deadline signal. Once identity is
 * available, the poller receives the original absolute deadline so neither
 * stage can reset or extend the total duration.
 *
 * @param options Identity loader, result query, caller signal, and optional absolute deadline.
 * @returns A normalized terminal result for the existing order.
 */
async function resolveRechargeResult(
  options: RechargeResultFlowOptions,
): Promise<RechargeResultOutput> {
  const deadlineAt = options.deadlineAt ?? Date.now() + RECHARGE_POLL_TIMEOUT_MS;
  const identityController = new AbortController();
  let deadlineReached = false;
  let interrupted = options.signal?.aborted === true;

  const onExternalAbort = () => {
    interrupted = true;
    identityController.abort(
      options.signal?.reason ?? new DOMException('Interrupted', 'AbortError'),
    );
  };
  if (options.signal) options.signal.addEventListener('abort', onExternalAbort, { once: true });
  if (interrupted) onExternalAbort();

  const cancelDeadlineTimer = scheduleRechargeDeadline(deadlineAt, () => {
    if (identityController.signal.aborted) return;
    deadlineReached = true;
    identityController.abort(new DOMException('Recharge polling deadline reached', 'AbortError'));
  });

  let nbid: string;
  try {
    if (interrupted) return localRechargeResult(options.rechargeOrderId, 'interrupted');
    nbid = await options.loadNbid(identityController.signal);
    if (interrupted) return localRechargeResult(options.rechargeOrderId, 'interrupted');
    if (deadlineReached || Date.now() >= deadlineAt) {
      return localRechargeResult(options.rechargeOrderId, 'timed_out');
    }
  } catch (error) {
    if (interrupted) return localRechargeResult(options.rechargeOrderId, 'interrupted');
    if (deadlineReached || Date.now() >= deadlineAt) {
      return localRechargeResult(options.rechargeOrderId, 'timed_out');
    }
    throw error;
  } finally {
    cancelDeadlineTimer();
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }

  return pollRechargeResult({
    rechargeOrderId: options.rechargeOrderId,
    nbid,
    signal: options.signal,
    deadlineAt,
    query: ({ rechargeOrderId, signal }) => options.query({ nbid, rechargeOrderId, signal }),
  });
}

/** Build a synthetic status only when no terminal status came from the result API. */
function localRechargeResult(
  rechargeOrderId: string,
  reason: 'timed_out' | 'interrupted',
): RechargeResultOutput {
  return { type: 'recharge', rechargeOrderId, RechargeStatus: 'UNKNOWN', reason };
}

/**
 * Decide whether a result-query failure is safe to retry.
 *
 * Structural, authentication, and caller-input failures terminate immediately;
 * only transport failures, throttling, and temporary gateway/server failures are
 * retried within the fixed polling deadline.
 *
 * @param error Failure raised by the result-query boundary.
 * @returns Whether another read-only result request may be attempted.
 */
function isRetryableRechargeResultError(error: unknown): boolean {
  if (isResponseParseError(error)) return false;
  if (error instanceof RechargeResultProtocolError) return false;
  if (!(error instanceof Error)) return false;

  const message = error.message;
  const httpStatus = message.match(/\bHTTP\s+(\d{3})\b/iu)?.[1];
  if (httpStatus) {
    return isTransientRechargeStatus(Number(httpStatus));
  }
  if (error.name === 'GatewayShapeError') return false;
  if (error.name === 'GatewayEnvelopeError') return isTransientRechargeGatewayFailure(error);

  return /(?:network|timeout|timed out|fetch failed|econn|enotfound|socket|gateway unavailable|temporarily unavailable)/iu.test(
    message,
  );
}

/** Wait for a polling interval while remaining immediately abortable. */
function abortableRechargeSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Schedule an absolute deadline without overflowing Node's signed 32-bit timer delay.
 *
 * @param deadlineAt Absolute epoch-millisecond deadline.
 * @param onDeadline Callback invoked once the deadline is reached.
 * @returns A cancellation function that clears the active timer segment.
 */
function scheduleRechargeDeadline(deadlineAt: number, onDeadline: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let canceled = false;
  const scheduleNext = () => {
    if (canceled) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      onDeadline();
      return;
    }
    timer = setTimeout(scheduleNext, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  scheduleNext();
  return () => {
    canceled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function toCompactCycle(cycle: string): string {
  return cycle.replace(/-/g, '');
}

function toCompactDate(date: string): string {
  return date.replace(/-/g, '');
}

const DIM_FIELD_MAP: Record<string, string> = {
  model: 'BASE_MODEL',
  'api-key': 'API_KEY_ID',
};

function toNumber(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : 0;
}

export const SKIP_LINE_ITEM_CATEGORIES: ReadonlySet<string> = new Set([
  'Rounding Adjustment',
  'Refund',
  'Credit Adjustment',
]);

/** Infer the billing unit. */
export function inferBillingUnit(stepUnit: string, billingItemCode?: string): string {
  if (billingItemCode) {
    const codeLower = billingItemCode.toLowerCase();
    if (codeLower.includes('image')) return 'images';
    if (codeLower.includes('video') || codeLower.includes('duration')) return 'seconds';
    if (codeLower.includes('char')) return 'characters';
    if (codeLower.includes('voice')) return 'voices';
    if (codeLower.includes('token')) return 'tokens';
  }

  if (stepUnit) {
    const unitLower = stepUnit.toLowerCase();
    if (unitLower.includes('token')) return 'tokens';
    if (unitLower.includes('image') || unitLower.includes('page')) return 'images';
    if (unitLower.includes('second') || unitLower.includes('sec')) return 'seconds';
    if (unitLower.includes('char') || unitLower.includes('word')) return 'characters';
    if (unitLower.includes('voice')) return 'voices';
  }

  const perMatch = stepUnit.match(/^Per\s+\S+\s+(.+)$/i);
  if (perMatch) return perMatch[1]!.toLowerCase();

  return 'tokens';
}

/** Convert BillQuantity × step size to raw units. */
export function computeUsageValue(billQuantity: number, stepUnit: string): number {
  if (billQuantity === 0) return 0;
  const unitLower = stepUnit.toLowerCase();

  if (unitLower.includes('tenthousand') || stepUnit.includes('万字')) {
    return billQuantity * 10_000;
  }

  const numMatch = stepUnit.match(/(?:^|Per\s+)([\d,]+)\s*([KMkm])?/);
  if (numMatch) {
    const rawNum = numMatch[1]!.replace(/,/g, '');
    const num = parseInt(rawNum, 10);
    const suffix = (numMatch[2] ?? '').toUpperCase();

    let multiplier = num;
    if (suffix === 'K') multiplier = num * 1_000;
    else if (suffix === 'M') multiplier = num * 1_000_000;

    if (multiplier === 1) return billQuantity;
    return billQuantity * multiplier;
  }

  return billQuantity;
}

export interface ParsedBillingItem {
  lineItemCat: string;
  billingDate: string;
  billingMonth: string;
  modelId: string;
  usageValue: number;
  cost: number;
  billingUnit: string;
  isFree: boolean;
}

/** Parse a line item into normalized fields. Returns null for skip categories. */
export function parseBillingItem(
  item: ConsumeSummaryLineItem,
  costMode?: 'full' | 'minimal',
): ParsedBillingItem | null {
  const category = item.LineItemCategory ?? '';
  if (SKIP_LINE_ITEM_CATEGORIES.has(category)) return null;

  const mode = costMode ?? 'full';
  const billingDate = item.BillingDate ?? '';
  const billingMonth = item.BillingMonth ?? '';
  const modelId = item.BaseModel ?? item.ModelName ?? item.Model ?? item.JobId ?? 'Other';
  const billQuantity = toNumber(item.BillQuantity);
  const stepUnit = item.StepQuantityUnit ?? '';
  const billingItemCode = item.BillingItemCode ?? '';

  const usageValue = computeUsageValue(billQuantity, stepUnit);
  const billingUnit = inferBillingUnit(stepUnit, billingItemCode);

  const cost =
    mode === 'full'
      ? toNumber(item.RequireAmount ?? item.Amount ?? item.Cost ?? item.ListPrice)
      : toNumber(item.RequireAmount ?? item.ListPrice);

  const isFree = category.toLowerCase().includes('free');

  return {
    lineItemCat: category,
    billingDate,
    billingMonth,
    modelId,
    usageValue,
    cost,
    billingUnit,
    isFree,
  };
}

/** Split [fromDate, toDate] into per-calendar-month sub-ranges. */
export function splitIntoMonths(fromDate: string, toDate: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  let current = fromDate;
  const MAX_ITERATIONS = 36; // 3 years upper bound
  let iterations = 0;

  while (current <= toDate) {
    if (++iterations > MAX_ITERATIONS) {
      break;
    }
    const [yearStr, monthStr] = current.split('-') as [string, string];
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const lastDayOfMonth = new Date(year, month, 0).getDate();
    const monthEnd = `${yearStr}-${monthStr}-${String(lastDayOfMonth).padStart(2, '0')}`;

    if (monthEnd >= toDate) {
      result.push([current, toDate]);
      break;
    } else {
      result.push([current, monthEnd]);
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      current = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
    }
  }

  return result;
}

export interface BillingAdapter {
  toNormalizedItem(item: ConsumeSummaryLineItem): ParsedBillingItem | null;
}

export interface PaygSummaryOptions {
  from: string;
  to: string;
}

export interface PaygBreakdownOptions {
  from: string;
  to: string;
  granularity: 'day' | 'month' | 'quarter';
  modelFilter?: string;
}

interface RawConsumeData {
  Data?: ConsumeSummaryLineItem[];
}

export class BillingService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly billingAdapter: BillingAdapter,
    private readonly cache: CachedFetcher,
  ) {}

  /**
   * Call a recharge API while retaining its stage for CLI-safe error mapping.
   *
   * @param stage Recharge stage represented by the request.
   * @param options Original flat API request options.
   * @returns The untouched API result.
   */
  private async callRechargeApi<T>(
    stage: RechargeApiFailureStage,
    options: CallFlatApiOptions,
  ): Promise<T> {
    try {
      return await this.apiClient.callFlatApi<T>(options);
    } catch (error) {
      throw markRechargeApiFailure(error, stage);
    }
  }

  async getUsageLimit(): Promise<UsageLimit> {
    const raw = await this.apiClient.callFlatApi<DescribeUsageLimitResponse>({
      product: API_PRODUCT_BSS,
      action: 'DescribeUsageLimit',
    });
    return transformUsageLimit(raw);
  }

  async getAvailableBalance(): Promise<BalanceSummaryDto> {
    const raw = await this.callRechargeApi<GetFundAccountAvailableAmountResponse>(
      'available-amount',
      {
        product: API_PRODUCT_BSS,
        action: 'GetFundAccountAvailableAmount',
        params: {},
      },
    );
    return transformBalanceSummary(raw);
  }

  /**
   * Create exactly one Alipay recharge order after identity and account checks.
   *
   * @param options Normalized channel and amount.
   * @returns The pending order and validated payment URL.
   * @throws {RechargeCreateUnknownError} When a dispatched create request has no reliable outcome.
   */
  async createRecharge(options: {
    channel: 'alipay';
    amount: string;
  }): Promise<RechargeCreateOutput> {
    if (options.channel !== 'alipay') throw new Error('Unsupported recharge channel.');
    const amount = parseRechargeAmount(options.amount).amount;
    const nbid = await this.loadRechargeNbid();
    const status = await this.callRechargeApi<unknown>('billing-account-status', {
      product: API_PRODUCT_BSS,
      action: 'GetBillingAccountBizStatus',
      params: { Nbid: nbid, BizKeys: ['is_limit_charge'] },
    });
    let limitCharge: string;
    try {
      limitCharge = readLimitCharge(status);
    } catch (error) {
      throw markRechargeApiFailure(error, 'billing-account-status');
    }
    if (limitCharge !== 'false') {
      throw new Error(
        limitCharge === 'true'
          ? 'This billing account is not allowed to recharge.'
          : 'Unable to confirm whether this billing account may recharge.',
      );
    }

    // Deliberately issue the write action once. Neither Service nor transport
    // has a retry loop for this call, preventing duplicate payment orders.
    let raw: unknown;
    try {
      raw = await this.callRechargeApi<unknown>('recharge-url', {
        product: API_PRODUCT_BSS,
        action: 'GetRechargeUrl',
        params: {
          Nbid: nbid,
          Money: amount,
          UmId: '',
          ClientVersion: '3.0',
          ClientCode: 'MaasPC',
          RechargeTarget: 'BOOK_ALIYUN_CASH',
          PaymentType: 'PcCharge_PG',
          ExtendInfo: { qrPay: 'true' },
        },
      });
    } catch (error) {
      if (isUncertainRechargeCreateFailure(error)) {
        throw new RechargeCreateUnknownError(error);
      }
      throw error;
    }

    let rechargeOrderId: string;
    let paymentUrl: string;
    try {
      const record = asRecord(raw);
      rechargeOrderId = requiredString(record.ChargeOrderId, 'ChargeOrderId');
      paymentUrl = requiredString(record.RechargeUrl, 'RechargeUrl');
      validatePaymentUrl(paymentUrl, PAYMENT_URL_HOSTS);
    } catch (error) {
      // A successful write response with unusable result fields cannot prove
      // that no order was created, so callers must not retry automatically.
      throw new RechargeCreateUnknownError(markRechargeApiFailure(error, 'recharge-url'));
    }
    return {
      type: 'recharge',
      channel: 'alipay',
      amount,
      currency: 'CNY',
      status: 'pending',
      rechargeOrderId,
      paymentUrl,
    };
  }

  /**
   * Query an existing recharge order exactly once after loading identity.
   *
   * Processing states are returned immediately. A caller abort is normalized
   * to the same interrupt result used by the opt-in polling flow.
   *
   * @param options Existing order identifier and caller interruption signal.
   * @returns The current upstream status, or a local interruption result.
   */
  async getRechargeResult(options: {
    rechargeOrderId: string;
    signal: AbortSignal;
  }): Promise<RechargeResultOutput> {
    try {
      if (options.signal.aborted) {
        return localRechargeResult(options.rechargeOrderId, 'interrupted');
      }
      const nbid = await this.loadRechargeNbid(options.signal);
      if (options.signal.aborted) {
        return localRechargeResult(options.rechargeOrderId, 'interrupted');
      }
      const response = await this.queryRechargeResult({
        nbid,
        rechargeOrderId: options.rechargeOrderId,
        signal: options.signal,
      });
      if (options.signal.aborted) {
        return localRechargeResult(options.rechargeOrderId, 'interrupted');
      }
      return rechargeResultFromResponse(options.rechargeOrderId, response);
    } catch (error) {
      if (options.signal.aborted) {
        return localRechargeResult(options.rechargeOrderId, 'interrupted');
      }
      throw error;
    }
  }

  /**
   * Poll an existing recharge order after loading identity exactly once.
   *
   * @param options Existing order identifier, caller interruption signal, and optional deadline.
   * @returns A normalized terminal polling result.
   */
  async waitForRechargeResult(options: {
    rechargeOrderId: string;
    signal: AbortSignal;
    deadlineAt?: number;
  }): Promise<RechargeResultOutput> {
    return resolveRechargeResult({
      rechargeOrderId: options.rechargeOrderId,
      signal: options.signal,
      deadlineAt: options.deadlineAt,
      loadNbid: (signal) => this.loadRechargeNbid(signal),
      query: ({ nbid, rechargeOrderId, signal }) =>
        this.queryRechargeResult({ nbid, rechargeOrderId, signal }),
    });
  }

  /**
   * Query one existing recharge order and validate the result shape.
   *
   * @param options Identity, order identifier, and transport abort signal.
   * @returns The validated upstream recharge status.
   */
  private async queryRechargeResult(options: {
    nbid: string;
    rechargeOrderId: string;
    signal: AbortSignal;
  }): Promise<{ RechargeStatus: string }> {
    let raw: unknown;
    try {
      raw = await this.callRechargeApi<unknown>('result-query', {
        product: API_PRODUCT_BSS,
        action: 'GetRechargeResult',
        params: { Nbid: options.nbid, ChargeOrderId: options.rechargeOrderId },
        signal: options.signal,
      });
    } catch (error) {
      // GetRechargeResult uses this generic gateway message when the order does
      // not exist or is not visible to the current billing account.
      if (isRechargeOrderNotFoundResponse(error)) {
        throw new RechargeOrderNotFoundError(error);
      }
      throw error;
    }
    let record: Record<string, unknown>;
    try {
      record = asRecord(raw);
    } catch {
      throw markRechargeApiFailure(
        new RechargeResultProtocolError('Invalid recharge API response shape.'),
        'result-query',
      );
    }
    if (typeof record.RechargeStatus !== 'string' || record.RechargeStatus.trim().length === 0) {
      throw markRechargeApiFailure(
        new RechargeResultProtocolError('Invalid recharge API response: RechargeStatus.'),
        'result-query',
      );
    }
    return { RechargeStatus: record.RechargeStatus };
  }

  /**
   * Query normalized recharge history without using a stale cache.
   *
   * @param options Inclusive epoch range and pagination.
   * @returns Validated, presentation-safe recharge records.
   */
  async getRechargeHistory(options: {
    startTime: number;
    endTime: number;
    page?: number;
    pageSize?: number;
  }): Promise<RechargeHistoryOutput> {
    const nbid = await this.loadRechargeNbid();
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 10;
    const raw = await this.callRechargeApi<unknown>('fund-flow', {
      product: API_PRODUCT_BSS,
      action: 'GetFundFlow',
      params: {
        CurrentPage: page,
        PageSize: pageSize,
        StartTime: options.startTime,
        EndTime: options.endTime,
        TradeTypeList: ['CHARGE'],
        Nbid: nbid,
      },
    });
    let record: Record<string, unknown>;
    let records: ReturnType<typeof normalizeRechargeHistoryRecord>[];
    try {
      record = asRecord(raw);
      if (!Array.isArray(record.Data)) throw new Error('Invalid GetFundFlow response: Data.');
      if (
        typeof record.TotalCount !== 'number' ||
        !Number.isSafeInteger(record.TotalCount) ||
        record.TotalCount < 0
      ) {
        throw new Error('Invalid GetFundFlow response: TotalCount.');
      }
      records = record.Data.map((item) => normalizeRechargeHistoryRecord(item));
    } catch (error) {
      throw markRechargeApiFailure(error, 'fund-flow');
    }
    return {
      startTime: formatAsiaShanghaiDate(options.startTime, 'iso'),
      endTime: formatAsiaShanghaiDate(options.endTime, 'iso'),
      page,
      pageSize,
      totalCount: record.TotalCount,
      records,
    };
  }

  /** Load the billing identity required by all recharge APIs. */
  private async loadRechargeNbid(signal?: AbortSignal): Promise<string> {
    const request = {
      product: 'ea-service',
      action: 'LoadHumanInfo',
      params: {},
      ...(signal ? { signal } : {}),
    };
    try {
      const raw = await this.callRechargeApi<unknown>('load-human-info', request);
      const root = asRecord(raw);
      if (root.Success !== true) {
        throw new Error('Invalid recharge API response: Success.');
      }
      const seller = asRecord(asRecord(root.Data).SellerInfoDto);
      return requiredString(seller.Nbid, 'Data.SellerInfoDto.Nbid');
    } catch (error) {
      throw markRechargeApiFailure(error, 'load-human-info');
    }
  }

  /** Break down PAYG spend along a user-selected dimension.
   *  - MONTH granularity: single API call with YYYYMM compact dates.
   *  - DAY granularity: single call when span ≤ 30 days; otherwise sliced
   *    into per-calendar-month sub-ranges so that months with no data do not
   *    cause the API to blank out the entire response.
   *  Always excludes TaxFee via Filter (domestic site does not display tax).
   *  All rows returned by the API (including server-side Others) are preserved. */
  async getConsumeBreakdown(opts: ConsumeBreakdownOptions): Promise<ConsumeBreakdown> {
    const dimCode = DIM_FIELD_MAP[opts.groupBy] ?? 'BASE_MODEL';
    const chargeTypes = opts.chargeType && opts.chargeType !== 'all' ? [opts.chargeType] : [];
    const topNum = opts.top > 0 ? opts.top : 10;
    const granularity = opts.granularity ?? 'month';

    const filter = {
      Dimensions: [{ Code: 'LINE_ITEM_CATEGORY', Values: ['TaxFee'], SelectType: 'NOT' }],
    };

    const mergedMap = new Map<string, ConsumeBreakdownRow>();
    let apiTotalAmount = '';

    if (granularity === 'month') {
      const startDate = toCompactCycle(opts.from.substring(0, 7));
      const endDate = toCompactCycle(opts.to.substring(0, 7));
      const cacheKey = `breakdown:${opts.groupBy}:${startDate}:${endDate}:${opts.chargeType}:month`;

      const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
        this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
          product: API_PRODUCT_BSS,
          action: 'MaasDescribeCostAnalysis',
          params: {
            BizType: 'MAAS_CONSUME_ANALYSIS',
            ChargeTypes: chargeTypes,
            Granularity: 'MONTH',
            TimePeriod: { Start: startDate, End: endDate },
            TopNum: topNum,
            GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
            Filter: filter,
          },
        }),
      );

      const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
      for (const row of dto.rows) {
        mergedMap.set(row.groupKey, { ...row });
      }
      if (dto.totalAmount) apiTotalAmount = dto.totalAmount;
    } else {
      const fromDate = normalizeToFullDate(opts.from, 'start');
      const toDate = normalizeToFullDate(opts.to, 'end');

      const spanDays = this.daysBetween(fromDate, toDate);
      const apiTotalParts: string[] = [];

      if (spanDays <= 30) {
        const cacheKey = `breakdown:${opts.groupBy}:${fromDate}:${toDate}:${opts.chargeType}`;

        const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
          this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
            product: API_PRODUCT_BSS,
            action: 'MaasDescribeCostAnalysis',
            params: {
              BizType: 'MAAS_CONSUME_ANALYSIS',
              ChargeTypes: chargeTypes,
              Granularity: 'DAY',
              TimePeriod: {
                Start: toCompactDate(fromDate),
                End: toCompactDate(toDate),
              },
              TopNum: topNum,
              GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
              Filter: filter,
            },
          }),
        );

        const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
        for (const row of dto.rows) {
          mergedMap.set(row.groupKey, { ...row });
        }
        if (dto.totalAmount) apiTotalParts.push(dto.totalAmount);
      } else {
        const months = splitIntoMonths(fromDate, toDate);

        for (const [monthStart, monthEnd] of months) {
          const cacheKey = `breakdown:${opts.groupBy}:${monthStart}:${monthEnd}:${opts.chargeType}`;

          const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
            this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
              product: API_PRODUCT_BSS,
              action: 'MaasDescribeCostAnalysis',
              params: {
                BizType: 'MAAS_CONSUME_ANALYSIS',
                ChargeTypes: chargeTypes,
                Granularity: 'DAY',
                TimePeriod: {
                  Start: toCompactDate(monthStart),
                  End: toCompactDate(monthEnd),
                },
                TopNum: topNum,
                GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
                Filter: filter,
              },
            }),
          );

          const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
          for (const row of dto.rows) {
            const existing = mergedMap.get(row.groupKey);
            if (existing) {
              existing.amount = sumAmountStrings([existing.amount, row.amount]);
            } else {
              mergedMap.set(row.groupKey, { ...row });
            }
          }
          if (dto.totalAmount) apiTotalParts.push(dto.totalAmount);
        }
      }

      if (apiTotalParts.length > 0) {
        apiTotalAmount = sumAmountStrings(apiTotalParts);
      }
    }

    const allRows = [...mergedMap.values()];
    const totalRows = allRows.length;
    const sortedRows = allRows.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const truncatedRows = sortedRows.slice(0, topNum);

    const displayedSum = sumAmountStrings(truncatedRows.map((r) => r.amount));
    const totalAmount = apiTotalAmount || displayedSum;

    if (totalAmount && parseFloat(totalAmount) > parseFloat(displayedSum)) {
      const unlistedAmount = subtractAmountStrings(totalAmount, displayedSum);
      if (parseFloat(unlistedAmount) > 0) {
        truncatedRows.push({
          groupKey: 'UNLISTED',
          groupLabel: 'Unlisted',
          amount: unlistedAmount,
        });
      }
    }

    return {
      groupBy: opts.groupBy,
      period: { from: opts.from, to: opts.to },
      chargeType: opts.chargeType,
      rows: truncatedRows,
      totalRows,
      totalAmount,
      currency: site.features.currency,
    };
  }

  /** Break down PAYG spend into per-period slices without cross-period aggregation.
   *  Each slice contains its own top-N rows.
   *  Always excludes TaxFee via Filter (domestic site does not display tax). */
  async getConsumeBreakdownByPeriods(
    opts: ConsumeBreakdownOptions,
  ): Promise<ConsumeBreakdownByPeriods> {
    const dimCode = DIM_FIELD_MAP[opts.groupBy] ?? 'BASE_MODEL';
    const chargeTypes = opts.chargeType && opts.chargeType !== 'all' ? [opts.chargeType] : [];
    const topNum = opts.top > 0 ? opts.top : 10;
    const granularity = opts.granularity ?? 'month';

    const filter = {
      Dimensions: [{ Code: 'LINE_ITEM_CATEGORY', Values: ['TaxFee'], SelectType: 'NOT' }],
    };

    const slices: ConsumeBreakdownPeriodSlice[] = [];

    if (granularity === 'month') {
      const fromMonth = opts.from.substring(0, 7);
      const toMonth = opts.to.substring(0, 7);
      const startDate = toCompactCycle(fromMonth);
      const endDate = toCompactCycle(toMonth);
      const cacheKey = `breakdown-periods:${opts.groupBy}:${startDate}:${endDate}:${opts.chargeType}:month`;

      const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
        this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
          product: API_PRODUCT_BSS,
          action: 'MaasDescribeCostAnalysis',
          params: {
            BizType: 'MAAS_CONSUME_ANALYSIS',
            ChargeTypes: chargeTypes,
            Granularity: 'MONTH',
            TimePeriod: { Start: startDate, End: endDate },
            TopNum: topNum,
            GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
            Filter: filter,
          },
        }),
      );

      const resultByTime = raw?.ResultByTime;

      if (resultByTime && resultByTime.length > 0) {
        for (const entry of resultByTime) {
          const period = entry.Period ?? '';
          const totalAmount = this.toAmountStr(entry.Total?.Amount);
          const rows = (entry.PeriodDetails ?? []).map((item) => ({
            groupKey: item.Key ?? '',
            groupLabel: item.Name ?? item.Key ?? '',
            amount: this.toAmountStr(item.Amount),
          }));
          const slice = this.buildPeriodSliceFromRows(period, rows, topNum, totalAmount);
          slices.push(slice);
        }
      } else {
        // Fallback: read from GroupByTotal when ResultByTime is absent
        const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
        const periodLabel = fromMonth === toMonth ? fromMonth : `${fromMonth} \u2192 ${toMonth}`;
        const slice = this.buildPeriodSliceFromRows(periodLabel, dto.rows, topNum, dto.totalAmount);
        slices.push(slice);
      }
    } else {
      const fromDate = normalizeToFullDate(opts.from, 'start');
      const toDate = normalizeToFullDate(opts.to, 'end');
      const spanDays = this.daysBetween(fromDate, toDate);

      const fetchAndParseDaySlices = async (start: string, end: string) => {
        const cacheKey = `breakdown-periods:${opts.groupBy}:${start}:${end}:${opts.chargeType}:day`;

        const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
          this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
            product: API_PRODUCT_BSS,
            action: 'MaasDescribeCostAnalysis',
            params: {
              BizType: 'MAAS_CONSUME_ANALYSIS',
              ChargeTypes: chargeTypes,
              Granularity: 'DAY',
              TimePeriod: {
                Start: toCompactDate(start),
                End: toCompactDate(end),
              },
              TopNum: topNum,
              GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
              Filter: filter,
            },
          }),
        );

        const resultByTime = raw?.ResultByTime;

        if (resultByTime && resultByTime.length > 0) {
          for (const entry of resultByTime) {
            const period = entry.Period ?? start;
            const rows = (entry.PeriodDetails ?? []).map((item) => ({
              groupKey: item.Key ?? '',
              groupLabel: item.Name ?? item.Key ?? '',
              amount: this.toAmountStr(item.Amount),
            }));
            const slice = this.buildPeriodSliceFromRows(period, rows, topNum);
            slices.push(slice);
          }
        } else {
          const periodLabel = start === end ? start : `${start} \u2192 ${end}`;
          const slice = this.buildPeriodSlice(periodLabel, raw, topNum);
          slices.push(slice);
        }
      };

      if (spanDays <= 30) {
        await fetchAndParseDaySlices(fromDate, toDate);
      } else {
        const months = splitIntoMonths(fromDate, toDate);
        for (const [monthStart, monthEnd] of months) {
          await fetchAndParseDaySlices(monthStart, monthEnd);
        }
      }
    }

    slices.sort((a, b) => a.period.localeCompare(b.period));

    return {
      groupBy: opts.groupBy,
      dateRange: { from: opts.from, to: opts.to },
      granularity,
      chargeType: opts.chargeType,
      slices,
      currency: site.features.currency,
    };
  }

  private enumerateMonths(fromYM: string, toYM: string): string[] {
    const result: string[] = [];
    let [year, month] = fromYM.split('-').map(Number) as [number, number];
    const [endYear, endMonth] = toYM.split('-').map(Number) as [number, number];
    while (year < endYear || (year === endYear && month <= endMonth)) {
      result.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
    return result;
  }

  private buildPeriodSlice(
    period: string,
    raw: MaasDescribeCostAnalysisResponse | null | undefined,
    topNum: number,
  ): ConsumeBreakdownPeriodSlice {
    const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
    return this.buildPeriodSliceFromRows(period, dto.rows, topNum, dto.totalAmount);
  }

  private buildPeriodSliceFromRows(
    period: string,
    rows: ConsumeBreakdownRow[],
    topNum: number,
    apiTotalAmount?: string,
  ): ConsumeBreakdownPeriodSlice {
    const sorted = rows.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const truncated = sorted.slice(0, topNum);
    const displayedSum = sumAmountStrings(truncated.map((r) => r.amount));
    const totalAmount = apiTotalAmount || displayedSum;

    if (totalAmount && parseFloat(totalAmount) > parseFloat(displayedSum)) {
      const unlistedAmount = subtractAmountStrings(totalAmount, displayedSum);
      if (parseFloat(unlistedAmount) > 0) {
        truncated.push({ groupKey: 'UNLISTED', groupLabel: 'Unlisted', amount: unlistedAmount });
      }
    }

    return { period, rows: truncated, totalAmount };
  }

  private toAmountStr(value: string | number | undefined | null): string {
    if (value == null) return '0';
    const s = String(value).trim();
    return s.length === 0 ? '0' : s;
  }

  private daysBetween(fromDate: string, toDate: string): number {
    const from = new Date(fromDate);
    const to = new Date(toDate);
    return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  }

  async getSettleBillSummary(opts: SettleBillSummaryOptions): Promise<SettleBillSummary> {
    const raw = await this.apiClient.callFlatApi<ListSettleBillTotalSummaryResponse>({
      product: API_PRODUCT_BSS,
      action: 'ListSettleBillTotalSummary',
      params: {
        StartBillingCycle: toCompactCycle(opts.from),
        EndBillingCycle: toCompactCycle(opts.to),
        ...(opts.chargeType && opts.chargeType !== 'all' ? { ChargeType: opts.chargeType } : {}),
      },
    });
    const dto: SettleBillSummaryDto = transformSettleBillSummary(raw);

    // The server (ListSettleBillTotalSummary) only returns cycles that have a
    // settled bill record, so month gaps appear in the response. Expand the
    // requested [from, to] window into a continuous month list: cycles the
    // server returned keep their real values (a 0 amount is a genuine ¥0.00),
    // while missing months are filled with a placeholder (settled=false) that
    // downstream renderers show as "No bill". Totals only count real records.
    const byCycle = new Map<string, SettleBillCycle>();
    for (const c of dto.cycles) {
      byCycle.set(toCompactCycle(c.billingCycle), c);
    }

    const cycles: SettleBillCycle[] = this.enumerateMonths(opts.from, opts.to).map((ym) => {
      const compact = toCompactCycle(ym);
      const real = byCycle.get(compact);
      if (real) return real;
      return {
        billingCycle: compact,
        pretaxAmount: '0',
        tax: '0',
        aftertaxAmount: '0',
        settled: false,
      };
    });

    const settledCycles = cycles.filter((c) => c.settled);
    const totals: SettleBillTotals = {
      pretaxAmount: sumAmountStrings(settledCycles.map((c) => c.pretaxAmount)),
      tax: sumAmountStrings(settledCycles.map((c) => c.tax)),
      aftertaxAmount: sumAmountStrings(settledCycles.map((c) => c.aftertaxAmount)),
    };
    return {
      cycles,
      totals,
      currency: dto.currency,
      period: { from: opts.from, to: opts.to },
      chargeType: opts.chargeType,
    };
  }

  async getPaygSummary(options: PaygSummaryOptions): Promise<PayAsYouGo> {
    const fromDate = normalizeToFullDate(options.from, 'start');
    const toDate = normalizeToFullDate(options.to, 'end');

    const fromMonth = fromDate.substring(0, 7);
    const toMonth = toDate.substring(0, 7);

    const [items, settleBill, costAnalysis] = await Promise.all([
      this.fetchPaygItems(fromDate, toDate, undefined, 'MONTHLY'),
      this.getSettleBillSummary({ from: fromMonth, to: toMonth, chargeType: 'postpaid' }).catch(
        () => null,
      ),
      this.fetchPaygCostByModel(fromMonth, toMonth).catch(() => null),
    ]);

    // When MaasDescribeCostAnalysis succeeded, use its server-side aggregated
    // per-model costs (no pagination issue) merged with usage data from items.
    // Fall back to the original client-side aggregation otherwise.
    let models: PayAsYouGo['models'];
    let aggregatedTotalCost: number;

    if (costAnalysis && costAnalysis.length > 0) {
      models = mergePaygModelData(costAnalysis, items);
      aggregatedTotalCost = models.reduce((sum, m) => sum + m.cost, 0);
    } else {
      const aggregated = aggregatePaygByModel(items);
      models = aggregated.models;
      aggregatedTotalCost = aggregated.total.cost;
    }

    // Prefer the settlement total when it parses to a finite number — a
    // legitimate 0 (fee waiver / full credit offset / net-zero refund) must
    // not fall back to the aggregated total.
    let settlementTotal = aggregatedTotalCost;
    if (settleBill && settleBill.cycles.some((c) => c.settled)) {
      const parsed = parseFloat(settleBill.totals.aftertaxAmount);
      if (Number.isFinite(parsed)) {
        settlementTotal = parsed;
      }
    }

    return {
      models,
      total: { cost: settlementTotal, currency: site.features.currency },
    };
  }

  async getPaygBreakdown(options: PaygBreakdownOptions): Promise<UsageBreakdownResponse> {
    const fromDate = normalizeToFullDate(options.from, 'start');
    const toDate = normalizeToFullDate(options.to, 'end');
    const items = await this.fetchPaygItems(fromDate, toDate, options.modelFilter);
    const rawDailyRows = aggregatePaygByDate(items);
    const dailyRows = fillDailyGaps(rawDailyRows, fromDate, toDate);

    let rows: AggregatedRow[] | PaygDailyRow[];
    if (options.granularity === 'quarter') {
      rows = aggregateQuarterly(aggregateMonthly(dailyRows));
    } else if (options.granularity === 'month') {
      rows = aggregateMonthly(dailyRows);
    } else {
      rows = dailyRows;
    }

    return this.shapeBreakdown(rows, { ...options, from: fromDate, to: toDate });
  }

  private async fetchPaygItems(
    fromDate: string,
    toDate: string,
    modelFilter?: string,
    granularity: 'DAILY' | 'MONTHLY' = 'DAILY',
  ): Promise<PaygItem[]> {
    const collected: PaygItem[] = [];

    for (const [monthStart, monthEnd] of splitIntoMonths(fromDate, toDate)) {
      const params: Record<string, unknown> =
        granularity === 'MONTHLY'
          ? {
              Console: true,
              Granularity: 'MONTHLY',
              ChargeTypes: ['postpaid'],
              BillingMonth: monthStart.substring(0, 7),
              MaxResults: 100,
              CurrentPage: 1,
            }
          : {
              Console: true,
              Granularity: 'DAILY',
              ChargeTypes: ['postpaid'],
              StartBillingDate: monthStart,
              EndBillingDate: monthEnd,
              MaxResults: 100,
              CurrentPage: 1,
              SortName: 'BillingDate',
              SortOrder: 'DESC',
            };
      if (modelFilter) params['ModelNames'] = [modelFilter];

      const response = await this.apiClient.callFlatApi<RawConsumeData>({
        product: API_PRODUCT_BSS,
        action: API_ACTION_CONSUME_SUMMARY,
        params,
      });

      for (const item of response.Data ?? []) {
        const parsed = this.billingAdapter.toNormalizedItem(item);
        if (!parsed || parsed.isFree) continue;
        collected.push({
          billingDate: parsed.billingDate,
          billingMonth: parsed.billingMonth,
          modelId: parsed.modelId,
          usageValue: parsed.usageValue,
          cost: parsed.cost,
          billingUnit: parsed.billingUnit,
        });
      }
    }

    return collected;
  }

  private async fetchPaygCostByModel(
    fromMonth: string,
    toMonth: string,
  ): Promise<ConsumeBreakdownRow[]> {
    const startDate = toCompactCycle(fromMonth);
    const endDate = toCompactCycle(toMonth);
    const cacheKey = `payg-cost-by-model:${startDate}:${endDate}`;

    const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
      this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
        product: API_PRODUCT_BSS,
        action: 'MaasDescribeCostAnalysis',
        params: {
          BizType: 'MAAS_CONSUME_ANALYSIS',
          ChargeTypes: ['postpaid'],
          Granularity: 'MONTH',
          TimePeriod: { Start: startDate, End: endDate },
          TopNum: 20,
          GroupBy: [{ Code: 'BASE_MODEL', Type: 'Dimensions' }],
          Filter: {
            Dimensions: [{ Code: 'LINE_ITEM_CATEGORY', Values: ['TaxFee'], SelectType: 'NOT' }],
          },
        },
      }),
    );

    const dto = transformConsumeBreakdown(raw);
    return dto.rows;
  }

  private shapeBreakdown(
    rows: Array<AggregatedRow | PaygDailyRow>,
    options: PaygBreakdownOptions,
  ): UsageBreakdownResponse {
    const costStrings = rows.map((r) => toDecimalString(r.cost ?? 0));
    const totalCost = parseFloat(sumAmountStrings(costStrings));
    const sumKey = (key: string): number =>
      rows.reduce((s, r) => s + ((r as Record<string, number>)[key] ?? 0), 0);
    const totalTokensIn = sumKey('tokens_in');
    const totalTokensOut = sumKey('tokens_out');
    const totalImages = sumKey('images');
    const totalSeconds = sumKey('seconds');
    const totalCharacters = sumKey('characters');

    const breakdownRows: UsageBreakdownRow[] = rows.map((r) => {
      const out: UsageBreakdownRow = {
        period: r.period,
        cost: r.cost,
        currency: r.currency,
      };
      const flat = r as Record<string, unknown>;
      if (flat.tokens_in != null) out.tokens_in = flat.tokens_in as number;
      if (flat.tokens_out != null) out.tokens_out = flat.tokens_out as number;
      const usage: Record<string, number> = {};
      if (flat.images != null) usage.images = flat.images as number;
      if (flat.seconds != null) usage.seconds = flat.seconds as number;
      if (flat.characters != null) usage.characters = flat.characters as number;
      if (Object.keys(usage).length > 0) out.usage = usage;
      return out;
    });

    const total: UsageBreakdownTotal = {
      // Already summed exactly via sumAmountStrings — keep every meaningful
      // digit instead of rounding to a fixed decimal count.
      cost: totalCost,
      currency: site.features.currency,
    };
    if (totalTokensIn > 0) total.tokens_in = Math.round(totalTokensIn);
    if (totalTokensOut > 0) total.tokens_out = Math.round(totalTokensOut);
    const totalUsage: Record<string, number> = {};
    if (totalImages > 0) totalUsage.images = Math.round(totalImages);
    if (totalSeconds > 0) totalUsage.seconds = Math.round(totalSeconds);
    if (totalCharacters > 0) totalUsage.characters = Math.round(totalCharacters);
    if (Object.keys(totalUsage).length > 0) total.usage = totalUsage;

    void this.cache;
    return {
      model_id: options.modelFilter ?? 'all',
      period: { from: options.from, to: options.to },
      granularity: options.granularity,
      rows: breakdownRows,
      total,
    };
  }
}

/** Narrow an unknown API value to a plain record or reject the response. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid recharge API response shape.');
  }
  return value as Record<string, unknown>;
}

/** Read a required non-empty string field from an upstream response. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid recharge API response: ${field}.`);
  }
  return value;
}

/** Read the exact string-valued limit flag returned by the billing API. */
function readLimitCharge(value: unknown): string {
  const data = asRecord(asRecord(value).Data);
  return requiredString(data.is_limit_charge, 'Data.is_limit_charge');
}

/** Normalize one CHARGE fund-flow row and reject partial or malformed records. */
function normalizeRechargeHistoryRecord(value: unknown): {
  tradeTime: string;
  tradeType: 'CHARGE';
  tradeChannel: string;
  amount: string;
  currency: string;
} {
  const item = asRecord(value);
  const tradeTime = requiredString(item.TradeTimeStr, 'Data[].TradeTimeStr');
  const tradeType = requiredString(item.TradeType, 'Data[].TradeType');
  if (tradeType !== 'CHARGE') throw new Error('Invalid recharge history trade type.');
  const tradeChannel = requiredString(item.TradeChannel, 'Data[].TradeChannel');
  const currency = requiredString(item.Currency, 'Data[].Currency');
  return {
    tradeTime,
    tradeType: 'CHARGE',
    tradeChannel,
    amount: normalizeHistoryAmount(item.DealAmount),
    currency,
  };
}

/** Convert a non-negative upstream monetary value to two decimals without arithmetic. */
function normalizeHistoryAmount(value: unknown): string {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error('Invalid recharge history amount.');
  }
  const [integer, fraction = ''] = raw.split('.');
  return `${integer}.${fraction.padEnd(2, '0')}`;
}
