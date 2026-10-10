/** Token Plan subscription orchestration. */
import type { ApiClient } from '../api/api-client.js';
import type {
  CheckInstancesRenewableResponse,
  CheckTokenPlanAutoRenewalResponse,
  GetSeatSubscriptionSummaryResponse,
  GetSubscriptionDetailDataInner,
  GetSubscriptionDetailResponse,
  GetSubscriptionSummaryResponse,
  SubscriptionDetailEquityItem,
  SubscriptionDetailItem,
} from '../types/api-models.js';
import type { SubscriptionDiagnostic } from '../types/subscription.js';
import type {
  ListTokenPlanSeatsParams,
  TokenPlanSeatConfig,
  TokenPlanSeatCycle,
  TokenPlanSeatItem,
  TokenPlanSeatDetails,
  TokenPlanSeatsResult,
  TokenPlanStatusResult,
} from '../types/tokenplan-subscription.js';
import { site } from '../site.js';
import {
  buildTeamRenewable,
  enrichTeamTokenPlan,
  fetchIndividualTokenPlan,
  fetchTeamTokenPlan,
  unknownTokenPlanEdition,
  type TeamTokenPlanResult,
} from './tokenplan-service.js';
import type { TokenPlanEditionStatus } from '../types/tokenplan-subscription.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import {
  fetchTokenPlanSeatDetails,
  resolveTokenPlanSeatAssignments,
} from './tokenplan-seat-details.js';
import {
  safeSubscriptionDiagnostic,
  safeSubscriptionError,
  subscriptionProtocolDiagnostic,
} from './subscription-diagnostics.js';

const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_PRODUCT_BSS_LEGACY = 'BssOpenApi';
const STATUS_SOFT_TIMEOUT_MS = 35_000;
const PRODUCT_LABEL = 'Token Plan Team Edition';
const SEATS_DEFAULT_PAGE = 1;
const SEATS_DEFAULT_PAGE_SIZE = 20;
const SEATS_MAX_PAGE_SIZE = 100;

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

