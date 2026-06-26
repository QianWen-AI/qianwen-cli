/** Subscription orchestration service. */
import type { ApiClient } from '../api/api-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type {
  CheckInstancesRenewableResponse,
  CheckTokenPlanAutoRenewalResponse,
  FrInstanceResponse,
  GetSeatSubscriptionSummaryResponse,
  GetSubscriptionDetailResponse,
  QueryOrderDetailResponse,
  QueryOrderListResponse,
  QuerySubscriptionGrayResponse,
} from '../types/api-models.js';
import type {
  AutoRenewalDto,
  InstancesRenewableDto,
  ListOrdersOptions,
  OrderDetail,
  OrderListDto,
  SeatSubscriptionSummaryDto,
  SubscriptionCreditPack,
  SubscriptionDetailDto,
  SubscriptionDiagnostic,
  SubscriptionGrayDto,
  SubscriptionOrder,
  SubscriptionOrders,
  SubscriptionOrdersResult,
  SubscriptionQuota,
  SubscriptionRecentOrder,
  SubscriptionSeatTier,
  SubscriptionStatus,
  SubscriptionStatusResult,
} from '../types/subscription.js';
import type { TokenPlan } from '../types/usage.js';
import type { TokenplanService } from './tokenplan-service.js';
import { site } from '../site.js';
import { API_PRODUCT_ACCOUNT_CENTER } from '../types/api-routes.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_PRODUCT_BSS_LEGACY = 'BssOpenApi';
const STATUS_SOFT_TIMEOUT_MS = 35_000;
const ORDERS_CACHE_TTL_MS = 5 * 60 * 1000;
const DETAIL_CONCURRENCY = 5;
const NBID_CACHE_TTL_MS = 30 * 60 * 1000;

export interface SubscriptionAdapter {
  transformSubscriptionGray(
    raw: QuerySubscriptionGrayResponse | null | undefined,
  ): SubscriptionGrayDto;
  transformSeatSubscriptionSummary(
    raw: GetSeatSubscriptionSummaryResponse | null | undefined,
  ): SeatSubscriptionSummaryDto;
  transformSubscriptionDetail(
    raw: GetSubscriptionDetailResponse | null | undefined,
  ): SubscriptionDetailDto;
  transformAutoRenewal(raw: CheckTokenPlanAutoRenewalResponse | null | undefined): AutoRenewalDto;
  transformInstancesRenewable(
    raw: CheckInstancesRenewableResponse | null | undefined,
  ): InstancesRenewableDto;
  transformOrderList(raw: QueryOrderListResponse | null | undefined): OrderListDto;
  transformOrderDetail(raw: QueryOrderDetailResponse | null | undefined): OrderDetail;
}

interface SubCallSpec<T> {
  api: string;
  invoke: () => Promise<T>;
}

interface SubCallResult<T> {
  api: string;
  data: T | null;
  diagnostic: SubscriptionDiagnostic | null;
}

function toDiagnostic(api: string, error: unknown): SubscriptionDiagnostic {
  const errorMessage = error instanceof Error ? error.message : String(error);
  let errorCode = 'Unknown';
  if (error && typeof error === 'object') {
    const candidate =
      (error as { code?: unknown; errorCode?: unknown }).code ??
      (error as { errorCode?: unknown }).errorCode;
    if (typeof candidate === 'string' && candidate.length > 0) errorCode = candidate;
  }
  return { api, errorCode, errorMessage };
}

