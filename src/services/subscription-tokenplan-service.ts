/** Token Plan subscription orchestration. */
import type { ApiClient } from '../api/api-client.js';
import type {
  CheckInstancesRenewableResponse,
  CheckTokenPlanAutoRenewalResponse,
  FrInstanceResponse,
  GetSeatSubscriptionSummaryDataInner,
  GetSeatSubscriptionSummaryResponse,
  GetSubscriptionDetailDataInner,
  GetSubscriptionDetailResponse,
  GetSubscriptionSummaryDataInner,
  GetSubscriptionSummaryResponse,
  SeatSubscriptionGroupItem,
  SubscriptionDetailEquityItem,
  SubscriptionDetailItem,
} from '../types/api-models.js';
import type { SubscriptionDiagnostic } from '../types/subscription.js';
import type {
  ListTokenPlanSeatsParams,
  TokenPlanAutoRenew,
  TokenPlanPeriod,
  TokenPlanRenewable,
  TokenPlanSeatConfig,
  TokenPlanSeatCycle,
  TokenPlanSeatGroup,
  TokenPlanSeatItem,
  TokenPlanSeatTotal,
  TokenPlanSeatsResult,
  TokenPlanStatusResult,
} from '../types/tokenplan-subscription.js';
import { site } from '../site.js';

const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_PRODUCT_BSS_LEGACY = 'BssOpenApi';
const STATUS_SOFT_TIMEOUT_MS = 35_000;
const PRODUCT_LABEL = 'Token Plan Team Edition';
const SEATS_DEFAULT_PAGE = 1;
const SEATS_DEFAULT_PAGE_SIZE = 20;
const SEATS_MAX_PAGE_SIZE = 100;

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

/** Convert timestamp or string to ISO 8601 string; returns null if not coercible. */
function toIsoString(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

/** Unwrap a single nested .Data envelope when present. */
function unwrapDataEnvelope<T extends { Data?: unknown }, I>(raw: T | undefined): I | undefined {
  if (!raw) return undefined;
  const inner = (raw as { Data?: unknown }).Data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as I;
  }
  return raw as unknown as I;
}

export class SubscriptionTokenPlanService {
  constructor(private readonly apiClient: ApiClient) {}

  async getTokenPlanStatus(): Promise<TokenPlanStatusResult> {
    const productCode = site.features.tokenPlanCommodityCodes.teams;
    const diagnostics: SubscriptionDiagnostic[] = [];

    const instanceId = await this.resolveInstanceId(productCode);

    // Phase 1: run independent summary APIs in parallel.
    const phase1Calls: Array<SubCallSpec<unknown>> = [
      {
        api: 'GetSeatSubscriptionSummary',
        invoke: () =>
          this.apiClient.callFlatApi<GetSeatSubscriptionSummaryResponse>({
            product: API_PRODUCT_BSS,
            action: 'GetSeatSubscriptionSummary',
            params: { productCode },
          }),
      },
      {
        api: 'GetSubscriptionSummary',
        invoke: () =>
          this.apiClient.callFlatApi<GetSubscriptionSummaryResponse>({
            product: API_PRODUCT_BSS,
            action: 'GetSubscriptionSummary',
            params: { productCode },
          }),
      },
    ];

    if (instanceId) {
      phase1Calls.push(
        {
          api: 'CheckTokenPlanAutoRenewal',
          invoke: () =>
            this.apiClient.callFlatApi<CheckTokenPlanAutoRenewalResponse>({
              product: API_PRODUCT_BSS_LEGACY,
              action: 'CheckTokenPlanAutoRenewal',
              params: { CommodityCode: productCode },
            }),
        },
        {
          api: 'CheckInstancesRenewable',
          invoke: () =>
            this.apiClient.callFlatApi<CheckInstancesRenewableResponse>({
              product: API_PRODUCT_BSS,
              action: 'CheckInstancesRenewable',
              params: {
                'instanceIdentities.1.InstanceId': instanceId,
                'instanceIdentities.1.CommodityCode': productCode,
                'instanceIdentities.1.ResourceType': 'subscription',
              },
            }),
        },
      );
    } else {
      const skipMessage = 'Skipped: InstanceId unavailable from DescribeFrInstances';
      diagnostics.push(
        { api: 'CheckTokenPlanAutoRenewal', errorCode: 'Skipped', errorMessage: skipMessage },
        { api: 'CheckInstancesRenewable', errorCode: 'Skipped', errorMessage: skipMessage },
      );
    }

    const results = await runWithSoftTimeout(phase1Calls, STATUS_SOFT_TIMEOUT_MS);

    const lookup = new Map<string, unknown>();
    for (const r of results) {
      if (r.diagnostic) diagnostics.push(r.diagnostic);
      if (r.data !== null) lookup.set(r.api, r.data);
    }

    return this.assembleTokenPlanStatus(lookup, diagnostics);
  }

