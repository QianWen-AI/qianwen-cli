/** Subscription orchestration service. */
import type { ApiClient } from '../api/api-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type {
  CheckInstancesRenewableResponse,
  CheckTokenPlanAutoRenewalResponse,
  FrInstanceResponse,
  GetSeatSubscriptionSummaryResponse,
  GetSubscriptionDetailResponse,
  GetSubscriptionSummaryResponse,
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
import type {
  TokenPlanEditionStatus,
  TokenPlanSeatDetails,
} from '../types/tokenplan-subscription.js';
import {
  fetchTokenPlanSeatDetails,
  resolveTokenPlanSeatAssignments,
} from './tokenplan-seat-details.js';
import type { TokenplanService } from './tokenplan-service.js';
import {
  buildTeamRenewable,
  enrichTeamTokenPlan,
  type TokenPlanEditionResult,
} from './tokenplan-service.js';
import { site } from '../site.js';
import { API_PRODUCT_ACCOUNT_CENTER } from '../types/api-routes.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { sumAmountStrings } from '../utils/amount.js';
import { safeSubscriptionDiagnostic, safeSubscriptionError } from './subscription-diagnostics.js';

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
  invoke: (signal: AbortSignal) => Promise<T>;
}

interface SubCallResult<T> {
  api: string;
  data: T | null;
  diagnostic: SubscriptionDiagnostic | null;
}

function toDiagnostic(api: string, error: unknown): SubscriptionDiagnostic {
  return safeSubscriptionDiagnostic(api, error);
}

function totalFailureExitCode(diagnostics: SubscriptionDiagnostic[]): 1 | 2 | 3 | 4 {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.errorCode));
  if (codes.has('CONFIG_ERROR') || codes.has('PROTOCOL_ERROR')) return 4;
  if (
    codes.has('AUTH_REQUIRED') ||
    codes.has('TOKEN_EXPIRED') ||
    codes.has('CS_DATA_AUTH_REQUIRED')
  )
    return 2;
  if (codes.has('NETWORK_ERROR') || codes.has('Timeout')) return 3;
  return 1;
}

async function runWithSoftTimeout(
  calls: Array<SubCallSpec<unknown>>,
  timeoutMs: number,
): Promise<Array<SubCallResult<unknown>>> {
  const controller = new AbortController();
  let active = true;
  const settled = new Set<number>();
  const results: Array<SubCallResult<unknown>> = calls.map((c) => ({
    api: c.api,
    data: null,
    diagnostic: null,
  }));

  const tasks = calls.map(async (c, idx) => {
    try {
      const data = await c.invoke(controller.signal);
      if (active) results[idx]!.data = data;
    } catch (error) {
      if (active) results[idx]!.diagnostic = toDiagnostic(c.api, error);
    } finally {
      settled.add(idx);
    }
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(), timeoutMs);
  });

  await Promise.race([Promise.allSettled(tasks), timeoutPromise]);
  active = false;
  controller.abort();
  if (timeoutHandle) clearTimeout(timeoutHandle);

  for (const [index, result] of results.entries()) {
    if (!settled.has(index)) {
      result.diagnostic = {
        api: result.api,
        errorCode: 'Timeout',
        errorMessage: 'The service did not respond in time. Try again later.',
      };
    }
  }
  return results;
}

function quotaFromValues(
  total: number | null | undefined,
  remaining: number | null | undefined,
): SubscriptionQuota | null {
  if (
    typeof total !== 'number' ||
    typeof remaining !== 'number' ||
    !Number.isFinite(total) ||
    !Number.isFinite(remaining) ||
    total < 0 ||
    remaining < 0 ||
    remaining > total
  )
    return null;
  const usedPct = total === 0 ? 0 : Math.round(((total - remaining) / total) * 100);
  return { remaining, total, usedPct };
}

function quotaFromSeatValues(
  groups: Array<{ totalValue: string | null; surplusValue: string | null }>,
): SubscriptionQuota | null {
  if (groups.length === 0) return null;
  const totals: string[] = [];
  const remainingValues: string[] = [];
  for (const group of groups) {
    if (group.totalValue === null || group.surplusValue === null) return null;
    const quota = quotaFromValues(Number(group.totalValue), Number(group.surplusValue));
    if (!quota) return null;
    totals.push(group.totalValue);
    remainingValues.push(group.surplusValue);
  }
  return quotaFromValues(
    Number(sumAmountStrings(totals)),
    Number(sumAmountStrings(remainingValues)),
  );
}

