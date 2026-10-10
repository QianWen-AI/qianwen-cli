/**
 * Integration coverage for TokenPlanListService.getTokenPlanList() catalog pricing.
 * Verifies that aggregated output prices come from QueryOrderLight discountedTotalPrice.
 */
import { describe, it, expect } from 'vitest';
import { TokenPlanListService } from '../../src/services/tokenplan-list-service.js';
import type {
  CallCsDataApiOptions,
  CallOrchestrationApiOptions,
} from '../../src/api/api-client.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import { site } from '../../src/site.js';
import type { TokenPlanEdition } from '../../src/types/tokenplan-subscription.js';
import type { TokenPlanBillingCycle } from '../../src/types/tokenplan-catalog.js';
import {
  TOKEN_PLAN_INDIVIDUAL_TIERS,
  findTokenPlanIndividualTierBySpecCode,
} from '../../src/types/tokenplan-tiers.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

type OrchCall = CallOrchestrationApiOptions<unknown>;

/** Pricing data mapping specCode to discountedTotalPrice in minor units. */
const SETTLEMENT_PRICES: Record<string, number> = {
  lite: 9900,
  essential: 14900,
  standard: 19900,
  pro: 39900,
  max: 139800,
};

/** Expected major-unit strings after dividing discountedTotalPrice by 100. */
const EXPECTED_YUAN: Record<string, string> = {
  lite: '99',
  essential: '149',
  standard: '199',
  pro: '399',
  max: '1398',
};

const TEAM_MONTHLY_CREDITS: Record<string, string> = {
  standard: '25000',
  pro: '100000',
  max: '250000',
};

/** Build a QueryOrderLight pricing response fixture. */
function lightResponse(
  edition: TokenPlanEdition,
  specCode: string,
  discountedTotalPrice: number,
): unknown {
  const tierKey = edition === 'individual' ? 'subscription_type' : 'plan_type';
  return {
    code: '200',
    price: {
      articleItemResults: [
        {
          articleItemName: 'Token Plan',
          price: { discountedTotalPrice },
          moduleResults: [
            {
              ...(edition === 'team' ? { moduleCode: 'subscription_spec' } : {}),
              moduleAttributeMap: {
                [tierKey]: specCode,
                ...(edition === 'team' ? { credit_value: TEAM_MONTHLY_CREDITS[specCode] } : {}),
              },
            },
          ],
        },
      ],
    },
  };
}

/** Extract specCode and edition from the QueryOrderLight configuration. */
function extractSpecFromConfig(params: Record<string, unknown>): {
  specCode: string;
  edition: TokenPlanEdition;
} {
  const commodityCode = params.commodityCode as string;
  const edition: TokenPlanEdition =
    commodityCode === site.features.tokenPlanCommodityCodes.soloBuy ? 'individual' : 'team';
  const tierKey = edition === 'individual' ? 'subscription_type' : 'plan_type';
  const components = params.components as Array<{
    componentCode: string;
    instanceProperty: Array<{ code: string; value: string }>;
  }>;
  for (const comp of components ?? []) {
    for (const prop of comp.instanceProperty ?? []) {
      if (prop.code === tierKey) return { specCode: prop.value, edition };
    }
  }
  return { specCode: 'unknown', edition };
}

/** Extract the ord_time component value from QueryOrderLight parameters. */
function extractOrdTime(params: Record<string, unknown>): string | null {
  const components = params.components as Array<{
    componentCode: string;
    instanceProperty: Array<{ code: string; value: string }>;
  }>;
  for (const comp of components ?? []) {
    if (comp.componentCode === 'ord_time') {
      for (const prop of comp.instanceProperty ?? []) {
        if (prop.code === 'ord_time') return prop.value;
      }
    }
  }
  return null;
}

