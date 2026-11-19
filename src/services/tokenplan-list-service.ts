import type { ApiClient } from '../api/api-client.js';
import { isResponseParseError } from '../api/base-client.js';
import {
  parseSoloCatalogBillingCycle,
  parseSoloCatalogSubscription,
  parseSoloSubscriptionCore,
  parseSoloStatusUsage,
} from '../api/parsers/solo-subscription.js';
import { GatewayShapeError } from '../api/request-adapter.js';
import {
  parseTokenPlanCatalogMetadata,
  parseTokenPlanCatalogQuota,
  type TokenPlanCatalogQuota,
} from '../api/parsers/tokenplan-catalog.js';
import { site } from '../site.js';
import type { SubscriptionDiagnostic } from '../types/subscription.js';
import type { TokenPlanEdition } from '../types/tokenplan-subscription.js';
import type {
  TokenPlanBillingCycle,
  TokenPlanCatalogMetadata,
  TokenPlanListOptions,
  TokenPlanListResult,
  TokenPlanListRow,
  TokenPlanListSection,
  TokenPlanCatalogPlan,
  TokenPlanCurrentPlanDetails,
} from '../types/tokenplan-catalog.js';
import {
  TOKEN_PLAN_INDIVIDUAL_TIERS,
  findTokenPlanIndividualTierBySpecCode,
} from '../types/tokenplan-tiers.js';
import { TokenPlanTradeService } from './tokenplan-trade-service.js';
import {
  buildTokenPlanCatalogConfiguration,
  TokenPlanCatalogPricing,
} from './tokenplan-catalog-pricing.js';
import { safeSubscriptionDiagnostic } from './subscription-diagnostics.js';
import { createTokenPlanBenefitsReader } from './tokenplan-benefits.js';
import { DecimalAmount } from '../utils/decimal-amount.js';
import {
  parseTeamSeatTypeSummaries,
  subscriptionTimestamp,
  teamResponseData,
} from './tokenplan-service.js';
import { API_TOKENPLAN_SOLO_USAGE } from '../types/api-routes.js';

const SOLO_SUBSCRIPTION_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription';
const SOLO_QUOTA_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config';

interface QueryResult<T> {
  value: T | null;
  diagnostics: SubscriptionDiagnostic[];
}

interface CatalogSubscription {
  status: TokenPlanListSection['subscriptionStatus'];
  currentPlan: string | null;
  currentBillingCycle: TokenPlanBillingCycle | null;
  subscribedPlans: ReadonlySet<string>;
  diagnostics: SubscriptionDiagnostic[];
  details?: TokenPlanCurrentPlanDetails;
  instanceCode?: string | null;
}

function catalogSubscriptionDetails(value: unknown): TokenPlanCurrentPlanDetails {
  return {
    ...parseSoloSubscriptionCore(record(value)?.data),
    totalCredits: null,
    remainingCredits: null,
  };
}

function preciseQuota(value: number | null | undefined): string | null {
  if (value == null) return null;
  try {
    return DecimalAmount.fromApi(value).toCanonicalString();
  } catch {
    return null;
  }
}

function teamCatalogDetails(
  value: unknown,
  diagnostics: SubscriptionDiagnostic[],
): TokenPlanCurrentPlanDetails {
  const details: TokenPlanCurrentPlanDetails = {
    subscriptionId: null,
    endAt: null,
    totalCredits: null,
    remainingCredits: null,
  };
  const data = teamResponseData(value, 'GetSeatSubscriptionSummary', diagnostics);
  if (data === null) return details;
  details.endAt = subscriptionTimestamp(data.EndTime);
  const summaries = parseTeamSeatTypeSummaries(value, diagnostics);
  if (summaries === null) return details;
  // A seat ID cannot stand in for a subscription ID. Aggregate only complete
  // Credits snapshots whose refresh windows agree across seat types.
  const sameWindow =
    summaries.length === 1 ||
    (summaries.length > 1 &&
      summaries[0]!.resetAt !== null &&
      summaries.every((summary) => summary.resetAt === summaries[0]!.resetAt));
  if (
    sameWindow &&
    diagnostics.length === 0 &&
    summaries.every((summary) => summary.totalCredits !== null && summary.remainingCredits !== null)
  ) {
    details.totalCredits = summaries
      .reduce(
        (total, summary) => total.add(DecimalAmount.parse(summary.totalCredits!)),
        DecimalAmount.parse('0'),
      )
      .toCanonicalString();
    details.remainingCredits = summaries
      .reduce(
        (total, summary) => total.add(DecimalAmount.parse(summary.remainingCredits!)),
        DecimalAmount.parse('0'),
      )
      .toCanonicalString();
  } else if (diagnostics.length === 0) {
    diagnostics.push({
      api: 'GetSeatSubscriptionSummary',
      errorCode: 'INCOMPLETE_CREDIT_SUMMARY',
      errorMessage:
        'Team credit totals are unavailable because the quota snapshots are incomplete or use different refresh windows.',
    });
  }
  return details;
}