  private async resolveInstanceId(productCode: string): Promise<string | null> {
    try {
      const raw = await this.apiClient.callFlatApi<FrInstanceResponse>({
        product: API_PRODUCT_BSS,
        action: 'DescribeFrInstances',
        params: {
          Group: 'tokenPlan',
          CommodityCode: productCode,
          PageNum: 1,
          PageSize: 10,
        },
      });
      const list = Array.isArray(raw?.Data) ? raw.Data : [];
      for (const item of list) {
        if (typeof item?.InstanceId === 'string' && item.InstanceId.length > 0) {
          return item.InstanceId;
        }
      }
    } catch {
      // best-effort
    }
    return null;
  }

  private assembleTokenPlanStatus(
    lookup: Map<string, unknown>,
    diagnostics: SubscriptionDiagnostic[],
  ): TokenPlanStatusResult {
    const seatSummaryRaw = lookup.get('GetSeatSubscriptionSummary') as
      | GetSeatSubscriptionSummaryResponse
      | undefined;
    const subscriptionSummaryRaw = lookup.get('GetSubscriptionSummary') as
      | GetSubscriptionSummaryResponse
      | undefined;
    const autoRenewalRaw = lookup.get('CheckTokenPlanAutoRenewal') as
      | CheckTokenPlanAutoRenewalResponse
      | undefined;
    const renewableRaw = lookup.get('CheckInstancesRenewable') as
      | CheckInstancesRenewableResponse
      | undefined;

    const seatInner = unwrapDataEnvelope<
      GetSeatSubscriptionSummaryResponse,
      GetSeatSubscriptionSummaryDataInner
    >(seatSummaryRaw);
    const subscriptionInner = unwrapDataEnvelope<
      GetSubscriptionSummaryResponse,
      GetSubscriptionSummaryDataInner
    >(subscriptionSummaryRaw);

    const period = this.buildPeriod(seatInner);
    const groups = this.buildSeatGroups(seatInner);
    const total = this.buildSeatTotal(subscriptionInner);
    const autoRenew = this.buildAutoRenew(autoRenewalRaw);
    const renewable = this.buildRenewable(renewableRaw);

    // seatSummary is null when GetSeatSubscriptionSummary failed.
    const seatSummary = seatSummaryRaw === undefined ? null : { groups, total };

    return {
      product: PRODUCT_LABEL,
      period,
      autoRenew,
      renewable,
      seatSummary,
      diagnostics,
    };
  }

  private buildPeriod(
    inner: GetSeatSubscriptionSummaryDataInner | undefined,
  ): TokenPlanPeriod | null {
    if (!inner) return null;
    const start = toIsoString(inner.StartTime ?? inner.PeriodStart);
    const end = toIsoString(inner.EndTime ?? inner.PeriodEnd);
    if (!start || !end) return null;
    const remainingDays =
      typeof inner.RemainingDays === 'number'
        ? inner.RemainingDays
        : typeof inner.RemainingDays === 'string'
          ? parseInt(inner.RemainingDays, 10) || 0
          : 0;
    return { start, end, remainingDays };
  }

