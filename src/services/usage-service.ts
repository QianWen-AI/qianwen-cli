/** Usage data orchestration service. */
import type {
  UsageSummaryResponse,
  UsageBreakdownResponse,
  UsageLogsResponse,
  UsageLogItem,
  UsageEntry,
  FreeTierUsage,
  TokenPlan,
  PayAsYouGo,
} from '../types/usage.js';

import type { ApiClient } from '../api/api-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type { BillingService } from './billing-service.js';
import type { FreetierService } from './freetier-service.js';
import type { TokenplanService } from './tokenplan-service.js';
import { normalizeTimestamp, unixMsToLocalIso } from '../utils/timestamp.js';

// Re-export the date-range slicer so existing callers/tests can still import it.
export { splitIntoMonths } from './billing-service.js';

// ────────────────────────────────────────────────────────────────────
// Public option types
// ────────────────────────────────────────────────────────────────────

export interface UsageSummaryOptions {
  from?: string;
  to?: string;
  period?: string;
}

export interface UsageBreakdownOptions {
  model: string;
  granularity?: 'day' | 'month' | 'quarter';
  from?: string;
  to?: string;
  period?: string;
  days?: number;
}

export type UsageLogStatusType = 'CANCEL' | 'SUCCESS' | 'CLIENT_ERROR' | 'SERVER_ERROR';

export interface UsageLogsOptions {
  from: string;
  to: string;
  models?: string[];
  statusCodeTypes?: UsageLogStatusType[];
  modelRequestId?: string;
  page?: number;
  pageSize?: number;
}

// ────────────────────────────────────────────────────────────────────
// Date helpers (local, deliberately not exported)
// ────────────────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** First day of the current calendar month in UTC, as YYYY-MM-DD. */
function firstOfThisMonthUtc(): string {
  return todayUtc().replace(/-\d{2}$/, '-01');
}

// ────────────────────────────────────────────────────────────────────
// UsageService
// ────────────────────────────────────────────────────────────────────

const LIST_MODEL_LOGS_API = 'zeldaEasy.bailian-telemetry.platform-model.listModelLogs';
const USAGE_LOGS_DEFAULT_PAGE = 1;
const USAGE_LOGS_DEFAULT_PAGE_SIZE = 20;
const USAGE_LOGS_MAX_PAGE_SIZE = 100;

interface RawOriginLog {
  request_id?: string | null;
  model?: string | null;
  start_unix_timestamp?: string | null;
  duration?: string | null;
  status_code?: string | null;
  usage?: string | null;
  workspace_id?: string | null;
  start_time?: string | null;
  uid?: string | null;
  extras?: string | null;
}

interface RawFormattedUsage {
  unit?: string | null;
  value?: number | null;
  key?: string | null;
}

interface RawUsageLogListItem {
  originLog?: RawOriginLog | null;
  formattedUsages?: RawFormattedUsage[] | null;
}

interface RawUsageLogsResponse {
  totalCount?: number | null;
  maxResults?: number | null;
  list?: RawUsageLogListItem[] | null;
}