async function runWithSoftTimeout(
  calls: Array<SubCallSpec<unknown>>,
  timeoutMs: number,
): Promise<Array<SubCallResult<unknown>>> {
  const results: Array<SubCallResult<unknown>> = calls.map((c) => ({
    api: c.api,
    data: null,
    diagnostic: null,
  }));

  const tasks = calls.map(async (c, idx) => {
    try {
      results[idx]!.data = await c.invoke();
    } catch (error) {
      results[idx]!.diagnostic = toDiagnostic(c.api, error);
    }
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(), timeoutMs);
  });

  await Promise.race([Promise.all(tasks), timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  for (const r of results) {
    if (r.data === null && r.diagnostic === null) {
      r.diagnostic = {
        api: r.api,
        errorCode: 'Timeout',
        errorMessage: `timeout: sub-call exceeded ${timeoutMs}ms soft limit`,
      };
    }
  }
  return results;
}

function quotaFromTokenPlan(dto: TokenPlan | null | undefined): SubscriptionQuota | null {
  if (!dto || dto.subscribed !== true) return null;
  const total = Number(dto.totalCredits ?? 0);
  const remaining = Number(dto.remainingCredits ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(remaining)) return null;
  if (total <= 0) return { remaining: Math.max(0, remaining), total: 0, usedPct: 0 };
  const used = Math.max(0, total - remaining);
  const usedPct = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return { remaining: Math.max(0, remaining), total, usedPct };
}

function syntheticSeatTierFromTokenPlan(dto: TokenPlan | null | undefined): SubscriptionSeatTier[] {
  if (!dto || dto.subscribed !== true) return [];
  const total = Number(dto.totalCredits ?? 0);
  const remaining = Number(dto.remainingCredits ?? 0);
  if (!Number.isFinite(total) || total <= 0) return [];
  const safeRemaining = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
  const used = Math.max(0, total - safeRemaining);
  const usedPct = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return [
    {
      specType: '',
      seats: 1,
      totalCredits: total,
      remainingCredits: safeRemaining,
      usedPct,
      nextCycleFlushTime: dto.resetDate ?? null,
    },
  ];
}

function detectOrderApiUnavailable(
  raw: { Code?: string; Message?: string; Data?: unknown } | null | undefined,
): CliError | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.Data !== undefined) return null;
  const code = typeof raw.Code === 'string' ? raw.Code : '';
  if (!code) return null;
  return new CliError({
    code: 'FEATURE_UNAVAILABLE',
    message: 'Subscription orders is not available yet.',
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

export class SubscriptionService {
  private cachedNbId: string | null = null;
  private nbIdTimestamp = 0;

  constructor(
    private readonly apiClient: ApiClient,
    private readonly subscriptionAdapter: SubscriptionAdapter,
    private readonly cache: CachedFetcher,
    private readonly tokenplanService: TokenplanService,
  ) {}

  async getStatus(opts: { plan?: 'token' } = {}): Promise<SubscriptionStatusResult> {
    const wantToken = opts.plan === undefined || opts.plan === 'token';

    const calls: Array<SubCallSpec<unknown>> = [
      {
        api: 'QuerySubscriptionGray',
        invoke: () =>
          this.apiClient.callFlatApi<QuerySubscriptionGrayResponse>({
            product: API_PRODUCT_BSS,
            action: 'QuerySubscriptionGray',
          }),
      },
    ];

    if (wantToken) {
      calls.push({
        api: 'GetSeatSubscriptionSummary',
        invoke: () =>
          this.apiClient.callFlatApi<GetSeatSubscriptionSummaryResponse>({
            product: API_PRODUCT_BSS,
            action: 'GetSeatSubscriptionSummary',
            params: {
              productCode: site.features.tokenPlanCommodityCodes.teams,
            },
          }),
      });
      calls.push({
        api: 'TokenPlan',
        invoke: () => this.tokenplanService.fetchTokenPlan(),
      });
      calls.push({
        api: 'DescribeFrInstances-addon',
        invoke: () =>
          this.apiClient.callFlatApi<FrInstanceResponse>({
            product: API_PRODUCT_BSS,
            action: 'DescribeFrInstances',
            params: {
              Group: 'tokenPlan',
              CommodityCode: site.features.tokenPlanCommodityCodes.addon,
              PageNum: 1,
              PageSize: 10,
            },
          }),
      });
      calls.push({
        api: 'CheckTokenPlanAutoRenewal',
        invoke: () =>
          this.apiClient.callFlatApi<CheckTokenPlanAutoRenewalResponse>({
            product: API_PRODUCT_BSS_LEGACY,
            action: 'CheckTokenPlanAutoRenewal',
            params: {
              CommodityCode: site.features.tokenPlanCommodityCodes.teams,
            },
          }),
      });
    }

    // Phase 1: run all independent sub-calls concurrently.
    const results = await runWithSoftTimeout(calls, STATUS_SOFT_TIMEOUT_MS);

    const diagnostics: SubscriptionDiagnostic[] = results
      .map((r) => r.diagnostic)
      .filter((d): d is SubscriptionDiagnostic => d !== null);

    const lookup = new Map<string, unknown>();
    for (const r of results) {
      if (r.data !== null) lookup.set(r.api, r.data);
    }

    if (diagnostics.length === results.length) {
      return { data: null, diagnostics };
    }

    // Phase 3: best-effort recent orders (non-fatal).
    let recentOrders: SubscriptionRecentOrder[] = [];
    try {
      const tokenPlanCommodityCodes = [
        site.features.tokenPlanCommodityCodes.teams,
        site.features.tokenPlanCommodityCodes.addon,
      ]
        .filter(Boolean)
        .join(',');
      const ordersResult = await this.listOrders({
        page: 1,
        pageSize: 3,
        expandDetail: false,
        commodityCodeList:
          wantToken && tokenPlanCommodityCodes ? tokenPlanCommodityCodes : undefined,
      });
      recentOrders = ordersResult.orders.map((o) => ({
        orderId: o.orderId,
        orderType: o.orderType,
        orderTime: o.orderTime,
        amount: o.amount,
        status: o.status,
      }));
    } catch {
      // Non-fatal: recent orders are supplementary.
    }

    const data = this.assembleStatus(lookup, recentOrders);
    return { data, diagnostics };
  }

  async listOrders(opts: ListOrdersOptions): Promise<SubscriptionOrdersResult> {
    const cacheKey = `orders:${opts.from ?? ''}:${opts.to ?? ''}:${opts.type ?? ''}:${opts.page}:${opts.pageSize}:${opts.commodityCodeList ?? ''}`;

    const nbId = await this.resolveNbId();

    const params: Record<string, unknown> = {
      CurrentPage: opts.page,
      PageSize: opts.pageSize,
    };
    if (nbId) params.Nbid = nbId;
    if (opts.from) {
      const start = new Date(`${opts.from}T00:00:00`).getTime();
      if (Number.isFinite(start)) params.startDate = start;
    }
    if (opts.to) {
      const end = new Date(`${opts.to}T23:59:59.999`).getTime();
      if (Number.isFinite(end)) params.endDate = end;
    }
    if (opts.type) {
      const TYPE_TO_API: Record<string, string> = {
        purchase: 'BUY',
        renew: 'RENEW',
        upgrade: 'UPGRADE',
      };
      params.OrderType = TYPE_TO_API[opts.type] ?? opts.type.toUpperCase();
    }
    if (opts.commodityCodeList) params.CommodityCodeList = opts.commodityCodeList;

    const listRaw = await this.cache.getOrFetch(cacheKey, ORDERS_CACHE_TTL_MS, async () =>
      this.apiClient.callFlatApi<QueryOrderListResponse>({
        product: API_PRODUCT_BSS,
        action: 'QueryOrderList',
        params,
      }),
    );

    // Surface upstream authentication failure (or any other inner business
    // error) as a CliError instead of silently returning an empty list.
    const unavailable = detectOrderApiUnavailable(listRaw);
    if (unavailable) throw unavailable;

    const dto = this.subscriptionAdapter.transformOrderList(listRaw);

    const orders =
      opts.expandDetail && dto.orders.length > 0
        ? await this.expandOrderDetails(dto.orders)
        : dto.orders;

    const result: SubscriptionOrders = {
      orders,
      pagination: {
        page: dto.pagination.currentPage || opts.page,
        pageSize: dto.pagination.pageSize || opts.pageSize,
        total: dto.pagination.totalCount,
      },
    };
    return result;
  }

  /** Fetch a single order detail. */
  async getOrderDetail(orderId: string): Promise<OrderDetail> {
    const raw = await this.apiClient.callFlatApi<QueryOrderDetailResponse>({
      product: API_PRODUCT_BSS,
      action: 'QueryOrderDetail',
      params: { OrderId: orderId },
    });
    const unavailable = detectOrderApiUnavailable(
      raw as unknown as { Code?: string; Message?: string; Data?: unknown },
    );
    if (unavailable) throw unavailable;
    return this.subscriptionAdapter.transformOrderDetail(raw);
  }

  /** Concurrency-bounded eager detail expansion. */
  private async expandOrderDetails(items: SubscriptionOrder[]): Promise<SubscriptionOrder[]> {
    const result: SubscriptionOrder[] = items.slice();
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        const order = items[idx]!;
        if (!order.orderId) continue;
        try {
          const raw = await this.apiClient.callFlatApi<QueryOrderDetailResponse>({
            product: API_PRODUCT_BSS,
            action: 'QueryOrderDetail',
            params: { OrderId: order.orderId },
          });
          const unavailable = detectOrderApiUnavailable(
            raw as unknown as { Code?: string; Message?: string; Data?: unknown },
          );
          if (unavailable) throw unavailable;
          const enriched = this.subscriptionAdapter.transformOrderDetail(raw);
          result[idx] = { ...order, detail: enriched, detailError: null };
        } catch (error) {
          if (error instanceof CliError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          result[idx] = { ...order, detailError: message };
        }
      }
    };

    const pool = Math.min(DETAIL_CONCURRENCY, items.length);
    await Promise.all(Array.from({ length: pool }, () => worker()));
    return result;
  }

  private async resolveNbId(): Promise<string | null> {
    if (this.cachedNbId && Date.now() - this.nbIdTimestamp < NBID_CACHE_TTL_MS) {
      return this.cachedNbId;
    }
    try {
      const raw = await this.apiClient.callFlatApi<Record<string, unknown>>({
        product: API_PRODUCT_ACCOUNT_CENTER,
        action: 'QueryAccountBaseInfoApi',
        params: {},
      });
      const inner =
        raw?.Data && typeof raw.Data === 'object' ? (raw.Data as Record<string, unknown>) : raw;
      const nbId = inner?.NbId;
      if (typeof nbId === 'string' || typeof nbId === 'number') {
        this.cachedNbId = String(nbId);
        this.nbIdTimestamp = Date.now();
        return this.cachedNbId;
      }
    } catch {
      // Credential resolution failure is non-fatal; the order query may still
      // succeed on accounts that do not require it.
    }
    return null;
  }

  private assembleStatus(
    lookup: Map<string, unknown>,
    recentOrders: SubscriptionRecentOrder[] = [],
  ): SubscriptionStatus {
    const grayDto = this.subscriptionAdapter.transformSubscriptionGray(
      lookup.get('QuerySubscriptionGray') as QuerySubscriptionGrayResponse | undefined,
    );
    const seatRaw = lookup.get('GetSeatSubscriptionSummary') as
      | GetSeatSubscriptionSummaryResponse
      | undefined;
    const seatDto = this.subscriptionAdapter.transformSeatSubscriptionSummary(seatRaw);
    const detailDto = this.subscriptionAdapter.transformSubscriptionDetail(
      lookup.get('GetSubscriptionDetail') as GetSubscriptionDetailResponse | undefined,
    );
    const autoRenewDto = this.subscriptionAdapter.transformAutoRenewal(
      lookup.get('CheckTokenPlanAutoRenewal') as CheckTokenPlanAutoRenewalResponse | undefined,
    );
    const renewableDto = this.subscriptionAdapter.transformInstancesRenewable(
      lookup.get('CheckInstancesRenewable') as CheckInstancesRenewableResponse | undefined,
    );
    const frAddonRaw = lookup.get('DescribeFrInstances-addon') as FrInstanceResponse | undefined;
    const tokenPlanDto = lookup.get('TokenPlan') as TokenPlan | undefined;
    const quota = quotaFromTokenPlan(tokenPlanDto);

    const detailActive = detailDto.activeInstance;
    const plan = detailActive?.plan ?? seatDto.plan ?? tokenPlanDto?.planName ?? null;
    const period = detailActive?.period ?? seatDto.period ?? null;

    const seatInner = seatRaw?.Data ?? seatRaw;
    const seatTiersRaw = extractSeatTiers(seatInner);
    const seatTiers = seatTiersRaw.some((tier) => tier.totalCredits > 0)
      ? seatTiersRaw
      : syntheticSeatTierFromTokenPlan(tokenPlanDto);
    const remainingDays = extractRemainingDays(seatInner);
    const creditPacks = extractCreditPacks(frAddonRaw);
    return {
      isGray: grayDto.isGray,
      plan,
      period,
      quota,
      autoRenew: autoRenewDto.autoRenew,
      renewable: renewableDto.renewable,
      remainingDays,
      seatTiers,
      creditPacks,
      recentOrders,
    };
  }
}

// Raw-response extractors.

function extractRemainingDays(
  inner: { RemainingDays?: number | string } | null | undefined,
): number | null {
  if (!inner) return null;
  const raw = inner.RemainingDays;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSeatTiers(
  inner:
    | { SubscriptionGroupList?: GetSeatSubscriptionSummaryResponse['SubscriptionGroupList'] }
    | null
    | undefined,
): SubscriptionSeatTier[] {
  const groups = inner?.SubscriptionGroupList;
  if (!Array.isArray(groups) || groups.length === 0) return [];
  const tiers: SubscriptionSeatTier[] = [];
  for (const group of groups) {
    if (!group) continue;
    const equity = group.EquityList?.[0];
    const total = parseFloat(equity?.TotalValue ?? group.TotalValue ?? '0');
    const remaining = parseFloat(equity?.SurplusValue ?? group.SurplusValue ?? '0');
    const safeTotal = Number.isFinite(total) ? total : 0;
    const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
    const used = Math.max(0, safeTotal - safeRemaining);
    const usedPct =
      safeTotal > 0 ? Math.min(100, Math.max(0, Math.round((used / safeTotal) * 100))) : 0;
    let flush: string | null = null;
    const rawFlush = group.NextCycleFlushTime;
    if (typeof rawFlush === 'number' && Number.isFinite(rawFlush)) {
      flush = new Date(rawFlush).toISOString();
    } else if (typeof rawFlush === 'string' && rawFlush.length > 0) {
      flush = rawFlush;
    }
    tiers.push({
      specType: group.SpecType ?? '',
      seats: typeof group.SubscriptionTotalNumber === 'number' ? group.SubscriptionTotalNumber : 0,
      totalCredits: safeTotal,
      remainingCredits: safeRemaining,
      usedPct,
      nextCycleFlushTime: flush,
    });
  }
  return tiers;
}

function extractCreditPacks(raw: FrInstanceResponse | null | undefined): SubscriptionCreditPack[] {
  if (!raw || !Array.isArray(raw.Data) || raw.Data.length === 0) return [];
  const packs: SubscriptionCreditPack[] = [];
  for (const item of raw.Data) {
    if (!item) continue;
    const statusCode =
      item.StatusCode ?? (typeof item.Status === 'string' ? item.Status : item.Status?.Code);
    if (statusCode !== 'valid') continue;
    const total = parseFloat(item.InitCapacityBaseValue ?? '0');
    const remaining = parseFloat(item.CurrCapacityBaseValue ?? '0');
    let expiresAt: string | null = null;
    if (typeof item.EndTime === 'number' && Number.isFinite(item.EndTime)) {
      expiresAt = new Date(item.EndTime).toISOString();
    }
    packs.push({
      instanceId: item.InstanceId ?? '',
      totalCredits: Number.isFinite(total) ? total : 0,
      remainingCredits: Number.isFinite(remaining) ? remaining : 0,
      expiresAt,
    });
  }
  return packs;
}