  private buildSeatGroups(
    inner: GetSeatSubscriptionSummaryDataInner | undefined,
  ): TokenPlanSeatGroup[] {
    if (!inner || !Array.isArray(inner.SubscriptionGroupList)) return [];
    return inner.SubscriptionGroupList.map((group: SeatSubscriptionGroupItem) => {
      const equity = Array.isArray(group.EquityList) ? group.EquityList[0] : undefined;
      const totalValue = equity?.TotalValue ?? group.TotalValue ?? '0';
      const surplusValue = equity?.SurplusValue ?? group.SurplusValue ?? '0';
      return {
        specType: group.SpecType ?? 'unknown',
        seats: group.SubscriptionTotalNumber ?? 0,
        assigned: group.SubscriptionAssignedNumber ?? 0,
        totalValue,
        surplusValue,
        unit: 'Credits',
        nextCycleFlushTime: toIsoString(group.NextCycleFlushTime),
      };
    });
  }

  private buildSeatTotal(
    inner: GetSubscriptionSummaryDataInner | undefined,
  ): TokenPlanSeatTotal | null {
    if (!inner) return null;
    return {
      seats: inner.TotalCount ?? 0,
      totalValue: inner.TotalValue ?? '0',
      surplusValue: inner.TotalSurplusValue ?? '0',
      unit: 'Credits',
    };
  }

  private buildAutoRenew(
    raw: CheckTokenPlanAutoRenewalResponse | undefined,
  ): TokenPlanAutoRenew | null {
    if (!raw) return null;
    const autoRenewalValue = raw.Data?.AutoRenewal ?? raw.AutoRenewal;
    const enabled =
      typeof autoRenewalValue === 'number'
        ? autoRenewalValue === 1
        : typeof autoRenewalValue === 'boolean'
          ? autoRenewalValue
          : false;
    const period = raw.Data?.RenewalPeriod ?? 0;
    const periodUnit = raw.Data?.RenewalPeriodUnit ?? '';
    return { enabled, period, periodUnit };
  }

  private buildRenewable(
    raw: CheckInstancesRenewableResponse | undefined,
  ): TokenPlanRenewable | null {
    if (!raw) return null;
    const item = Array.isArray(raw.Data) && raw.Data.length > 0 ? raw.Data[0] : null;
    if (item) {
      const canRenew = item.CanRenew ?? item.canRenew ?? false;
      const interceptCode = item.InterceptCode ?? null;
      return { canRenew, interceptCode };
    }
    const canRenew = raw.Renewable ?? false;
    return { canRenew, interceptCode: null };
  }

  // Seats listing

  async listTokenPlanSeats(params: ListTokenPlanSeatsParams = {}): Promise<TokenPlanSeatsResult> {
    const productCode = site.features.tokenPlanCommodityCodes.teams;
    const diagnostics: SubscriptionDiagnostic[] = [];

    const requestedPage = Number.isFinite(params.page) ? Number(params.page) : SEATS_DEFAULT_PAGE;
    const pageNo = Math.max(1, Math.trunc(requestedPage));
    const requestedPageSize = Number.isFinite(params.pageSize)
      ? Number(params.pageSize)
      : SEATS_DEFAULT_PAGE_SIZE;
    const pageSize = Math.max(1, Math.min(SEATS_MAX_PAGE_SIZE, Math.trunc(requestedPageSize)));
    const specType =
      typeof params.specType === 'string' && params.specType.length > 0 ? params.specType : null;

    const apiParams: Record<string, unknown> = { productCode, pageNo, pageSize };
    if (specType) apiParams.specType = specType;

    // Network errors propagate to the caller.
    const raw = await this.apiClient.callFlatApi<GetSubscriptionDetailResponse>({
      product: API_PRODUCT_BSS,
      action: 'GetSubscriptionDetail',
      params: apiParams,
    });

    if (raw && (raw as GetSubscriptionDetailResponse).Success === false) {
      const code = (raw as GetSubscriptionDetailResponse).Code;
      const suffix = code ? ` (${code})` : '';
      throw new Error(`InternalError: Backend unavailable${suffix}`);
    }

    const inner = this.unwrapDetailEnvelope(raw);
    const list = inner?.SubscriptionList ?? [];
    const items = list.map((entry) => this.buildSeatItem(entry, diagnostics));

    // Client-side fallback filter.
    const filteredItems = specType
      ? items.filter((it) => it.specType.toLowerCase() === specType.toLowerCase())
      : items;

    const total = typeof inner?.TotalCount === 'number' ? inner.TotalCount : filteredItems.length;

    return {
      page: { current: pageNo, size: pageSize, total },
      filter: { specType },
      items: filteredItems,
      diagnostics,
    };
  }