function quotaFromTokenPlan(
  dto: TokenPlan | null | undefined,
  team?: TokenPlanEditionStatus,
): SubscriptionQuota | null {
  if (!dto || dto.subscribed !== true) return null;
  if (team && team.status !== 'active') return null;
  if (
    team?.diagnostics.some(
      (entry) => entry.api === 'GetSubscriptionSummary' && entry.errorCode === 'InvalidFields',
    )
  )
    return null;
  const legacyQuota = quotaFromValues(dto.totalCredits, dto.remainingCredits);
  const summary = team?.seatSummary;
  if (!summary) return legacyQuota;
  const total = summary.total;
  const completeTotal = total !== null && total.totalValue !== null && total.surplusValue !== null;
  const totalQuota = completeTotal ? quotaFromSeatValues([total]) : null;
  if (completeTotal && !totalQuota) return null;
  const invalidGroup = team.diagnostics.some(
    (entry) => entry.api === 'GetSeatSubscriptionSummary' && entry.errorCode === 'InvalidGroup',
  );
  const groupQuota = invalidGroup ? null : quotaFromSeatValues(summary.groups);
  if (
    totalQuota &&
    groupQuota &&
    (totalQuota.total !== groupQuota.total || totalQuota.remaining !== groupQuota.remaining)
  )
    return null;
  if (totalQuota || groupQuota) return totalQuota ?? groupQuota;
  if (invalidGroup || summary.groups.length > 0 || !legacyQuota) return null;
  if (
    total &&
    ((total.totalValue !== null && Number(total.totalValue) !== legacyQuota.total) ||
      (total.surplusValue !== null && Number(total.surplusValue) !== legacyQuota.remaining))
  )
    return null;
  return legacyQuota;
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

function hasConfirmedStatusData(data: SubscriptionStatus): boolean {
  return (
    data.individual?.status === 'active' ||
    data.individual?.status === 'not_subscribed' ||
    data.team?.status === 'active' ||
    data.team?.status === 'not_subscribed' ||
    data.isGray !== null ||
    data.plan !== null ||
    data.period !== null ||
    data.quota !== null ||
    data.autoRenew !== null ||
    data.renewable !== null ||
    data.remainingDays !== null ||
    data.seatTiers.length > 0 ||
    data.creditPacks.length > 0 ||
    data.recentOrders.length > 0
  );
}

function detectOrderApiUnavailable(
  raw: { Code?: string; Message?: string; Data?: unknown } | null | undefined,
): CliError | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.Data !== undefined) return null;
  const code = typeof raw.Code === 'string' ? raw.Code : '';
  if (!code) return null;
  if (['FEATURE_UNAVAILABLE', 'NOT_SUPPORTED', 'UNSUPPORTED'].includes(code)) {
    return new CliError({
      code: 'FEATURE_UNAVAILABLE',
      message: 'Subscription order history is not available for this account.',
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
  }
  if (
    ['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'InvalidSecurityToken', 'Login.NotLogined'].includes(code)
  ) {
    return new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Authentication failed. Run: qianwen auth login',
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });
  }
  return new CliError({
    code: 'ORDER_RESPONSE_INVALID',
    message: 'Subscription orders could not be retrieved.',
    exitCode: EXIT_CODES.CONFIG_ERROR,
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
    let tokenPlanPromise: Promise<TokenPlanEditionResult> | undefined;
    const getTokenPlan = (signal: AbortSignal) =>
      (tokenPlanPromise ??= this.tokenplanService.fetchTokenPlanEditions(signal));

    const calls: Array<SubCallSpec<unknown>> = [
      {
        api: 'QuerySubscriptionGray',
        invoke: (signal) =>
          this.apiClient.callFlatApi<QuerySubscriptionGrayResponse>({
            product: API_PRODUCT_BSS,
            action: 'QuerySubscriptionGray',
            signal,
          }),
      },
    ];

    if (wantToken) {
      calls.push({
        api: 'TeamSeatDetails',
        invoke: (signal) => fetchTokenPlanSeatDetails(this.apiClient, signal),
      });
      calls.push({
        api: 'GetSeatSubscriptionSummary',
        invoke: (signal) =>
          this.apiClient.callFlatApi<GetSeatSubscriptionSummaryResponse>({
            product: API_PRODUCT_BSS,
            action: 'GetSeatSubscriptionSummary',
            signal,
            params: {
              productCode: site.features.tokenPlanCommodityCodes.teams,
            },
          }),
      });
      calls.push({
        api: 'TokenPlan',
        invoke: getTokenPlan,
      });
      calls.push({
        api: 'GetSubscriptionSummary',
        invoke: (signal) =>
          this.apiClient.callFlatApi<GetSubscriptionSummaryResponse>({
            product: API_PRODUCT_BSS,
            action: 'GetSubscriptionSummary',
            signal,
            params: { productCode: site.features.tokenPlanCommodityCodes.teams },
          }),
      });
      calls.push({
        api: 'DescribeFrInstances-addon',
        invoke: (signal) =>
          this.apiClient.callFlatApi<FrInstanceResponse>({
            product: API_PRODUCT_BSS,
            action: 'DescribeFrInstances',
            signal,
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
        invoke: (signal) =>
          this.apiClient.callFlatApi<CheckTokenPlanAutoRenewalResponse>({
            product: API_PRODUCT_BSS_LEGACY,
            action: 'CheckTokenPlanAutoRenewal',
            signal,
            params: {
              CommodityCode: site.features.tokenPlanCommodityCodes.teams,
            },
          }),
      });
      calls.push({
        api: 'CheckInstancesRenewable',
        invoke: async (signal) => {
          const { teamInstanceId } = await getTokenPlan(signal);
          if (!teamInstanceId) return null;
          return this.apiClient.callFlatApi<CheckInstancesRenewableResponse>({
            product: API_PRODUCT_BSS,
            action: 'CheckInstancesRenewable',
            signal,
            params: {
              'instanceIdentities.1.InstanceId': teamInstanceId,
              'instanceIdentities.1.CommodityCode': site.features.tokenPlanCommodityCodes.teams,
              'instanceIdentities.1.ResourceType': 'subscription',
            },
          });
        },
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

    // Supplementary seat details cannot turn a failed status query into success.
    if (results.filter((r) => r.api !== 'TeamSeatDetails').every((r) => r.diagnostic !== null)) {
      const details = lookup.get('TeamSeatDetails') as TokenPlanSeatDetails | undefined;
      diagnostics.push(...(details?.diagnostics ?? []));
      return {
        data: null,
        diagnostics,
        failureExitCode: totalFailureExitCode(diagnostics),
      };
    }

    // Phase 3: best-effort recent orders (non-fatal).
    let recentOrders: SubscriptionRecentOrder[] = [];
    try {
      const tokenPlanCommodityCodes = [
        site.features.tokenPlanCommodityCodes.teams,
        site.features.tokenPlanCommodityCodes.addon,
        site.features.tokenPlanCommodityCodes.soloBuy,
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
    diagnostics.push(...(data.individual?.diagnostics ?? []), ...(data.team?.diagnostics ?? []));
    diagnostics.push(...(data.team?.seatDetails?.diagnostics ?? []));
    if (!hasConfirmedStatusData(data)) {
      return {
        data: null,
        diagnostics,
        failureExitCode: totalFailureExitCode(diagnostics),
      };
    }
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

    let listRaw: QueryOrderListResponse;
    try {
      listRaw = await this.cache.getOrFetch(cacheKey, ORDERS_CACHE_TTL_MS, async () =>
        this.apiClient.callFlatApi<QueryOrderListResponse>({
          product: API_PRODUCT_BSS,
          action: 'QueryOrderList',
          params,
        }),
      );
    } catch (error) {
      throw safeSubscriptionError(error, 'Subscription orders could not be retrieved.');
    }

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
    let raw: QueryOrderDetailResponse;
    try {
      raw = await this.apiClient.callFlatApi<QueryOrderDetailResponse>({
        product: API_PRODUCT_BSS,
        action: 'QueryOrderDetail',
        params: { OrderId: orderId },
      });
    } catch (error) {
      throw safeSubscriptionError(error, 'Subscription order details could not be retrieved.');
    }
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
          result[idx] = {
            ...order,
            detailError: safeSubscriptionError(
              error,
              'Subscription order details could not be retrieved.',
            ).message,
          };
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
    const tokenPlanResult = lookup.get('TokenPlan') as TokenPlanEditionResult | undefined;
    const renewable = buildTeamRenewable(
      lookup.get('CheckInstancesRenewable'),
      tokenPlanResult?.teamInstanceId ?? null,
    );
    const frAddonRaw = lookup.get('DescribeFrInstances-addon') as FrInstanceResponse | undefined;
    const tokenPlanDto = tokenPlanResult?.tokenPlan;
    const individual = tokenPlanDto?.individual;
    const team = tokenPlanDto?.team
      ? enrichTeamTokenPlan(
          tokenPlanDto.team,
          seatRaw,
          lookup.get('GetSubscriptionSummary'),
          lookup.get('CheckTokenPlanAutoRenewal'),
        )
      : undefined;
    if (team)
      team.seatDetails = resolveTokenPlanSeatAssignments(
        lookup.get('TeamSeatDetails') as TokenPlanSeatDetails | undefined,
        team,
      );
    const quota = quotaFromTokenPlan(tokenPlanDto, team);

    const detailActive = detailDto.activeInstance;
    const plan = detailActive?.plan ?? seatDto.plan ?? tokenPlanDto?.planName ?? null;
    const period = detailActive?.period ?? seatDto.period ?? null;

    const seatInner = seatRaw?.Data ?? seatRaw;
    // When auto-renewal is explicitly OFF there is no next cycle, so seat-tier
    // nextCycleFlushTime (which the server still returns, equal to expiry) is
    // nulled to prevent it being read as a quota-reset date. null autoRenew is
    // "unknown" and must not trigger clearing.
    const seatTiersRaw = extractSeatTiers(seatInner, autoRenewDto.autoRenew);
    const seatTiers = seatTiersRaw.some(
      (tier) => tier.totalCredits !== null && tier.totalCredits > 0,
    )
      ? seatTiersRaw
      : syntheticSeatTierFromTokenPlan(tokenPlanDto);
    const remainingDays = extractRemainingDays(seatInner);
    const creditPacks = extractCreditPacks(frAddonRaw);
    return {
      individual,
      team,
      isGray: grayDto.isGray,
      plan: team ? team.name : plan,
      period: team ? team.period : period,
      quota,
      autoRenew: team ? (team.autoRenew?.enabled ?? null) : autoRenewDto.autoRenew,
      renewable: renewable?.canRenew ?? null,
      remainingDays: team ? team.remainingDays : remainingDays,
      seatTiers: team
        ? (team.seatSummary?.groups ?? []).map((group) => {
            const total = group.totalValue === null ? null : Number(group.totalValue);
            const remaining = group.surplusValue === null ? null : Number(group.surplusValue);
            return {
              specType: group.specType,
              seats: group.seats,
              totalCredits: total !== null && Number.isFinite(total) ? total : null,
              remainingCredits: remaining !== null && Number.isFinite(remaining) ? remaining : null,
              usedPct:
                total !== null && remaining !== null && total > 0 && remaining <= total
                  ? (1 - remaining / total) * 100
                  : null,
              nextCycleFlushTime: group.nextCycleFlushTime,
            };
          })
        : seatTiers,
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
  autoRenewEnabled: boolean | null,
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
    // Only resolve a flush time when auto-renewal is not explicitly disabled.
    if (autoRenewEnabled !== false) {
      const rawFlush = group.NextCycleFlushTime;
      if (typeof rawFlush === 'number' && Number.isFinite(rawFlush)) {
        flush = new Date(rawFlush).toISOString();
      } else if (typeof rawFlush === 'string' && rawFlush.length > 0) {
        flush = rawFlush;
      }
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
