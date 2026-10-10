import type { ApiClient } from '../api/api-client.js';
import {
  parseSoloQuotaConfig,
  parseSoloSubscription,
  parseSoloUsage,
  type SoloSubscription,
} from '../api/parsers/solo-subscription.js';
import type { CachedFetcher } from '../types/cache.js';
import type { TokenPlan } from '../types/usage.js';
import type {
  QueryAvailableInstancesResponse,
  FrInstanceItem,
  FrInstanceResponse,
} from '../types/api-models.js';
import { addDiagnostic } from '../api/debug-buffer.js';
const API_ACTION_DESCRIBE_FR = 'DescribeFrInstances';
import type { SubscriptionDiagnostic } from '../types/subscription.js';
import type {
  TokenPlanEdition,
  TokenPlanEditionStatus,
  TokenPlanRenewable,
  TokenPlanSeatGroup,
} from '../types/tokenplan-subscription.js';
import { site } from '../site.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import {
  safeSubscriptionDiagnostic,
  subscriptionProtocolDiagnostic,
} from './subscription-diagnostics.js';
import {
  API_ACTION_QUERY_AVAILABLE_INSTANCES,
  API_PRODUCT_BSS_PAYMENT,
  API_TOKENPLAN_SOLO_QUOTA_CONFIG,
  API_TOKENPLAN_SOLO_SUBSCRIPTION,
  API_TOKENPLAN_SOLO_USAGE,
} from '../types/api-routes.js';
import { findTokenPlanIndividualTierBySpecCode } from '../types/tokenplan-tiers.js';

const API_PRODUCT_BSS = 'BssOpenAPI-V3';