function commodityResponse(
  edition: TokenPlanEdition,
  individualSpecs: readonly string[] = TOKEN_PLAN_INDIVIDUAL_TIERS.map((tier) => tier.specCode),
  teamCredits: Record<string, string> = TEAM_MONTHLY_CREDITS,
) {
  const individual = edition === 'individual';
  const commodityCode = individual
    ? site.features.tokenPlanCommodityCodes.soloBuy
    : site.features.tokenPlanCommodityCodes.teams;
  const tierKey = individual ? 'subscription_type' : 'plan_type';
  const specs = individual ? individualSpecs : ['standard', 'pro', 'max'];
  const choices = specs.map((specCode) => ({
    value: specCode,
    text: individual
      ? (findTokenPlanIndividualTierBySpecCode(specCode)?.name ?? specCode)
      : ({ standard: 'Standard Seat', pro: 'Pro Seat', max: 'Max Seat' }[specCode] ?? specCode),
  }));
  return {
    successResponse: true,
    viewModel: { id: commodityCode, commodityCode },
    componentsMeta: {
      [individual ? 'subscription_type' : 'subscription_spec']: {
        name: individual ? '套餐类型' : '权益规格',
        required: true,
      },
      ord_time: { name: '购买时长', required: true },
      region: { name: '地域', required: true },
    },
    components: {
      [tierKey]: { [tierKey]: choices },
      ord_time: {
        ord_time: [
          { value: '1:Month', text: '月付' },
          { value: '3:Month', text: '季付' },
          { value: '1:Year', text: '年付' },
        ],
      },
      region: { region: [{ value: 'cn-beijing', text: '北京' }] },
      ...(individual
        ? {}
        : {
            credit_value: {
              credit_value: Object.values(teamCredits).map((value) => ({
                value,
                text: 'Credits额度',
              })),
            },
            subscription_spec: {
              quota_cycle: [{ value: 'byDynamicMonth', text: '自然月' }],
            },
          }),
    },
    constraint: individual
      ? {}
      : {
          credit_value: {
            plan_type: Object.fromEntries(
              Object.entries(teamCredits).map(([spec, value]) => [spec, [value]]),
            ),
          },
        },
  };
}

// ─── Mock Builder ────────────────────────────────────────────────────────

/**
 * Build an orchestration API handler that records every call.
 *
 * - GetCommodity returns metadata for available tiers.
 * - QueryOrderLight returns prices based on discountedTotalPrice.
 * - CheckInventory reports available inventory.
 */