export class UsageService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly billingService: BillingService,
    private readonly freetierService: FreetierService,
    private readonly tokenplanService: TokenplanService,
    // CachedFetcher is reserved for future TTL caching of telemetry windows.
    private readonly _cache?: CachedFetcher,
  ) {}

  /**
   * Cross-source usage summary for a date range. Defaults to month-to-date.
   * All sub-services are fanned out concurrently; failures in the non-PAYG
   * branches are absorbed by their owning services so the summary always renders.
   */
  async getUsageSummary(options?: UsageSummaryOptions): Promise<UsageSummaryResponse> {
    const fromDate = options?.from ?? firstOfThisMonthUtc();
    const toDate = options?.to ?? todayUtc();

    const [freeTier, tokenPlan, payg] = await Promise.all<
      [Promise<FreeTierUsage[]>, Promise<TokenPlan>, Promise<PayAsYouGo>]
    >([
      this.freetierService.fetchFreeTierUsageList(),
      this.tokenplanService.fetchTokenPlan(),
      this.billingService.getPaygSummary({ from: fromDate, to: toDate }),
    ]);

    return {
      period: { from: fromDate, to: toDate },
      free_tier: freeTier,
      token_plan: tokenPlan,
      pay_as_you_go: payg,
    };
  }

  /**
   * Per-period breakdown for a single model (or all models when omitted).
   * Delegates entirely to BillingService.
   */
  async getUsageBreakdown(options: UsageBreakdownOptions): Promise<UsageBreakdownResponse> {
    const fromDate = options.from ?? firstOfThisMonthUtc();
    const toDate = options.to ?? todayUtc();
    const granularity = options.granularity ?? 'day';
    const modelFilter = options.model;

    return this.billingService.getPaygBreakdown({
      from: fromDate,
      to: toDate,
      granularity,
      modelFilter,
    });
  }

  /**
   * Paginated call-log query. Time range is mapped to ms epoch on the wire;
   * `modelRequestId` short-circuits the other filters to mimic the upstream
   * exact-match contract.
   */
  async getUsageLogs(options: UsageLogsOptions): Promise<UsageLogsResponse> {
    const page = clampUsageLogsPage(options.page);
    const pageSize = clampUsageLogsPageSize(options.pageSize);

    const requestPayload: Record<string, unknown> = {
      startTime: toEpochMs(options.from),
      endTime: toEndEpochMs(options.to),
      maxResults: pageSize,
      skip: (page - 1) * pageSize,
    };

    if (options.modelRequestId) {
      requestPayload.modelRequestId = options.modelRequestId;
    } else {
      if (options.models && options.models.length > 0) {
        requestPayload.models = options.models;
      }
      if (options.statusCodeTypes && options.statusCodeTypes.length > 0) {
        requestPayload.statusCodeTypes = options.statusCodeTypes;
      }
    }

    const raw = await this.apiClient.callEnvelopeApi<RawUsageLogsResponse | null>({
      api: LIST_MODEL_LOGS_API,
      data: requestPayload,
    });

    if (raw && typeof raw === 'object' && 'success' in raw) {
      const inner = raw as Record<string, unknown>;
      if (inner.success === false) {
        throw new Error(
          typeof inner.message === 'string' ? inner.message : 'Usage logs query failed',
        );
      }
    }

    const rawList = Array.isArray(raw?.list) ? raw!.list! : [];
    return {
      totalCount: raw?.totalCount ?? 0,
      page,
      pageSize: raw?.maxResults ?? pageSize,
      period: { from: options.from, to: options.to },
      items: rawList.map(normalizeUsageLogItem),
    };
  }
}

function normalizeUsageLogItem(item: RawUsageLogListItem): UsageLogItem {
  const origin = item.originLog ?? {};
  return {
    requestId: origin.request_id ?? '',
    model: origin.model ?? '',
    createdAt: resolveCreatedAt(origin),
    statusCode: Number(origin.status_code) || 0,
    durationMs: Number(origin.duration) || 0,
    firstOutputDurationMs: 0,
    errorCode: null,
    usages: normalizeFormattedUsages(item.formattedUsages),
  };
}

/** Prefer the millisecond epoch the gateway provides — Date can then render
 *  it in the user's local timezone. Fall back to the UTC wall-clock string
 *  for legacy responses that omit `start_unix_timestamp`. */
function resolveCreatedAt(origin: RawOriginLog): string {
  const raw = origin.start_unix_timestamp;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) {
      const iso = unixMsToLocalIso(ms);
      if (iso) return iso;
    }
  }
  return normalizeTimestamp(truncateMs(origin.start_time ?? ''));
}

function normalizeFormattedUsages(raw: RawFormattedUsage[] | null | undefined): UsageEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: UsageEntry[] = [];
  for (const u of raw) {
    const value = typeof u?.value === 'number' ? u.value : Number(u?.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({ key: formatUsageKey(u?.key ?? ''), value });
  }
  return out;
}

function formatUsageKey(key: string): string {
  // "total_tokens" → "total"; "image_count" → "image".
  return key.replace(/_(tokens|count)$/, '');
}

/** Strip the millisecond fraction so wall-clock strings like
 *  "2026-05-26 17:06:45.511" render as "2026-05-26 17:06:45". */
function truncateMs(timeStr: string): string {
  const dotIdx = timeStr.lastIndexOf('.');
  return dotIdx >= 0 ? timeStr.slice(0, dotIdx) : timeStr;
}

function toEpochMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  // Treat YYYY-MM-DD as UTC midnight when Date.parse rejects it.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00Z`)
    : Number.NaN;
  return Number.isFinite(dateOnly) ? dateOnly : 0;
}

const DAY_MS = 86_400_000;

/** Like toEpochMs but for an inclusive end boundary: a bare YYYY-MM-DD
 *  is advanced to the following day's midnight so that `< endTime` covers
 *  the entire calendar day. */
function toEndEpochMs(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return toEpochMs(value) + DAY_MS;
  }
  return toEpochMs(value);
}

function clampUsageLogsPage(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw as number) < 1) return USAGE_LOGS_DEFAULT_PAGE;
  return Math.floor(raw as number);
}

function clampUsageLogsPageSize(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw as number) < 1) return USAGE_LOGS_DEFAULT_PAGE_SIZE;
  return Math.min(USAGE_LOGS_MAX_PAGE_SIZE, Math.floor(raw as number));
}