export function subscriptionObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function subscriptionInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function subscriptionDecimal(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

export function subscriptionTimestamp(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) return null;
    return new Date(value).toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function subscriptionDiagnostic(api: string, errorCode: string): SubscriptionDiagnostic {
  return subscriptionProtocolDiagnostic(
    api,
    errorCode,
    'Some subscription fields could not be verified.',
  );
}

function failedSubscriptionDiagnostic(api: string, error: unknown): SubscriptionDiagnostic {
  return safeSubscriptionDiagnostic(api, error);
}

export function unknownTokenPlanEdition(
  edition: TokenPlanEdition,
  diagnostics: SubscriptionDiagnostic[] = [],
): TokenPlanEditionStatus {
  return {
    edition,
    commodityCode:
      edition === 'individual'
        ? site.features.tokenPlanCommodityCodes.soloBuy
        : site.features.tokenPlanCommodityCodes.teams,
    status: 'unknown',
    type: edition === 'team' ? 'token_plan_team' : null,
    name: null,
    specCode: null,
    period: null,
    remainingDays: null,
    autoRenew: null,
    ...(edition === 'team'
      ? {
          weeklyCredits: { total: null, used: null, remaining: null },
          fiveHourCredits: { total: null, used: null, remaining: null },
        }
      : {}),
    seatSummary: null,
    completeness: 'unknown',
    diagnostics,
  };
}

function matchedIndividualAutoRenewFlag(
  subscription: SoloSubscription,
  value: unknown,
): boolean | null {
  const raw = subscriptionObject(value);
  const data = subscriptionObject(raw?.Data);
  if (
    !raw ||
    raw.Success !== true ||
    raw.Code !== 'Success' ||
    !data ||
    !Array.isArray(data.InstanceList)
  ) {
    return null;
  }

  type RenewalCandidate = {
    instanceId: string | null;
    endTime: number | null;
    renewStatus: boolean | null;
  };
  const relevant = data.InstanceList.reduce<RenewalCandidate[]>((instances, entry) => {
    const instance = subscriptionObject(entry);
    if (!instance || instance.ProductType !== site.features.tokenPlanCommodityCodes.soloBuy) {
      return instances;
    }
    const endTime = subscriptionTimestamp(instance.EndTime);
    const renewStatus =
      instance.RenewStatus === 'AutoRenewal'
        ? true
        : instance.RenewStatus === 'ManualRenewal'
          ? false
          : null;
    if (
      typeof instance.InstanceID !== 'string' ||
      !instance.InstanceID.trim() ||
      instance.Status !== 'Normal' ||
      instance.SubStatus !== 'Normal' ||
      instance.SubscriptionType !== 'Subscription' ||
      endTime === null ||
      Date.parse(endTime) <= Date.now()
    ) {
      instances.push({ instanceId: null, endTime: null, renewStatus: null });
      return instances;
    }
    instances.push({ instanceId: instance.InstanceID, endTime: Date.parse(endTime), renewStatus });
    return instances;
  }, []);
  const active = relevant.filter(
    (instance): instance is { instanceId: string; endTime: number; renewStatus: boolean | null } =>
      instance.instanceId !== null && instance.endTime !== null,
  );

  const byInstanceId = active.filter(
    (instance) => instance.instanceId === subscription.instanceCode,
  );
  if (byInstanceId.length > 0) {
    return byInstanceId.length === 1 ? byInstanceId[0].renewStatus : null;
  }

  const byEndTime = active.filter((instance) => instance.endTime === subscription.endTime);
  if (byEndTime.length > 0) {
    return byEndTime.length === 1 ? byEndTime[0].renewStatus : null;
  }

  const pageNum = subscriptionInteger(data.PageNum);
  const pageSize = subscriptionInteger(data.PageSize);
  const totalCount = subscriptionInteger(data.TotalCount);
  const complete =
    pageNum === 1 &&
    pageSize !== null &&
    pageSize > 0 &&
    totalCount === data.InstanceList.length &&
    data.InstanceList.length <= pageSize;
  return complete && relevant.length === 1 && active.length === 1 ? active[0].renewStatus : null;
}

/** Prefer the billing instance used by the console, then fall back to its subscription flag. */
export function resolveIndividualAutoRenewFlag(
  subscription: SoloSubscription,
  value: unknown,
): boolean {
  return matchedIndividualAutoRenewFlag(subscription, value) ?? subscription.autoRenewFlag;
}

export async function fetchIndividualTokenPlan(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<TokenPlanEditionStatus> {
  const result = unknownTokenPlanEdition('individual');
  const subscriptionRequest = apiClient.callCsDataApi({
    api: API_TOKENPLAN_SOLO_SUBSCRIPTION,
    data: { commodityCode: result.commodityCode },
    signal,
    parse: parseSoloSubscription,
  });
  const availableInstancesRequest = subscriptionRequest.then((response) => {
    if (response.status !== 'active' || response.subscription === null) return null;
    return apiClient.callFlatApi<QueryAvailableInstancesResponse>({
      product: API_PRODUCT_BSS_PAYMENT,
      action: API_ACTION_QUERY_AVAILABLE_INSTANCES,
      params: {},
      signal,
    });
  });
  const [subscription, quota, usage, availableInstances] = await Promise.allSettled([
    subscriptionRequest,
    apiClient.callCsDataApi({
      api: API_TOKENPLAN_SOLO_QUOTA_CONFIG,
      signal,
      parse: parseSoloQuotaConfig,
    }),
    apiClient.callCsDataApi({
      api: API_TOKENPLAN_SOLO_USAGE,
      signal,
      parse: parseSoloUsage,
    }),
    availableInstancesRequest,
  ]);
  if (subscription.status === 'rejected') {
    result.diagnostics.push(
      failedSubscriptionDiagnostic(API_TOKENPLAN_SOLO_SUBSCRIPTION, subscription.reason),
    );
    return result;
  }
  const entity = subscription.value.subscription;
  if (subscription.value.status === 'none') {
    result.status = 'not_subscribed';
    return result;
  }
  if (subscription.value.status !== 'active' || entity === null) {
    const diagnostic = subscriptionDiagnostic(API_TOKENPLAN_SOLO_SUBSCRIPTION, 'UnconfirmedState');
    result.diagnostics.push(diagnostic);
    return result;
  }
  const identity = findTokenPlanIndividualTierBySpecCode(entity.specCode);
  if (!identity) {
    result.diagnostics.push(
      subscriptionDiagnostic(API_TOKENPLAN_SOLO_SUBSCRIPTION, 'UnconfirmedTier'),
    );
    return result;
  }
  result.status = 'active';
  result.type = identity.type;
  result.name = identity.name;
  result.specCode = entity.specCode;
  result.period = {
    start: new Date(entity.startTime).toISOString(),
    end: new Date(entity.endTime).toISOString(),
    remainingDays: entity.remainingDays,
  };
  result.remainingDays = entity.remainingDays;
  if (availableInstances.status === 'fulfilled') {
    result.autoRenew = {
      enabled: resolveIndividualAutoRenewFlag(entity, availableInstances.value),
      period: null,
      periodUnit: null,
    };
  } else {
    result.diagnostics.push(
      failedSubscriptionDiagnostic(API_ACTION_QUERY_AVAILABLE_INSTANCES, availableInstances.reason),
    );
    result.autoRenew = { enabled: entity.autoRenewFlag, period: null, periodUnit: null };
  }
  result.completeness = 'partial';
  if (usage.status === 'fulfilled' && usage.value !== null) {
    const tierQuota = quota.status === 'fulfilled' ? quota.value[entity.specCode] : undefined;
    const window = {
      total: tierQuota?.weekly ?? tierQuota?.monthly ?? null,
      used: null,
      remaining: null,
      usedPct: usage.value.usedRatio * 100,
      ...(usage.value.resetTime === undefined
        ? {}
        : { resetTime: new Date(usage.value.resetTime).toISOString() }),
    };
    if (usage.value.cycle === 'monthly') {
      result.monthlyCredits = window;
    } else {
      result.weeklyCredits = window;
    }
    if (quota.status === 'rejected') {
      result.diagnostics.push(
        failedSubscriptionDiagnostic(API_TOKENPLAN_SOLO_QUOTA_CONFIG, quota.reason),
      );
    }
  } else {
    if (usage.status === 'rejected') {
      result.diagnostics.push(failedSubscriptionDiagnostic(API_TOKENPLAN_SOLO_USAGE, usage.reason));
    }
  }
  return result;
}

export interface TeamTokenPlanResult {
  team: TokenPlanEditionStatus;
  instanceId: string | null;
  legacy: Partial<TokenPlan>;
}

export interface TokenPlanEditionResult {
  tokenPlan: TokenPlan;
  teamInstanceId: string | null;
}

export async function fetchTeamTokenPlan(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<TeamTokenPlanResult> {
  const team = unknownTokenPlanEdition('team');
  const result: TeamTokenPlanResult = { team, instanceId: null, legacy: {} };
  const api = 'DescribeFrInstances';
  try {
    const raw = subscriptionObject(
      await apiClient.callFlatApi<unknown>({
        product: API_PRODUCT_BSS,
        action: api,
        params: {
          Group: 'tokenPlan',
          CommodityCode: team.commodityCode,
          PageNum: 1,
          PageSize: 100,
        },
        signal,
      }),
    );
    if (
      !raw ||
      !Array.isArray(raw.Data) ||
      (raw.Success !== undefined && raw.Success !== true) ||
      (raw.Code !== undefined && raw.Code !== 'Success' && raw.Code !== '200')
    ) {
      team.diagnostics.push(subscriptionDiagnostic(api, 'InvalidResponse'));
      return result;
    }
    const pageSize = raw.PageSize === undefined ? 100 : subscriptionInteger(raw.PageSize);
    if (
      subscriptionInteger(raw.TotalCount) !== raw.Data.length ||
      raw.Data.length > 100 ||
      pageSize === null ||
      pageSize === 0 ||
      raw.Data.length > pageSize ||
      (raw.CurrentPage !== undefined && raw.CurrentPage !== 1) ||
      (raw.PageNum !== undefined && raw.PageNum !== 1)
    ) {
      team.diagnostics.push(subscriptionDiagnostic(api, 'IncompleteInstances'));
    }
    const active = new Map<string, Record<string, unknown>>();
    const instanceIds = new Set<string>();
    const now = Date.now();
    for (const entry of raw.Data) {
      const item = subscriptionObject(entry);
      if (!item || item.CommodityCode !== team.commodityCode) {
        team.diagnostics.push(subscriptionDiagnostic(api, 'CommodityMismatch'));
        continue;
      }
      if (typeof item.InstanceId !== 'string' || !item.InstanceId.trim()) {
        team.diagnostics.push(subscriptionDiagnostic(api, 'InvalidInstance'));
        continue;
      }
      if (instanceIds.has(item.InstanceId)) {
        team.diagnostics.push(subscriptionDiagnostic(api, 'DuplicateInstance'));
      }
      instanceIds.add(item.InstanceId);
      const status =
        typeof item.Status === 'string' ? item.Status : subscriptionObject(item.Status)?.Code;
      if (item.StatusCode !== undefined && item.StatusCode !== status) {
        team.diagnostics.push(subscriptionDiagnostic(api, 'UnconfirmedState'));
        continue;
      }
      const start =
        item.StartTime === undefined ? undefined : subscriptionTimestamp(item.StartTime);
      const end = item.EndTime === undefined ? undefined : subscriptionTimestamp(item.EndTime);
      if (
        start === null ||
        end === null ||
        (start && Date.parse(start) > now) ||
        (status === 'valid' && end && Date.parse(end) <= now) ||
        (start && end && Date.parse(start) >= Date.parse(end))
      ) {
        team.diagnostics.push(subscriptionDiagnostic(api, 'ConflictingPeriod'));
        continue;
      }
      if (status !== 'valid') {
        const expired =
          ((status === 'expire' || status === 'expired') && (!end || Date.parse(end) <= now)) ||
          (status === 'invalid' && end && Date.parse(end) <= now);
        if (!expired) team.diagnostics.push(subscriptionDiagnostic(api, 'UnconfirmedState'));
        continue;
      }
      active.set(item.InstanceId, item);
    }
    if (active.size === 0) {
      // Absence requires a complete, trustworthy page; known active instances
      // remain useful even when the rest of the response is incomplete.
      if (team.diagnostics.length === 0) team.status = 'not_subscribed';
      return result;
    }
    team.status = 'active';
    team.completeness = 'partial';
    result.legacy = { subscribed: true, status: 'valid' };
    if (active.size === 1) {
      const [instanceId, item] = [...active.entries()][0];
      result.instanceId = instanceId;
      const name = item.TemplateName ?? item.CommodityName;
      if (typeof name === 'string' && name.trim()) {
        team.name = name;
        result.legacy.planName = name;
      }
      const total = subscriptionDecimal(item.InitCapacityBaseValue);
      const remaining = subscriptionDecimal(
        item.CapacityTypeCode === 'periodMonthlyShift'
          ? (item.periodCapacityBaseValue ?? item.CurrCapacityBaseValue)
          : item.CurrCapacityBaseValue,
      );
      if (
        total !== null &&
        remaining !== null &&
        Number.isFinite(Number(total)) &&
        Number.isFinite(Number(remaining)) &&
        Number(remaining) <= Number(total)
      ) {
        result.legacy.totalCredits = Number(total);
        result.legacy.remainingCredits = Number(remaining);
        result.legacy.usedPct =
          Number(total) > 0 ? (1 - Number(remaining) / Number(total)) * 100 : 0;
      }
      const end = subscriptionTimestamp(item.EndTime);
      if (end) result.legacy.resetDate = end;
    }
    return result;
  } catch (error) {
    team.diagnostics.push(failedSubscriptionDiagnostic(api, error));
    return result;
  }
}

function totalEditionFailure(diagnostics: SubscriptionDiagnostic[]): CliError {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.errorCode));
  if (codes.has('CONFIG_ERROR') || codes.has('PROTOCOL_ERROR')) {
    return new CliError({
      code: 'CONFIG_ERROR',
      message: 'Token Plan status configuration or response protocol is invalid.',
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  }
  if (
    codes.has('AUTH_REQUIRED') ||
    codes.has('TOKEN_EXPIRED') ||
    codes.has('CS_DATA_AUTH_REQUIRED')
  ) {
    return new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Token Plan status authentication failed. Run: qianwen auth login',
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });
  }
  if (codes.has('NETWORK_ERROR')) {
    return new CliError({
      code: 'NETWORK_ERROR',
      message: 'Token Plan status requests failed. Check your network connection.',
      exitCode: EXIT_CODES.NETWORK_ERROR,
    });
  }
  return new CliError({
    code: 'TOKENPLAN_STATUS_UNAVAILABLE',
    message: 'No Token Plan subscription status could be confirmed.',
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

function teamResponseData(
  value: unknown,
  api: string,
  diagnostics: SubscriptionDiagnostic[],
): Record<string, unknown> | null {
  const raw = subscriptionObject(value);
  if (
    !raw ||
    (raw.Success !== undefined && raw.Success !== true) ||
    (raw.Code !== undefined && raw.Code !== 'Success')
  ) {
    diagnostics.push(subscriptionDiagnostic(api, 'Unavailable'));
    return null;
  }
  const inner = Object.hasOwn(raw, 'Data') ? subscriptionObject(raw.Data) : raw;
  if (
    !inner ||
    (inner.ProductCode !== undefined &&
      inner.ProductCode !== site.features.tokenPlanCommodityCodes.teams)
  ) {
    diagnostics.push(subscriptionDiagnostic(api, 'InvalidResponse'));
    return null;
  }
  return inner;
}

function buildTeamSeatGroups(
  seat: Record<string, unknown>,
  diagnostics: SubscriptionDiagnostic[],
  autoRenewEnabled: boolean | null,
): TokenPlanSeatGroup[] {
  if (!Array.isArray(seat.SubscriptionGroupList)) return [];
  return seat.SubscriptionGroupList.flatMap((entry) => {
    const group = subscriptionObject(entry);
    if (!group) {
      diagnostics.push(subscriptionDiagnostic('GetSeatSubscriptionSummary', 'InvalidGroup'));
      return [];
    }
    const equity = Array.isArray(group.EquityList) ? subscriptionObject(group.EquityList[0]) : null;
    return [
      {
        specType:
          typeof group.SpecType === 'string' && group.SpecType.trim() ? group.SpecType : 'unknown',
        seats: subscriptionInteger(group.SubscriptionTotalNumber),
        assigned: subscriptionInteger(group.SubscriptionAssignedNumber),
        totalValue: subscriptionDecimal(equity?.TotalValue ?? group.TotalValue),
        surplusValue: subscriptionDecimal(equity?.SurplusValue ?? group.SurplusValue),
        unit: 'Credits',
        nextCycleFlushTime:
          autoRenewEnabled === false ? null : subscriptionTimestamp(group.NextCycleFlushTime),
      },
    ];
  });
}

export function parseTeamSeatGroups(
  value: unknown,
  diagnostics: SubscriptionDiagnostic[],
): TokenPlanSeatGroup[] | null {
  const seat = teamResponseData(value, 'GetSeatSubscriptionSummary', diagnostics);
  return seat && Array.isArray(seat.SubscriptionGroupList)
    ? buildTeamSeatGroups(seat, diagnostics, null)
    : null;
}

export function enrichTeamTokenPlan(
  source: TokenPlanEditionStatus,
  seatRaw: unknown,
  summaryRaw: unknown,
  autoRenewRaw: unknown,
): TokenPlanEditionStatus {
  const result = { ...source, diagnostics: [...source.diagnostics] };
  const seat = teamResponseData(seatRaw, 'GetSeatSubscriptionSummary', result.diagnostics);
  const summary = teamResponseData(summaryRaw, 'GetSubscriptionSummary', result.diagnostics);
  const autoRenew =
    result.status === 'not_subscribed'
      ? null
      : teamResponseData(autoRenewRaw, 'CheckTokenPlanAutoRenewal', result.diagnostics);
  if (autoRenew) {
    const value = autoRenew.AutoRenewal;
    const enabled =
      typeof value === 'boolean' ? value : value === 0 ? false : value === 1 ? true : null;
    if (enabled !== null) {
      result.autoRenew = {
        enabled,
        period: subscriptionInteger(autoRenew.RenewalPeriod),
        periodUnit:
          typeof autoRenew.RenewalPeriodUnit === 'string' && autoRenew.RenewalPeriodUnit.trim()
            ? autoRenew.RenewalPeriodUnit
            : null,
      };
    } else
      result.diagnostics.push(subscriptionDiagnostic('CheckTokenPlanAutoRenewal', 'InvalidFields'));
  }
  if (seat) {
    const start = subscriptionTimestamp(seat.StartTime ?? seat.PeriodStart);
    const end = subscriptionTimestamp(seat.EndTime ?? seat.PeriodEnd);
    const remainingDays =
      typeof seat.RemainingDays === 'string' && /^\d+$/.test(seat.RemainingDays)
        ? subscriptionInteger(Number(seat.RemainingDays))
        : subscriptionInteger(seat.RemainingDays);
    result.remainingDays = remainingDays;
    if (start && end && Date.parse(start) < Date.parse(end))
      result.period = { start, end, remainingDays };
    if (typeof seat.PlanName === 'string' && seat.PlanName.trim()) result.name = seat.PlanName;
  }
  const groups = seat
    ? buildTeamSeatGroups(seat, result.diagnostics, result.autoRenew?.enabled ?? null)
    : [];
  const total = summary
    ? {
        seats: subscriptionInteger(summary.TotalCount),
        totalValue: subscriptionDecimal(summary.TotalValue),
        surplusValue: subscriptionDecimal(summary.TotalSurplusValue),
        unit: 'Credits',
      }
    : null;
  if (
    summary &&
    [summary.TotalValue, summary.TotalSurplusValue].some(
      (value) => value !== undefined && value !== null && subscriptionDecimal(value) === null,
    )
  )
    result.diagnostics.push(subscriptionDiagnostic('GetSubscriptionSummary', 'InvalidFields'));
  const knownTotal =
    total && (total.seats !== null || total.totalValue !== null || total.surplusValue !== null)
      ? total
      : null;
  result.seatSummary =
    (seat && Array.isArray(seat.SubscriptionGroupList)) || knownTotal
      ? { groups, total: knownTotal }
      : null;
  if (result.status === 'active' || result.period || result.autoRenew || result.seatSummary)
    result.completeness = 'partial';
  return result;
}

export function buildTeamRenewable(
  value: unknown,
  instanceId: string | null,
): TokenPlanRenewable | null {
  const raw = subscriptionObject(value);
  if (!raw || raw.Success === false || (raw.Code !== undefined && raw.Code !== 'Success'))
    return null;
  if (Array.isArray(raw.Data)) {
    const matches = raw.Data.map(subscriptionObject).filter(
      (item) =>
        item?.InstanceId === instanceId &&
        item?.CommodityCode === site.features.tokenPlanCommodityCodes.teams,
    );
    if (matches.length !== 1) return null;
    const item = matches[0];
    const canRenew = item?.CanRenew ?? item?.canRenew;
    return typeof canRenew === 'boolean'
      ? {
          canRenew,
          interceptCode: typeof item?.InterceptCode === 'string' ? item.InterceptCode : null,
        }
      : null;
  }
  return typeof raw.Renewable === 'boolean'
    ? { canRenew: raw.Renewable, interceptCode: null }
    : null;
}

export class TokenplanService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly cache: CachedFetcher,
  ) {}

  /** Fetch the user's Token Plan view. Failures degrade to subscribed=false. */
  async fetchTokenPlan(
    options: { editions?: boolean; signal?: AbortSignal } = {},
  ): Promise<TokenPlan> {
    if (options.editions) return (await this.fetchTokenPlanEditions(options.signal)).tokenPlan;
    try {
      const codes = site.features.tokenPlanCommodityCodes;
      const [teamsRes, personalRes, addonRes] = await Promise.all([
        this.fetchFrInstances(codes.teams, 10),
        this.fetchFrInstances(codes.personal, 10),
        this.fetchFrInstances(codes.addon, 100),
      ]);

      const allPlanInstances = [...(teamsRes?.Data ?? []), ...(personalRes?.Data ?? [])];
      const validInstance =
        allPlanInstances.find((inst) => {
          const statusCode = typeof inst.Status === 'object' ? inst.Status?.Code : inst.Status;
          return statusCode === 'valid';
        }) ?? allPlanInstances[0];

      const addonRemaining = (addonRes?.Data ?? [])
        .filter((inst) => {
          const statusCode = typeof inst.Status === 'object' ? inst.Status?.Code : inst.Status;
          return statusCode === 'valid';
        })
        .reduce(
          (sum: number, inst: FrInstanceItem) => sum + Number(inst.CurrCapacityBaseValue || 0),
          0,
        );

      if (!validInstance) {
        if (addonRemaining > 0) return { subscribed: false, addonRemaining };
        return { subscribed: false };
      }

      return this.buildTokenPlanDto(validInstance, addonRemaining);
    } catch (error) {
      addDiagnostic(
        'TokenPlan',
        `fetch failed, treating as not subscribed: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return { subscribed: false };
    } finally {
      void this.cache;
    }
  }

  private async fetchFrInstances(
    commodityCode: string,
    pageSize: number,
  ): Promise<FrInstanceResponse | null> {
    try {
      const result = await this.apiClient.callFlatApi<FrInstanceResponse>({
        product: API_PRODUCT_BSS,
        action: API_ACTION_DESCRIBE_FR,
        params: {
          Group: 'tokenPlan',
          CommodityCode: commodityCode,
          PageNum: 1,
          PageSize: pageSize,
        },
      });
      return result ?? null;
    } catch (error) {
      addDiagnostic(
        'TokenPlan',
        `DescribeFrInstances failed for ${commodityCode}: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return null;
    }
  }

  private buildTokenPlanDto(instance: FrInstanceItem, addonRemaining: number): TokenPlan {
    const statusCode =
      typeof instance.Status === 'object' ? instance.Status?.Code : instance.Status;
    const totalCredits = Number(instance.InitCapacityBaseValue || 0);
    const capacityType = instance.CapacityTypeCode ?? '';
    const remainingCredits =
      capacityType === 'periodMonthlyShift'
        ? Number(instance.periodCapacityBaseValue || instance.CurrCapacityBaseValue || 0)
        : Number(instance.CurrCapacityBaseValue || 0);
    const usedPct = totalCredits > 0 ? ((totalCredits - remainingCredits) / totalCredits) * 100 : 0;

    const dto: TokenPlan = {
      subscribed: statusCode === 'valid',
      planName: instance.TemplateName ?? instance.CommodityName,
      status: statusCode as TokenPlan['status'],
      totalCredits,
      remainingCredits,
      usedPct,
    };
    if (addonRemaining > 0) dto.addonRemaining = addonRemaining;
    return dto;
  }

  async fetchTokenPlanEditions(signal?: AbortSignal): Promise<TokenPlanEditionResult> {
    const [individual, teamResult] = await Promise.allSettled([
      fetchIndividualTokenPlan(this.apiClient, signal),
      fetchTeamTokenPlan(this.apiClient, signal),
    ]);
    const individualStatus =
      individual.status === 'fulfilled'
        ? individual.value
        : unknownTokenPlanEdition('individual', [
            subscriptionDiagnostic(API_TOKENPLAN_SOLO_SUBSCRIPTION, 'Unavailable'),
          ]);
    const team =
      teamResult.status === 'fulfilled'
        ? teamResult.value.team
        : unknownTokenPlanEdition('team', [
            subscriptionDiagnostic('DescribeFrInstances', 'Unavailable'),
          ]);
    const diagnostics = [...individualStatus.diagnostics, ...team.diagnostics];
    if (individualStatus.status === 'unknown' && team.status === 'unknown') {
      throw totalEditionFailure(diagnostics);
    }
    const tokenPlan: TokenPlan = {
      ...(teamResult.status === 'fulfilled' ? teamResult.value.legacy : {}),
      subscribed: individualStatus.status === 'active' || team.status === 'active' ? true : null,
      individual: individualStatus,
      team,
      diagnostics,
    };
    void this.cache;
    return {
      tokenPlan,
      teamInstanceId: teamResult.status === 'fulfilled' ? teamResult.value.instanceId : null,
    };
  }
}
