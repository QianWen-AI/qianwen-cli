import type { ApiClient } from '../api/api-client.js';
import {
  parseSoloCatalogBillingCycle,
  parseSoloCatalogSubscription,
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
  };
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
        .then(() => {
          signal.throwIfAborted();
          return request();
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
    try {
      const results = await Promise.allSettled(
        editions.map((requested) =>
          this.loadEdition(requested, billingCycle, authenticated, controller.signal),
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

  private async loadEdition(
    edition: TokenPlanEdition,
    billingCycle: TokenPlanBillingCycle,
    authenticated: boolean,
    signal: AbortSignal,
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
      };
    }
    const commodityCode =
      edition === 'individual'
        ? site.features.tokenPlanCommodityCodes.soloBuy
        : site.features.tokenPlanCommodityCodes.teams;
    const trade = new TokenPlanTradeService(this.apiClient);
    const pricing = new TokenPlanCatalogPricing(this.apiClient);
    const [commodity, subscription, quota] = await Promise.all([
      query('GetCommodity', signal, () =>
        authenticated ? trade.getCommodity(edition, signal) : pricing.getCommodity(edition, signal),
      ),
      authenticated
        ? query<CatalogSubscription>(
            edition === 'individual' ? SOLO_SUBSCRIPTION_API : 'GetUserInstanceSummary',
            signal,
            async () => {
              if (edition === 'individual') {
                const result = await this.apiClient.callCsDataApi({
                  api: SOLO_SUBSCRIPTION_API,
                  data: { commodityCode },
                  signal,
                  parse: parseSoloCatalogSubscription,
                });
                let currentBillingCycle: TokenPlanBillingCycle | null = null;
                if (result.status === 'active' && result.instanceCode) {
                  try {
                    currentBillingCycle = await this.apiClient.callOrchestrationApi({
                      action: 'QueryInstance',
                      path: '/data/custom.json',
                      authMode: 'required',
                      params: {
                        instanceId: result.instanceCode,
                        commodityCode,
                        orderType: 'RENEW',
                      },
                      signal,
                      parse: parseSoloCatalogBillingCycle,
                    });
                  } catch {
                    // Keep the cycle unresolved when instance details cannot determine it;
                    // the confirmed VALID subscription remains active.
                  }
                }
                return {
                  status: result.status === 'active' ? 'active' : 'not_subscribed',
                  currentPlan: result.specCode,
                  currentBillingCycle,
                  subscribedPlans: new Set(result.specCode ? [result.specCode] : []),
                  diagnostics: [],
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
          )
        : skipped<CatalogSubscription>(),
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
    const subscriptionStatus = subscription.value?.status ?? 'unknown';
    const catalog = metadata.value ?? fallbackCatalogMetadata(edition);
    const catalogCommodity = metadata.value ? commodity.value : null;
    const tiers = catalog.tiers;
    const seats: Record<string, string> = { standard: 'standard', pro: 'pro', max: 'max' };
    const diagnostics = [
      ...metadata.diagnostics,
      ...subscription.diagnostics,
      ...(subscription.value?.diagnostics ?? []),
      ...quota.diagnostics,
    ];
    const rows = await Promise.all(
      tiers.map(async (tier) => {
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
        const seatType = edition === 'team' ? seats[specCode] : null;
        const individualTier = findTokenPlanIndividualTierBySpecCode(specCode);
        // quota-config is the only personal credit-limit source: weekly first, monthly as
        // fallback (pricing page card semantics: useMonthly = !hasWeekly && hasMonthly).
        const personalMonthlyCredits =
          limits != null && limits.weekly == null && limits.monthly != null ? limits.monthly : null;
        return {
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
          status:
            edition === 'individual'
              ? individualCatalogStatus(
                  subscription.value,
                  billingCycle,
                  specCode,
                  price.value,
                  inventory.value,
                )
              : teamCatalogStatus(subscription.value, price.value, inventory.value),
        };
      }),
    );
    if (
      rows.some((row) => row.name === null || (edition === 'team' && row.monthlyCredits === null))
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
    };
  }
}