const TEAM_TIERS = ['standard', 'pro', 'max'] as const;

function fallbackCatalogMetadata(edition: TokenPlanEdition): TokenPlanCatalogMetadata {
  if (edition === 'individual') {
    return {
      billingCycles: ['monthly', 'quarterly', 'yearly'],
      tiers: TOKEN_PLAN_INDIVIDUAL_TIERS.map(({ specCode, name }) => ({
        specCode,
        name,
        monthlyCredits: null,
      })),
    };
  }
  return {
    billingCycles: ['monthly', 'yearly'],
    tiers: TEAM_TIERS.map((specCode) => ({ specCode, name: null, monthlyCredits: null })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTeamCatalogSubscription(value: unknown): ReadonlySet<string> {
  const envelope = record(value);
  const candidates = Array.isArray(value)
    ? [value]
    : envelope
      ? ['Data', 'data'].filter((key) => Object.hasOwn(envelope, key)).map((key) => envelope[key])
      : [];
  const instances = candidates[0];
  if (
    !Array.isArray(instances) ||
    candidates.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(instances))
  ) {
    throw new GatewayShapeError('Team Token Plan catalog subscription is invalid');
  }

  const quantities = new Map<string, number>();
  for (const value of instances) {
    const instance = record(value);
    if (!instance) throw new GatewayShapeError('Team Token Plan catalog subscription is invalid');
    const specCode =
      typeof instance.SpecType === 'string' ? instance.SpecType.trim().toLowerCase() : '';
    if (!TEAM_TIERS.some((tier) => tier === specCode)) continue;
    const quantity = instance.Quantity ?? 1;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw new GatewayShapeError('Team Token Plan catalog subscription quantity is invalid');
    }
    quantities.set(specCode, (quantities.get(specCode) ?? 0) + quantity);
  }
  return new Set(
    TEAM_TIERS.filter((tier) => {
      return (quantities.get(tier) ?? 0) > 0;
    }),
  );
}

function baseCatalogStatus(
  price: { price: string } | null,
  inventory: boolean | null,
): TokenPlanListRow['status'] {
  if (inventory === false) return 'unavailable';
  return price && inventory === true ? 'purchasable' : 'unknown';
}

function individualCatalogStatus(
  subscription: CatalogSubscription | null,
  requestedCycle: TokenPlanBillingCycle,
  specCode: string,
  price: { price: string } | null,
  inventory: boolean | null,
): TokenPlanListRow['status'] {
  if (subscription?.status !== 'active') return baseCatalogStatus(price, inventory);
  if (
    subscription.currentBillingCycle !== null &&
    subscription.currentBillingCycle !== requestedCycle
  ) {
    return 'unavailable';
  }
  if (subscription.currentPlan === specCode) return 'subscribed';
  const currentIndex = TOKEN_PLAN_INDIVIDUAL_TIERS.findIndex(
    (tier) => tier.specCode === subscription.currentPlan,
  );
  const candidateIndex = TOKEN_PLAN_INDIVIDUAL_TIERS.findIndex(
    (tier) => tier.specCode === specCode,
  );
  if (currentIndex < 0 || candidateIndex < 0) return 'unknown';
  return candidateIndex > currentIndex ? 'upgrade' : 'unavailable';
}

function teamCatalogStatus(
  subscription: CatalogSubscription | null,
  price: { price: string } | null,
  inventory: boolean | null,
): TokenPlanListRow['status'] {
  if (subscription?.status !== 'active') return baseCatalogStatus(price, inventory);
  // An active team subscription applies edition-level subscribed status to all team tiers.
  return 'subscribed';
}

function skipped<T>(): Promise<QueryResult<T>> {
  return Promise.resolve({ value: null, diagnostics: [] });
}

function diagnostic(api: string, errorCode: string, errorMessage: string): SubscriptionDiagnostic {
  return { api, errorCode, errorMessage };
}

function failureDiagnostic(api: string, error: unknown): SubscriptionDiagnostic {
  return safeSubscriptionDiagnostic(api, error);
}

function unavailableSection(edition: TokenPlanEdition, error: unknown): TokenPlanListSection {
  return {
    edition,
    billingCycleSupported: null,
    subscriptionStatus: 'unknown',
    currentPlan: null,
    currentBillingCycle: null,
    subscriptionUrl: null,
    rows: [],
    diagnostics: [failureDiagnostic(`TokenPlanList/${edition}`, error)],
    currentPlanDetails: null,
    plans: [],
  };
}

/** Keep the retry wait inside the command budget and release its timer on cancellation. */
function waitForCatalogRetry(signal: AbortSignal): Promise<void> {
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
    }, 200);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function query<T>(
  api: string,
  signal: AbortSignal,
  request: () => Promise<T>,
): Promise<QueryResult<T>> {
  const stopped = (): QueryResult<T> => ({
    value: null,
    diagnostics: [
      diagnostic(api, 'TIMEOUT', 'The service did not respond in time. Try again later.'),
    ],
  });
  if (signal.aborted) return stopped();
  let onAbort: () => void = () => {};
  const interruption = new Promise<QueryResult<T>>((resolve) => {
    onAbort = () => resolve(stopped());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(async () => {
          signal.throwIfAborted();
          try {
            return await request();
          } catch (error) {
            // Only catalog reads recover from a dropped connection; business and parse
            // failures keep their original diagnostics, and trade/write paths are unchanged.
            const catalogRead =
              api === 'GetCommodity' ||
              api.startsWith('TokenPlanPrice/') ||
              api.startsWith('CheckInventory/');
            if (
              !catalogRead ||
              signal.aborted ||
              !(error instanceof Error) ||
              error.name !== 'Error' ||
              isResponseParseError(error) ||
              !/^Network request failed:/.test(error.message)
            ) {
              throw error;
            }
            // The single silent retry shares the command deadline and remains abortable.
            await waitForCatalogRetry(signal);
            signal.throwIfAborted();
            return request();
          }
        })
        .then(
          (value): QueryResult<T> => ({ value, diagnostics: [] }),
          (error: unknown): QueryResult<T> => {
            return {
              value: null,
              diagnostics: [failureDiagnostic(api, error)],
            };
          },
        ),
      interruption,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class TokenPlanListService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly timeoutMs = 30_000,
  ) {}

  async getTokenPlanList(options: TokenPlanListOptions = {}): Promise<TokenPlanListResult> {
    const authenticated = options.authenticated === true;
    const edition = options.edition ?? 'all';
    const billingCycle = options.billingCycle ?? 'monthly';
    const editions: TokenPlanEdition[] = edition === 'all' ? ['individual', 'team'] : [edition];
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const benefits = createTokenPlanBenefitsReader(this.apiClient, controller.signal);
    try {
      const results = await Promise.allSettled(
        editions.map((requested) =>
          this.loadEdition(
            requested,
            billingCycle,
            authenticated,
            controller.signal,
            options,
            benefits,
          ),
        ),
      );
      options.signal?.throwIfAborted();
      const sections = results.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        options.signal?.throwIfAborted();
        return unavailableSection(editions[index]!, result.reason);
      });
      const hasData = sections.some((section) =>
        section.rows.some(
          (row) =>
            row.price !== null ||
            row.inventory !== null ||
            row.weeklyCredits !== undefined ||
            row.monthlyCredits !== null,
        ),
      );
      return {
        authenticated,
        edition,
        billingCycle,
        completeness: sections.every((section) => section.diagnostics.length === 0)
          ? 'complete'
          : hasData
            ? 'partial'
            : 'unknown',
        sections,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  private async loadSubscription(
    edition: TokenPlanEdition,
    commodityCode: string,
    signal: AbortSignal,
  ): Promise<QueryResult<CatalogSubscription>> {
    const subscription = await query<CatalogSubscription>(
      edition === 'individual' ? SOLO_SUBSCRIPTION_API : 'GetUserInstanceSummary',
      signal,
      async () => {
        if (edition === 'individual') {
          const result = await this.apiClient.callCsDataApi({
            api: SOLO_SUBSCRIPTION_API,
            data: { commodityCode },
            signal,
            parse: (data) => ({
              ...parseSoloCatalogSubscription(data),
              details: catalogSubscriptionDetails(data),
            }),
          });
          return {
            status: result.status === 'active' ? 'active' : 'not_subscribed',
            currentPlan: result.specCode,
            currentBillingCycle: null,
            subscribedPlans: new Set(result.specCode ? [result.specCode] : []),
            diagnostics: [],
            details: result.details,
            instanceCode: result.instanceCode,
          };
        }
        const response = await this.apiClient.callFlatApi<unknown>({
          product: 'BssOpenAPI-V3',
          action: 'GetUserInstanceSummary',
          version: '2023-09-30',
          params: { ProductCode: commodityCode },
          signal,
        });
        const subscribedPlans = parseTeamCatalogSubscription(response);
        return {
          status: subscribedPlans.size > 0 ? 'active' : 'not_subscribed',
          currentPlan: null,
          currentBillingCycle: null,
          subscribedPlans,
          diagnostics: [],
        };
      },
    );
    const instanceCode = subscription.value?.instanceCode;
    if (edition === 'individual' && subscription.value?.status === 'active' && instanceCode) {
      // Instance details share the deadline but cannot erase an already confirmed subscription.
      const cycle = await query('QueryInstance', signal, () =>
        this.apiClient.callOrchestrationApi({
          action: 'QueryInstance',
          path: '/data/custom.json',
          authMode: 'required',
          params: { instanceId: instanceCode, commodityCode, orderType: 'RENEW' },
          signal,
          parse: parseSoloCatalogBillingCycle,
        }),
      );
      subscription.value.currentBillingCycle = cycle.value;
      subscription.diagnostics.push(...cycle.diagnostics);
    }
    return subscription;
  }

  private async loadEdition(
    edition: TokenPlanEdition,
    billingCycle: TokenPlanBillingCycle,
    authenticated: boolean,
    signal: AbortSignal,
    options: TokenPlanListOptions,
    benefits: ReturnType<typeof createTokenPlanBenefitsReader>,
  ): Promise<TokenPlanListSection> {
    if (edition === 'team' && billingCycle === 'quarterly') {
      return {
        edition,
        billingCycleSupported: false,
        subscriptionStatus: 'unknown',
        currentPlan: null,
        currentBillingCycle: null,
        subscriptionUrl: null,
        rows: [],
        diagnostics: [],
        currentPlanDetails: null,
        plans: [],
      };
    }
    const commodityCode =
      edition === 'individual'
        ? site.features.tokenPlanCommodityCodes.soloBuy
        : site.features.tokenPlanCommodityCodes.teams;
    const trade = new TokenPlanTradeService(this.apiClient);
    const pricing = new TokenPlanCatalogPricing(this.apiClient);
    // Public reads must progress even if the account query consumes the whole command budget.
    const subscriptionPromise = authenticated
      ? this.loadSubscription(edition, commodityCode, signal)
      : skipped<CatalogSubscription>();
    const modelsPromise = options.includeModels
      ? query('TokenPlanSupportedModels', signal, () => benefits.loadModels(edition))
      : skipped<Awaited<ReturnType<typeof benefits.loadModels>>>();
    const [commodity, quota] = await Promise.all([
      query('GetCommodity', signal, () =>
        authenticated ? trade.getCommodity(edition, signal) : pricing.getCommodity(edition, signal),
      ),
      edition === 'individual'
        ? query(SOLO_QUOTA_API, signal, () =>
            this.apiClient.callCsDataApi({
              api: SOLO_QUOTA_API,
              authMode: 'none',
              signal,
              parse: parseTokenPlanCatalogQuota,
            }),
          )
        : skipped<TokenPlanCatalogQuota>(),
    ]);
    const metadata = commodity.value
      ? await query('GetCommodity', signal, async () =>
          parseTokenPlanCatalogMetadata(commodity.value, edition, commodityCode),
        )
      : { value: null, diagnostics: commodity.diagnostics };
    const catalog = metadata.value ?? fallbackCatalogMetadata(edition);
    const catalogCommodity = metadata.value ? commodity.value : null;
    const tiers = catalog.tiers;
    const seats: Record<string, string> = { standard: 'standard', pro: 'pro', max: 'max' };
    const diagnostics = [...metadata.diagnostics, ...quota.diagnostics];
    const plans: TokenPlanCatalogPlan[] = [];
    const rows = await Promise.all(
      tiers.map(async (tier, index) => {
        const { specCode } = tier;
        const limits =
          specCode !== 'max'
            ? (quota.value?.[specCode as keyof TokenPlanCatalogQuota] ?? null)
            : null;
        const configuration = catalogCommodity
          ? await query(`Configuration/${specCode}`, signal, async () =>
              buildTokenPlanCatalogConfiguration(edition, specCode, billingCycle, catalogCommodity),
            )
          : await skipped<Record<string, unknown>>();
        const [price, inventory] = configuration.value
          ? await Promise.all([
              query(`TokenPlanPrice/${specCode}`, signal, () =>
                pricing.getPrice(configuration.value!, {
                  edition,
                  specCode,
                  authenticated,
                  signal,
                  includeListPrice: true,
                }),
              ),
              query(`CheckInventory/${specCode}`, signal, () =>
                pricing.getInventory(configuration.value!, { authenticated, signal }),
              ),
            ])
          : [
              { value: null, diagnostics: [] },
              { value: null, diagnostics: [] },
            ];
        diagnostics.push(
          ...configuration.diagnostics,
          ...price.diagnostics,
          ...inventory.diagnostics,
        );
        for (const [invalid, code, window] of [
          [limits?.weeklyInvalid, 'INVALID_WEEKLY_QUOTA', 'weekly'],
          [limits?.monthlyInvalid, 'INVALID_MONTHLY_QUOTA', 'monthly'],
        ] as const) {
          if (invalid) {
            diagnostics.push(
              diagnostic(SOLO_QUOTA_API, code, `The ${window} credit limit is invalid.`),
            );
          }
        }
        const seatType = edition === 'team' ? seats[specCode] : null;
        const individualTier = findTokenPlanIndividualTierBySpecCode(specCode);
        // quota-config is the only personal credit-limit source: weekly first, monthly as
        // fallback (pricing page card semantics: useMonthly = !hasWeekly && hasMonthly).
        const personalMonthlyCredits =
          limits != null && limits.weekly == null && limits.monthly != null ? limits.monthly : null;
        const row: TokenPlanListRow = {
          type:
            edition === 'individual'
              ? (individualTier?.type ?? `token_plan_individual_${specCode}`)
              : 'token_plan_team',
          specCode,
          seatType: seatType ?? null,
          name:
            tier?.name ??
            (edition === 'individual'
              ? (individualTier?.name ?? null)
              : ({ standard: 'Standard Seat', pro: 'Pro Seat', max: 'Max Seat' }[specCode] ??
                null)),
          price: price.value?.price ?? null,
          currency: price.value?.currency ?? null,
          inventory: inventory.value,
          ...(limits?.weekly === null || limits?.weekly === undefined
            ? {}
            : { weeklyCredits: limits.weekly }),
          monthlyCredits:
            tier?.monthlyCredits ??
            price.value?.monthlyCredits ??
            (personalMonthlyCredits === null ? null : String(personalMonthlyCredits)),
          status: baseCatalogStatus(price.value, inventory.value),
        };
        const quotaWindows: TokenPlanCatalogPlan['quotaWindows'] = [];
        if (edition === 'individual') {
          const weekly = preciseQuota(limits?.weekly);
          const monthly = preciseQuota(limits?.monthly);
          if (weekly !== null) quotaWindows.push({ windowType: 'weekly', totalCredits: weekly });
          if (monthly !== null) quotaWindows.push({ windowType: 'monthly', totalCredits: monthly });
        } else if (row.monthlyCredits !== null) {
          // The catalog configuration prices one seat with an explicit byDynamicMonth quota.
          quotaWindows.push({
            windowType: 'monthly',
            totalCredits: DecimalAmount.fromApi(row.monthlyCredits).toCanonicalString(),
          });
        }
        plans[index] = {
          ...(edition === 'individual' ? { tier: specCode } : { seatType: specCode }),
          billingTerm: billingCycle,
          listPrice: price.value?.listPrice ?? null,
          promoPrice: price.value?.price ?? null,
          currency: price.value?.currency ?? null,
          quotaWindows,
        };
        return row;
      }),
    );
    const subscription = await subscriptionPromise;
    const subscriptionStatus = subscription.value?.status ?? 'unknown';
    diagnostics.push(...subscription.diagnostics, ...(subscription.value?.diagnostics ?? []));
    for (const row of rows) {
      const price = row.price === null ? null : { price: row.price };
      // Public prices remain useful when eligibility cannot be confirmed for the signed-in account.
      row.status =
        authenticated && subscription.value === null
          ? 'unknown'
          : edition === 'individual'
            ? individualCatalogStatus(
                subscription.value,
                billingCycle,
                row.specCode,
                price,
                row.inventory,
              )
            : teamCatalogStatus(subscription.value, price, row.inventory);
    }
    if (
      rows.some(
        (row) =>
          row.name === null ||
          (edition === 'team'
            ? row.monthlyCredits === null
            : row.weeklyCredits === undefined && row.monthlyCredits === null),
      )
    ) {
      diagnostics.push(
        diagnostic('TokenPlanList', 'INCOMPLETE_FIELDS', 'Some names or credit limits are unknown'),
      );
    }
    const cycles = catalog.billingCycles;
    if (cycles && !cycles.includes(billingCycle)) {
      diagnostics.push(
        diagnostic(
          'GetCommodity',
          'UNSUPPORTED_CYCLE',
          'Selected billing cycle is absent from commodity metadata',
        ),
      );
    }
    const [models, currentUsage, teamSummary] = await Promise.all([
      modelsPromise,
      edition === 'individual' && subscriptionStatus === 'active'
        ? query(API_TOKENPLAN_SOLO_USAGE, signal, () =>
            this.apiClient.callCsDataApi({
              api: API_TOKENPLAN_SOLO_USAGE,
              data: {},
              signal,
              parse: parseSoloStatusUsage,
            }),
          )
        : skipped<ReturnType<typeof parseSoloStatusUsage>>(),
      edition === 'team' && subscriptionStatus === 'active'
        ? query('GetSeatSubscriptionSummary', signal, () =>
            this.apiClient.callFlatApi<unknown>({
              product: 'BssOpenAPI-V3',
              action: 'GetSeatSubscriptionSummary',
              params: { productCode: commodityCode },
              signal,
            }),
          )
        : skipped<unknown>(),
    ]);
    diagnostics.push(
      ...models.diagnostics,
      ...currentUsage.diagnostics,
      ...teamSummary.diagnostics,
    );
    for (const plan of plans) {
      if (options.includeModels) plan.supportedModels = models.value;
    }
    let currentPlanDetails =
      subscriptionStatus === 'active'
        ? (subscription.value?.details ?? {
            subscriptionId: null,
            endAt: null,
            totalCredits: null,
            remainingCredits: null,
          })
        : null;
    if (currentPlanDetails && edition === 'individual' && subscription.value?.currentPlan) {
      const currentQuota =
        quota.value?.[subscription.value.currentPlan as keyof TokenPlanCatalogQuota];
      currentPlanDetails.usedPct =
        currentUsage.value === null ? null : currentUsage.value.usedRatio * 100;
      currentPlanDetails.remainingPct =
        currentUsage.value === null ? null : (1 - currentUsage.value.usedRatio) * 100;
      currentPlanDetails.quotaWindowType = currentUsage.value?.cycle ?? null;
      if (currentUsage.value && currentQuota) {
        currentPlanDetails.totalCredits = preciseQuota(currentQuota[currentUsage.value.cycle]);
      } else if (currentQuota && (currentQuota.weekly == null) !== (currentQuota.monthly == null)) {
        currentPlanDetails.totalCredits = preciseQuota(currentQuota.weekly ?? currentQuota.monthly);
      }
      if (currentUsage.value === null && currentUsage.diagnostics.length === 0) {
        diagnostics.push(
          diagnostic(
            API_TOKENPLAN_SOLO_USAGE,
            'MISSING_USAGE_RATIO',
            'Remaining personal quota percentage is unavailable.',
          ),
        );
      }
    }
    if (currentPlanDetails && edition === 'team' && teamSummary.value !== null) {
      const summaryDiagnostics: SubscriptionDiagnostic[] = [];
      currentPlanDetails = teamCatalogDetails(teamSummary.value, summaryDiagnostics);
      diagnostics.push(...summaryDiagnostics);
    }
    return {
      edition,
      billingCycleSupported: cycles ? cycles.includes(billingCycle) : null,
      subscriptionStatus,
      currentPlan: subscription.value?.currentPlan ?? null,
      currentBillingCycle: subscription.value?.currentBillingCycle ?? null,
      subscriptionUrl:
        subscriptionStatus === 'active'
          ? new URL(`/home/analytics/token-plan/${edition}`, site.apiKeyConsoleUrl).href
          : null,
      rows,
      diagnostics,
      currentPlanDetails,
      plans,
    };
  }
}