/** Convert timestamp or string to ISO 8601 string; returns null if not coercible. */
function toIsoString(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

export class SubscriptionTokenPlanService {
  constructor(private readonly apiClient: ApiClient) {}

  async getTokenPlanStatus(): Promise<TokenPlanStatusResult> {
    const productCode = site.features.tokenPlanCommodityCodes.teams;
    const diagnostics: SubscriptionDiagnostic[] = [];

    let teamPromise: Promise<TeamTokenPlanResult> | undefined;
    const getTeam = (signal: AbortSignal) =>
      (teamPromise ??= fetchTeamTokenPlan(this.apiClient, signal));

    // Phase 1: run independent summary APIs in parallel.
    const phase1Calls: Array<SubCallSpec<unknown>> = [
      {
        api: 'IndividualSubscription',
        invoke: (signal) => fetchIndividualTokenPlan(this.apiClient, signal),
      },
      { api: 'TeamInstances', invoke: getTeam },
      {
        api: 'TeamSeatDetails',
        invoke: (signal) => fetchTokenPlanSeatDetails(this.apiClient, signal),
      },
      {
        api: 'GetSeatSubscriptionSummary',
        invoke: (signal) =>
          this.apiClient.callFlatApi<GetSeatSubscriptionSummaryResponse>({
            product: API_PRODUCT_BSS,
            action: 'GetSeatSubscriptionSummary',
            signal,
            params: { productCode },
          }),
      },
      {
        api: 'GetSubscriptionSummary',
        invoke: (signal) =>
          this.apiClient.callFlatApi<GetSubscriptionSummaryResponse>({
            product: API_PRODUCT_BSS,
            action: 'GetSubscriptionSummary',
            signal,
            params: { productCode },
          }),
      },
    ];

    phase1Calls.push(
      {
        api: 'CheckTokenPlanAutoRenewal',
        invoke: (signal) =>
          this.apiClient.callFlatApi<CheckTokenPlanAutoRenewalResponse>({
            product: API_PRODUCT_BSS_LEGACY,
            action: 'CheckTokenPlanAutoRenewal',
            signal,
            params: { CommodityCode: productCode },
          }),
      },
      {
        api: 'CheckInstancesRenewable',
        invoke: async (signal) => {
          const { instanceId } = await getTeam(signal);
          if (!instanceId) return null;
          return this.apiClient.callFlatApi<CheckInstancesRenewableResponse>({
            product: API_PRODUCT_BSS,
            action: 'CheckInstancesRenewable',
            signal,
            params: {
              'instanceIdentities.1.InstanceId': instanceId,
              'instanceIdentities.1.CommodityCode': productCode,
              'instanceIdentities.1.ResourceType': 'subscription',
            },
          });
        },
      },
    );

    const results = await runWithSoftTimeout(phase1Calls, STATUS_SOFT_TIMEOUT_MS);

    const lookup = new Map<string, unknown>();
    for (const r of results) {
      if (r.diagnostic) diagnostics.push(r.diagnostic);
      if (r.data !== null) lookup.set(r.api, r.data);
    }

    return this.assembleTokenPlanStatus(lookup, diagnostics);
  }

  private assembleTokenPlanStatus(
    lookup: Map<string, unknown>,
    diagnostics: SubscriptionDiagnostic[],
  ): TokenPlanStatusResult {
    const individual =
      (lookup.get('IndividualSubscription') as TokenPlanEditionStatus | undefined) ??
      unknownTokenPlanEdition('individual');
    const teamInstances = lookup.get('TeamInstances') as TeamTokenPlanResult | undefined;
    const team = enrichTeamTokenPlan(
      teamInstances?.team ?? unknownTokenPlanEdition('team'),
      lookup.get('GetSeatSubscriptionSummary'),
      lookup.get('GetSubscriptionSummary'),
      lookup.get('CheckTokenPlanAutoRenewal'),
    );
    const renewable = buildTeamRenewable(
      lookup.get('CheckInstancesRenewable'),
      teamInstances?.instanceId ?? null,
    );
    team.seatDetails = resolveTokenPlanSeatAssignments(
      lookup.get('TeamSeatDetails') as TokenPlanSeatDetails | undefined,
      team,
    );
    return {
      individual,
      team,
      product: PRODUCT_LABEL,
      period: team.period,
      autoRenew: team.autoRenew,
      renewable,
      seatSummary: team.seatSummary,
      diagnostics: [
        ...diagnostics,
        ...individual.diagnostics,
        ...team.diagnostics,
        ...(team.seatDetails?.diagnostics ?? []),
      ],
    };
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
    let raw: GetSubscriptionDetailResponse;
    try {
      raw = await this.apiClient.callFlatApi<GetSubscriptionDetailResponse>({
        product: API_PRODUCT_BSS,
        action: 'GetSubscriptionDetail',
        params: apiParams,
      });
    } catch (error) {
      throw safeSubscriptionError(error, 'Token Plan seats could not be loaded. Try again later.');
    }

    if (raw && (raw as GetSubscriptionDetailResponse).Success === false) {
      throw new CliError({
        code: 'TOKENPLAN_SEATS_UNAVAILABLE',
        message: 'Token Plan seats could not be loaded. Try again later.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
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
    const cycle = this.buildSeatCycle(entry, diagnostics);
    const config = this.buildSeatConfig(entry, diagnostics);
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
    diagnostics: SubscriptionDiagnostic[],
  ): TokenPlanSeatCycle | null {
    const list: SubscriptionDetailEquityItem[] = Array.isArray(entry.EquityList)
      ? entry.EquityList
      : [];
    const equity = list[0];
    if (!equity) {
      diagnostics.push(
        subscriptionProtocolDiagnostic(
          'GetSubscriptionDetail',
          'EquityListEmpty',
          'Seat quota details are unavailable.',
        ),
      );
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
    diagnostics: SubscriptionDiagnostic[],
  ): TokenPlanSeatConfig | null {
    const rawConfig = entry.Config;
    if (typeof rawConfig !== 'string' || rawConfig.length === 0) {
      if (typeof rawConfig === 'string') {
        diagnostics.push(
          subscriptionProtocolDiagnostic(
            'GetSubscriptionDetail',
            'ConfigEmpty',
            'Seat configuration could not be verified.',
          ),
        );
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
    } catch {
      diagnostics.push(
        subscriptionProtocolDiagnostic(
          'GetSubscriptionDetail',
          'ConfigParseFailed',
          'Seat configuration could not be verified.',
        ),
      );
      return null;
    }
  }
}