  private unwrapDetailEnvelope(
    raw: GetSubscriptionDetailResponse | undefined,
  ): GetSubscriptionDetailDataInner | undefined {
    if (!raw) return undefined;
    const data = raw.Data;
    if (data && !Array.isArray(data) && typeof data === 'object') {
      return data as GetSubscriptionDetailDataInner;
    }
    if (Array.isArray(data)) {
      return {
        SubscriptionList: data,
        TotalCount: raw.TotalCount,
        PageSize: raw.PageSize,
        CurrentPage: raw.CurrentPage,
      };
    }
    return undefined;
  }

  private buildSeatItem(
    entry: SubscriptionDetailItem,
    diagnostics: SubscriptionDiagnostic[],
  ): TokenPlanSeatItem {
    const instanceCode = entry.InstanceCode ?? entry.InstanceId ?? '';
    const cycle = this.buildSeatCycle(entry, instanceCode, diagnostics);
    const config = this.buildSeatConfig(entry, instanceCode, diagnostics);
    return {
      instanceCode,
      specType: entry.SpecType ?? '',
      status: entry.Status ?? '',
      memberId: entry.MemberId ?? '',
      assignable: entry.Assignable === true,
      assignment: entry.MemberId ? 'Assigned' : 'Unassigned',
      payMode: entry.PayMode ?? '',
      productType: entry.ProductType ?? '',
      cycle,
      config,
    };
  }

  private buildSeatCycle(
    entry: SubscriptionDetailItem,
    instanceCode: string,
    diagnostics: SubscriptionDiagnostic[],
  ): TokenPlanSeatCycle | null {
    const list: SubscriptionDetailEquityItem[] = Array.isArray(entry.EquityList)
      ? entry.EquityList
      : [];
    const equity = list[0];
    if (!equity) {
      diagnostics.push({
        api: 'GetSubscriptionDetail',
        errorCode: 'EquityListEmpty',
        errorMessage: `EquityList empty for instance ${instanceCode}`,
      });
      return null;
    }
    return {
      startTime: toIsoString(equity.CycleStartTime),
      endTime: toIsoString(equity.CycleEndTime),
      totalValue: equity.CycleTotalValue ?? equity.TotalValue ?? '0',
      surplusValue: equity.CycleSurplusValue ?? equity.SurplusValue ?? '0',
      unit: equity.Unit ?? 'Credits',
    };
  }

  private buildSeatConfig(
    entry: SubscriptionDetailItem,
    instanceCode: string,
    diagnostics: SubscriptionDiagnostic[],
  ): TokenPlanSeatConfig | null {
    const rawConfig = entry.Config;
    if (typeof rawConfig !== 'string' || rawConfig.length === 0) {
      if (typeof rawConfig === 'string') {
        diagnostics.push({
          api: 'GetSubscriptionDetail',
          errorCode: 'ConfigEmpty',
          errorMessage: `Config empty for instance ${instanceCode}`,
        });
      }
      return null;
    }
    try {
      let parsed: unknown = JSON.parse(rawConfig);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Config payload is not an object');
      }
      const obj = parsed as Record<string, unknown>;
      return {
        planType: typeof obj.plan_type === 'string' ? obj.plan_type : null,
        creditValue: typeof obj.credit_value === 'number' ? obj.credit_value : null,
        seatNum: typeof obj.seat_num === 'number' ? obj.seat_num : null,
        quotaCycle: typeof obj.quota_cycle === 'string' ? obj.quota_cycle : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        api: 'GetSubscriptionDetail',
        errorCode: 'ConfigParseFailed',
        errorMessage: `Config parse failed for instance ${instanceCode}: ${message}`,
      });
      return null;
    }
  }
}