function buildOrchestrationHandler(
  calls: OrchCall[],
  options: {
    individualSpecs?: readonly string[];
    individualBillingCycle?: string;
    teamCredits?: Record<string, string>;
  } = {},
) {
  return async (opts: OrchCall): Promise<unknown> => {
    calls.push(opts);

    if (opts.action === 'GetCommodity') {
      const commodityCode = (opts.params as Record<string, unknown>).commodityCode;
      const edition =
        commodityCode === site.features.tokenPlanCommodityCodes.soloBuy ? 'individual' : 'team';
      return opts.parse(commodityResponse(edition, options.individualSpecs, options.teamCredits));
    }

    if (opts.action === 'QueryOrderLight') {
      const { specCode, edition } = extractSpecFromConfig(opts.params as Record<string, unknown>);
      const price = SETTLEMENT_PRICES[specCode] ?? 10000;
      return opts.parse(lightResponse(edition, specCode, price));
    }

    if (opts.action === 'QueryInstance') {
      return opts.parse({
        instanceComponents: [
          {
            componentCode: 'ord_time',
            instanceProperty: [
              { code: 'ord_time', value: options.individualBillingCycle ?? '1:Month' },
            ],
          },
        ],
      });
    }

    if (opts.action === 'CheckInventory') {
      return opts.parse({ available: true });
    }

    throw new Error(`Unexpected orchestration action: ${opts.action}`);
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('TokenPlanListService.getTokenPlanList QueryOrderLight pricing integration', () => {
  it('reports unsupported team quarterly billing without duplicate diagnostics', async () => {
    const calls: OrchCall[] = [];
    const apiClient = makeMockApiClient({
      orchestration: buildOrchestrationHandler(calls),
    });

    const result = await new TokenPlanListService(apiClient, 10_000).getTokenPlanList({
      edition: 'team',
      billingCycle: 'quarterly',
      authenticated: true,
    });

    expect(result.completeness).toBe('complete');
    expect(result.sections).toEqual([
      expect.objectContaining({
        edition: 'team',
        billingCycleSupported: false,
        rows: [],
        diagnostics: [],
      }),
    ]);
    expect(calls).toHaveLength(0);
  });

  it('uses QueryOrderLight with the expected action, path, and auth mode for all anonymous editions', async () => {
    const calls: OrchCall[] = [];
    const apiClient = makeMockApiClient({
      orchestration: buildOrchestrationHandler(calls),
      csData: async (opts) => {
        expect(opts.authMode).toBe('none');
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { weekly: 2500 },
              essential: { weekly: 3500 },
              standard: { weekly: 5000 },
              pro: { weekly: 10000 },
            },
          });
        }
        throw new Error(`Unexpected cs-data API: ${opts.api}`);
      },
    });
    const service = new TokenPlanListService(apiClient, 10_000);

    const result = await service.getTokenPlanList({
      edition: 'all',
      billingCycle: 'monthly',
      authenticated: false,
    });

    const commodityCalls = calls.filter((call) => call.action === 'GetCommodity');
    expect(commodityCalls).toHaveLength(2);
    for (const call of commodityCalls) {
      expect(call.path).toBe('/data/publicCustom.json');
      expect(call.authMode).toBe('none');
    }
    expect(apiClient.callFlatApi).not.toHaveBeenCalled();

    // Select pricing calls, excluding CheckInventory.
    const pricingCalls = calls.filter((c) => c.action === 'QueryOrderLight');

    // Individual has four tiers and team has three, producing seven pricing calls.
    expect(pricingCalls).toHaveLength(7);

    // Every pricing call uses the expected QueryOrderLight action, path, and auth mode.
    for (const call of pricingCalls) {
      expect(call.action).toBe('QueryOrderLight');
      expect(call.path).toBe('/data/publicCustom.json');
      expect(call.authMode).toBe('none');
    }
    const anonymousTeamConfigurations = pricingCalls
      .filter(
        (call) =>
          (call.params as Record<string, unknown>).commodityCode ===
          site.features.tokenPlanCommodityCodes.teams,
      )
      .map((call) => call.params as { components: Array<{ componentCode: string }> });
    for (const configuration of anonymousTeamConfigurations) {
      expect(configuration.components.map((component) => component.componentCode)).toEqual([
        'subscription_spec',
        'ord_time',
        'region',
      ]);
    }

    // Output section prices match the mocked discountedTotalPrice values.
    expect(result.sections).toHaveLength(2);

    const individualSection = result.sections.find((s) => s.edition === 'individual')!;
    expect(individualSection).toBeDefined();
    expect(individualSection.rows.map((row) => row.specCode)).toEqual([
      'lite',
      'essential',
      'standard',
      'pro',
    ]);
    for (const row of individualSection.rows) {
      expect(row.price).toBe(EXPECTED_YUAN[row.specCode]);
      expect(row.currency).toBe('CNY');
    }
    expect(individualSection.rows.map((row) => row.weeklyCredits)).toEqual([
      2500, 3500, 5000, 10000,
    ]);

    const teamSection = result.sections.find((s) => s.edition === 'team')!;
    expect(teamSection).toBeDefined();
    expect(teamSection.rows.map((row) => [row.specCode, row.seatType, row.name])).toEqual([
      ['standard', 'standard', 'Standard Seat'],
      ['pro', 'pro', 'Pro Seat'],
      ['max', 'max', 'Max Seat'],
    ]);
    for (const row of teamSection.rows) {
      expect(row.price).toBe(EXPECTED_YUAN[row.specCode]);
      expect(row.currency).toBe('CNY');
      expect(row.monthlyCredits).toBe(TEAM_MONTHLY_CREDITS[row.specCode]);
    }
  });

  it('uses the private GetCommodity route and optional authentication for public pricing when signed in', async () => {
    const calls: OrchCall[] = [];
    const apiClient = makeMockApiClient({
      orchestration: buildOrchestrationHandler(calls),
      // Unmocked account-scoped and flat calls fail inside query without blocking pricing calls.
    });
    const service = new TokenPlanListService(apiClient, 10_000);

    const result = await service.getTokenPlanList({
      edition: 'all',
      billingCycle: 'monthly',
      authenticated: true,
    });

    const pricingCalls = calls.filter((c) => c.action === 'QueryOrderLight');
    expect(pricingCalls).toHaveLength(7);
    const commodityCalls = calls.filter((c) => c.action === 'GetCommodity');
    expect(commodityCalls).toHaveLength(2);
    for (const call of commodityCalls) {
      expect(call.path).toBe('/data/custom.json');
      expect(call.authMode).toBe('required');
    }

    for (const call of pricingCalls) {
      expect(call.action).toBe('QueryOrderLight');
      expect(call.path).toBe('/data/publicCustom.json');
      expect(call.authMode).toBe('optional');
    }

    // Pricing data remains available when subscription queries fail.
    expect(result.sections).toHaveLength(2);
    for (const section of result.sections) {
      for (const row of section.rows) {
        expect(row.price).not.toBeNull();
      }
    }
    const individual = result.sections.find((section) => section.edition === 'individual')!;
    for (const row of individual.rows) {
      expect(row).not.toHaveProperty('weeklyCredits');
      expect(row).not.toHaveProperty('fiveHourCredits');
    }
  });

  it.each([false, true])(
    'lists only individual tiers declared by GetCommodity when authenticated=%s',
    async (authenticated) => {
      const calls: OrchCall[] = [];
      const result = await new TokenPlanListService(
        makeMockApiClient({
          orchestration: buildOrchestrationHandler(calls, {
            individualSpecs: ['lite', 'standard', 'pro'],
          }),
        }),
        10_000,
      ).getTokenPlanList({
        edition: 'individual',
        billingCycle: 'monthly',
        authenticated,
      });

      expect(result.sections[0]?.rows.map((row) => row.specCode)).toEqual([
        'lite',
        'standard',
        'pro',
      ]);
      expect(
        calls
          .filter((call) => call.action === 'QueryOrderLight')
          .map((call) => extractSpecFromConfig(call.params as Record<string, unknown>).specCode),
      ).toEqual(['lite', 'standard', 'pro']);
    },
  );

  it('uses updated catalog Credits in anonymous quote and stock requests', async () => {
    const calls: OrchCall[] = [];
    const teamCredits = { standard: '30000', pro: '120000', max: '300000' };
    const result = await new TokenPlanListService(
      makeMockApiClient({
        orchestration: buildOrchestrationHandler(calls, { teamCredits }),
      }),
    ).getTokenPlanList({ edition: 'team', authenticated: false });

    const queries = calls.filter((call) =>
      ['QueryOrderLight', 'CheckInventory'].includes(call.action),
    );
    expect(queries).toHaveLength(6);
    for (const call of queries) {
      const { specCode } = extractSpecFromConfig(call.params as Record<string, unknown>);
      expect(call.params).toMatchObject({
        components: expect.arrayContaining([
          expect.objectContaining({
            componentCode: 'subscription_spec',
            instanceProperty: expect.arrayContaining([
              expect.objectContaining({
                code: 'credit_value',
                value: teamCredits[specCode as keyof typeof teamCredits],
              }),
            ]),
          }),
        ]),
      });
    }
    expect(result.sections[0]?.rows.map((row) => row.monthlyCredits)).toEqual([
      '30000',
      '120000',
      '300000',
    ]);
    expect(result.completeness).toBe('complete');
  });

  it.each(['request', 'response', 'configuration'] as const)(
    'does not quote static specifications when anonymous catalog %s fails',
    async (failure) => {
      const calls: OrchCall[] = [];
      const result = await new TokenPlanListService(
        makeMockApiClient({
          orchestration: async (opts) => {
            calls.push(opts);
            if (failure === 'request') throw new Error('metadata unavailable');
            const data = commodityResponse('team');
            return opts.parse(
              failure === 'response' ? { ...data, viewModel: {} } : { ...data, constraint: {} },
            );
          },
        }),
      ).getTokenPlanList({ edition: 'team', authenticated: false });

      expect(calls.map((call) => call.action)).toEqual(['GetCommodity']);
      expect(result.completeness).toBe('unknown');
      expect(result.sections[0]?.rows).toHaveLength(3);
      for (const row of result.sections[0]!.rows) {
        expect(row).toMatchObject({
          price: null,
          inventory: null,
          monthlyCredits: null,
          status: 'unknown',
        });
      }
      expect(result.sections[0]?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            api: failure === 'configuration' ? 'Configuration/standard' : 'GetCommodity',
          }),
        ]),
      );
    },
  );

  it('keeps the catalog unknown when only subscription status is available', async () => {
    const apiClient = makeMockApiClient({
      orchestration: async (opts) => {
        if (opts.action === 'GetCommodity') throw new Error('catalog unavailable');
        throw new Error(`Unexpected orchestration API: ${opts.action}`);
      },
      csData: async (opts) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({ code: 'SUCCESS', success: true });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({ data: {} });
        }
        throw new Error(`Unexpected cs-data API: ${opts.api}`);
      },
    });

    const result = await new TokenPlanListService(apiClient, 10_000).getTokenPlanList({
      edition: 'individual',
      billingCycle: 'monthly',
      authenticated: true,
    });

    expect(result.sections[0]?.subscriptionStatus).toBe('not_subscribed');
    expect(result.sections[0]?.rows.map((row) => [row.specCode, row.status])).toEqual([
      ['lite', 'unknown'],
      ['essential', 'unknown'],
      ['standard', 'unknown'],
      ['pro', 'unknown'],
    ]);
    expect(result.completeness).toBe('unknown');
  });

  it('links active subscriptions to the matching Token Plan edition page', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      orchestration: buildOrchestrationHandler([]),
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            data: {
              instanceCode: 'personal-instance',
              specCode: 'lite',
              remainingDays: 30,
              startTime: now - 60_000,
              endTime: now + 2_592_000_000,
              autoRenewFlag: false,
              status: 'VALID',
            },
          });
        }
        throw new Error(`Unexpected cs-data API: ${opts.api}`);
      },
      flat: async (opts) => {
        if (opts.action === 'GetUserInstanceSummary') {
          return [
            { SpecType: 'standard', Quantity: 0, Status: 'valid' },
            { SpecType: 'standard', Quantity: 1, Status: 'invalid' },
            { SpecType: 'pro', Status: 'expired' },
          ];
        }
        throw new Error(`Unexpected flat API: ${opts.action}`);
      },
    });

    const result = await new TokenPlanListService(apiClient, 10_000).getTokenPlanList({
      edition: 'all',
      billingCycle: 'monthly',
      authenticated: true,
    });

    expect(
      result.sections.find((section) => section.edition === 'individual')?.subscriptionUrl,
    ).toBe('https://platform.qianwenai.com/home/analytics/token-plan/individual');
    expect(result.sections.find((section) => section.edition === 'team')?.subscriptionUrl).toBe(
      'https://platform.qianwenai.com/home/analytics/token-plan/team',
    );
    expect(
      result.sections
        .find((section) => section.edition === 'team')
        ?.rows.map((row) => [row.seatType, row.status]),
    ).toEqual([
      ['standard', 'subscribed'],
      ['pro', 'subscribed'],
      ['max', 'subscribed'],
    ]);
  });

  it('renders subscribed, upgrade, and unavailable states from the individual tier and billing cycle', async () => {
    const csDataHandler = async (opts: CallCsDataApiOptions<unknown>): Promise<unknown> => {
      if (opts.api.endsWith('/subscription')) {
        return opts.parse({
          data: { status: 'VALID', instanceCode: 'personal-instance', specCode: 'lite' },
        });
      }
      throw new Error(`Unexpected cs-data API: ${opts.api}`);
    };
    const monthly = await new TokenPlanListService(
      makeMockApiClient({
        orchestration: buildOrchestrationHandler([], { individualBillingCycle: '1:Month' }),
        csData: csDataHandler,
      }),
      10_000,
    ).getTokenPlanList({
      edition: 'individual',
      billingCycle: 'monthly',
      authenticated: true,
    });
    expect(monthly.sections[0]?.rows.map((row) => [row.specCode, row.status])).toEqual([
      ['lite', 'subscribed'],
      ['essential', 'upgrade'],
      ['standard', 'upgrade'],
      ['pro', 'upgrade'],
    ]);

    const quarterly = await new TokenPlanListService(
      makeMockApiClient({
        orchestration: buildOrchestrationHandler([], { individualBillingCycle: '1:Month' }),
        csData: csDataHandler,
      }),
      10_000,
    ).getTokenPlanList({
      edition: 'individual',
      billingCycle: 'quarterly',
      authenticated: true,
    });
    expect(quarterly.sections[0]?.rows.map((row) => row.status)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });

  it('keeps team status not_subscribed when total Quantity is zero without reading instance Status', async () => {
    const result = await new TokenPlanListService(
      makeMockApiClient({
        orchestration: buildOrchestrationHandler([]),
        flat: async (opts) => {
          if (opts.action === 'GetUserInstanceSummary') {
            return { Data: [{ SpecType: 'standard', Quantity: 0, Status: 'valid' }] };
          }
          throw new Error(`Unexpected flat API: ${opts.action}`);
        },
      }),
      10_000,
    ).getTokenPlanList({
      edition: 'team',
      billingCycle: 'monthly',
      authenticated: true,
    });

    expect(result.sections[0]?.subscriptionStatus).toBe('not_subscribed');
    expect(result.sections[0]?.rows.map((row) => row.status)).toEqual([
      'purchasable',
      'purchasable',
      'purchasable',
    ]);
  });

  it('prefers weekly quota when weekly and monthly configurations both exist', async () => {
    const calls: OrchCall[] = [];
    const apiClient = makeMockApiClient({
      orchestration: buildOrchestrationHandler(calls),
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({ code: 'SUCCESS', success: true });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { weekly: 2500, monthly: 11500, five_hour: 700 },
              essential: { weekly: 3500, monthly: 25500, five_hour: 980 },
              standard: { weekly: 5000, monthly: 45000, five_hour: 1400 },
              pro: { weekly: 10000, monthly: 180000, five_hour: 2800 },
            },
          });
        }
        throw new Error(`Unexpected cs-data API: ${opts.api}`);
      },
    });

    const result = await new TokenPlanListService(apiClient, 10_000).getTokenPlanList({
      edition: 'individual',
      billingCycle: 'monthly',
      authenticated: true,
    });

    expect(result.sections[0]?.rows.map((row) => row.weeklyCredits)).toEqual([
      2500, 3500, 5000, 10000,
    ]);
    // weekly present → monthly must not override the personal monthlyCredits field.
    expect(result.sections[0]?.rows.map((row) => row.monthlyCredits)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    for (const row of result.sections[0]?.rows ?? []) {
      expect(row).not.toHaveProperty('fiveHourCredits');
    }
  });

  it('falls back to monthly quota when weekly is absent and ignores addon_quota', async () => {
    const calls: OrchCall[] = [];
    const apiClient = makeMockApiClient({
      orchestration: buildOrchestrationHandler(calls),
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({ code: 'SUCCESS', success: true });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { five_hour: 700, monthly: 11500 },
              essential: { five_hour: 1800, monthly: 25500 },
              standard: { five_hour: 3000, monthly: 45000 },
              pro: { five_hour: 12000, monthly: 180000 },
              addon_quota: { extrabundle: 20000 },
            },
          });
        }
        throw new Error(`Unexpected cs-data API: ${opts.api}`);
      },
    });

    const result = await new TokenPlanListService(apiClient, 10_000).getTokenPlanList({
      edition: 'individual',
      billingCycle: 'monthly',
      authenticated: true,
    });

    const rows = result.sections[0]?.rows ?? [];
    expect(rows.map((row) => row.specCode)).toEqual(['lite', 'essential', 'standard', 'pro']);
    for (const row of rows) {
      expect(row).not.toHaveProperty('weeklyCredits');
    }
    // monthly (number) is normalized to a string to match the TokenPlanListRow contract.
    expect(rows.map((row) => row.monthlyCredits)).toEqual(['11500', '25500', '45000', '180000']);
  });

  it.each([
    ['monthly', '1:Month'],
    ['quarterly', '3:Month'],
    ['yearly', '1:Year'],
  ] as const)(
    'maps billingCycle %s to ord_time component value %s',
    async (billingCycle, expectedOrdTime) => {
      const calls: OrchCall[] = [];
      const apiClient = makeMockApiClient({
        orchestration: buildOrchestrationHandler(calls),
      });
      const service = new TokenPlanListService(apiClient, 10_000);

      // Use the individual edition because team quarterly pricing is unsupported.
      await service.getTokenPlanList({
        edition: 'individual',
        billingCycle: billingCycle as TokenPlanBillingCycle,
        authenticated: false,
      });

      const pricingCalls = calls.filter((c) => c.action === 'QueryOrderLight');
      // The four individual tiers produce four pricing calls.
      expect(pricingCalls).toHaveLength(4);

      for (const call of pricingCalls) {
        const ordTime = extractOrdTime(call.params as Record<string, unknown>);
        expect(ordTime).toBe(expectedOrdTime);
      }
    },
  );
});
