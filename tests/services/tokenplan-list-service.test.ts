/**
 * Integration coverage for TokenPlanListService.getTokenPlanList() catalog pricing.
 * Verifies that aggregated output prices come from QueryOrderLight discountedTotalPrice.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TokenPlanListService } from '../../src/services/tokenplan-list-service.js';
import { buildTokenPlanListViewModel } from '../../src/view-models/subscription/tokenplan-list.js';
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
import {
  API_TOKENPLAN_MODEL_PROVIDERS,
  API_TOKENPLAN_SUPPORTED_MODELS,
  API_TOKENPLAN_TOOL_CATALOG,
} from '../../src/types/api-routes.js';
import { HttpResponseError, ResponseParseError } from '../../src/api/base-client.js';
import { GatewayEnvelopeError, GatewayShapeError } from '../../src/api/request-adapter.js';
import { CliError } from '../../src/utils/errors.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

type OrchCall = CallOrchestrationApiOptions<unknown>;

function expansionClient(
  options: {
    authenticated?: boolean;
    modelFailure?: boolean;
    empty?: boolean;
    usage?: unknown;
    usageFailure?: boolean;
    quota?: Record<string, unknown>;
    teamActive?: boolean;
    teamSummary?: unknown;
    teamSummaryFailure?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const orchestration = buildOrchestrationHandler([]);
  return {
    calls,
    client: makeMockApiClient({
      orchestration: async (input) => {
        calls.push(input.action);
        return orchestration(input);
      },
      flat: async (input) => {
        calls.push(input.action);
        if (input.action === 'GetUserInstanceSummary')
          return { Data: options.teamActive ? [{ SpecType: 'standard', Quantity: 1 }] : [] };
        if (input.action === 'GetSeatSubscriptionSummary') {
          expect(input.params).toEqual({
            productCode: site.features.tokenPlanCommodityCodes.teams,
          });
          if (options.teamSummaryFailure) throw new Error('fixture summary failure');
          return options.teamSummary;
        }
        throw new Error('unexpected flat API');
      },
      csData: async (input) => {
        calls.push(input.api);
        if (input.api.endsWith('/quota-config'))
          return input.parse({
            data: {
              lite: { weekly: 0, monthly: 100 },
              essential: { monthly: 200 },
              standard: { weekly: 1e-7 },
              pro: {},
              ...options.quota,
            },
          });
        if (input.api.endsWith('/subscription') && options.authenticated)
          return input.parse({
            data: {
              status: 'VALID',
              specCode: 'essential',
              instanceCode: 'fixture-subscription',
              endTime: 1798761600000,
            },
          });
        if (input.api.endsWith('/usage') && options.authenticated) {
          if (options.usageFailure) throw new Error('fixture usage failure');
          return input.parse({ data: options.usage ?? { per1MonthPercentage: 0.25 } });
        }
        if (input.api === API_TOKENPLAN_MODEL_PROVIDERS)
          return input.parse({ data: [{ providerId: 'qwen', displayName: 'Qwen' }] });
        if (input.api === API_TOKENPLAN_SUPPORTED_MODELS) {
          if (options.modelFailure) throw new Error('fixture model failure');
          return input.parse({
            data: {
              total: options.empty ? 0 : 1,
              pageNo: 1,
              pageSize: 100,
              list: options.empty
                ? []
                : [
                    {
                      modelId: 'qwen-fixture',
                      provider: 'qwen',
                      name: '{"zh-CN":"千问测试"}',
                      capabilities: ['TG'],
                    },
                  ],
            },
          });
        }
        throw new Error('unexpected cs-data API');
      },
      envelope: async (input) => {
        calls.push(input.api);
        throw new Error('S01 must not read Harness catalog or account equities');
      },
    }),
  };
}

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

describe('S01 additive catalog data and lazy expansion', () => {
  it.each([0, 1])(
    'reads the personal remaining percentage at ratio boundary %s without estimating Credits',
    async (usedRatio) => {
      const { client, calls } = expansionClient({
        authenticated: true,
        usage: { per1MonthPercentage: usedRatio },
      });
      const result = await new TokenPlanListService(client).getTokenPlanList({
        authenticated: true,
        edition: 'individual',
      });
      expect(result.sections[0]!.currentPlanDetails).toMatchObject({
        totalCredits: '200',
        remainingCredits: null,
        usedPct: usedRatio * 100,
        remainingPct: (1 - usedRatio) * 100,
        quotaWindowType: 'monthly',
      });
      expect(calls.filter((call) => call.endsWith('/usage'))).toHaveLength(1);
      expect(calls).not.toContain('GetSeatSubscriptionSummary');
    },
  );

  it('keeps the weekly percentage separate from an unmatched monthly quota total', async () => {
    const { client } = expansionClient({
      authenticated: true,
      usage: { per1WeekPercentage: 0.25, per1MonthPercentage: 0.9 },
    });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      authenticated: true,
      edition: 'individual',
    });
    expect(result.sections[0]!.currentPlanDetails).toMatchObject({
      totalCredits: null,
      remainingCredits: null,
      usedPct: 25,
      remainingPct: 75,
      quotaWindowType: 'weekly',
    });
  });

  it.each([{ per1WeekPercentage: 2, per1MonthPercentage: 0.25 }, {}])(
    'keeps a missing or invalid personal ratio unknown: %j',
    async (usage) => {
      const { client } = expansionClient({ authenticated: true, usage });
      const result = await new TokenPlanListService(client).getTokenPlanList({
        authenticated: true,
        edition: 'individual',
      });
      expect(result.sections[0]!.currentPlanDetails?.remainingPct).toBeNull();
      expect(result.sections[0]!.currentPlanDetails?.usedPct).toBeNull();
      expect(result.sections[0]!.rows[0]!.price).toBe('99');
      expect(result.completeness).toBe('partial');
    },
  );

  it('retains trusted directory and subscription fields when personal usage fails', async () => {
    const { client } = expansionClient({ authenticated: true, usageFailure: true });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      authenticated: true,
      edition: 'individual',
    });
    expect(result.sections[0]!.currentPlanDetails).toMatchObject({
      subscriptionId: 'fixture-subscription',
      usedPct: null,
      remainingPct: null,
      remainingCredits: null,
    });
    expect(result.sections[0]!.rows[0]!.price).toBe('99');
    expect(result.completeness).toBe('partial');
  });

  it('reads Team end time and complete Credits totals from the summary without using a seat ID', async () => {
    const { client, calls } = expansionClient({
      authenticated: true,
      teamActive: true,
      teamSummary: {
        Success: true,
        Data: {
          ProductCode: site.features.tokenPlanCommodityCodes.teams,
          EndTime: '2027-01-01T00:00:00Z',
          SubscriptionGroupList: [
            {
              SpecType: 'standard',
              SubscriptionTotalNumber: 4,
              SubscriptionAssignedNumber: 1,
              SubscriptionList: [{ InstanceCode: 'fixture-seat-id' }],
              EquityList: [
                { EquityType: 'CALLS', TotalValue: '9', SurplusValue: '9' },
                { EquityType: 'CREDITS', TotalValue: '1000.000000000001', SurplusValue: '0' },
              ],
            },
          ],
        },
      },
    });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      authenticated: true,
      edition: 'team',
    });
    expect(result.sections[0]!.currentPlanDetails).toEqual({
      subscriptionId: null,
      endAt: '2027-01-01T00:00:00.000Z',
      totalCredits: '1000.000000000001',
      remainingCredits: '0',
    });
    expect(calls.filter((call) => call === 'GetSeatSubscriptionSummary')).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.endsWith('/usage') ||
          call === 'DescribeFrInstances' ||
          call === 'GetSubscriptionDetail',
      ),
    ).toBe(false);
  });

  it.each([true, false])(
    'aggregates Team seat types only when their refresh windows agree: %s',
    async (sameWindow) => {
      const groups = ['standard', 'pro'].map((SpecType, index) => ({
        SpecType,
        SubscriptionTotalNumber: 1,
        SubscriptionAssignedNumber: 1,
        NextCycleFlushTime:
          index === 0 || sameWindow ? '2027-01-01T00:00:00Z' : '2027-02-01T00:00:00Z',
        EquityList: [{ EquityType: 'CREDITS', TotalValue: '1000.1', SurplusValue: '750.05' }],
      }));
      const { client } = expansionClient({
        authenticated: true,
        teamActive: true,
        teamSummary: { Data: { EndTime: '2027-01-01T00:00:00Z', SubscriptionGroupList: groups } },
      });
      const result = await new TokenPlanListService(client).getTokenPlanList({
        authenticated: true,
        edition: 'team',
      });
      expect(result.sections[0]!.currentPlanDetails).toMatchObject({
        totalCredits: sameWindow ? '2000.2' : null,
        remainingCredits: sameWindow ? '1500.1' : null,
        endAt: '2027-01-01T00:00:00.000Z',
      });
      expect(result.completeness).toBe(sameWindow ? 'complete' : 'partial');
    },
  );

  it.each([
    { Data: {} },
    { Success: false, Data: { EndTime: '2027-01-01T00:00:00Z', SubscriptionGroupList: [] } },
  ])(
    'does not fill Team missing or unsuccessful summary fields with zero: %j',
    async (teamSummary) => {
      const { client } = expansionClient({ authenticated: true, teamActive: true, teamSummary });
      const result = await new TokenPlanListService(client).getTokenPlanList({
        authenticated: true,
        edition: 'team',
      });
      expect(result.sections[0]!.currentPlanDetails).toEqual({
        subscriptionId: null,
        endAt: null,
        totalCredits: null,
        remainingCredits: null,
      });
      expect(result.sections[0]!.rows[0]!.price).toBe('199');
      expect(result.completeness).toBe('partial');
    },
  );

  it('retains a trusted Team end time even when its quota groups are missing', async () => {
    const { client } = expansionClient({
      authenticated: true,
      teamActive: true,
      teamSummary: { Success: true, Data: { EndTime: '2027-01-01T00:00:00Z' } },
    });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      authenticated: true,
      edition: 'team',
    });
    expect(result.sections[0]!.currentPlanDetails).toEqual({
      subscriptionId: null,
      endAt: '2027-01-01T00:00:00.000Z',
      totalCredits: null,
      remainingCredits: null,
    });
    expect(result.completeness).toBe('partial');
  });

  it('does not query Team summary when no active Team subscription is confirmed', async () => {
    const { client, calls } = expansionClient({ authenticated: true });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      authenticated: true,
      edition: 'team',
    });
    expect(result.sections[0]!.currentPlanDetails).toBeNull();
    expect(calls).not.toContain('GetSeatSubscriptionSummary');
  });

  it('retains the Team catalog when its subscription summary request fails', async () => {
    const { client } = expansionClient({
      authenticated: true,
      teamActive: true,
      teamSummaryFailure: true,
    });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      authenticated: true,
      edition: 'team',
    });
    expect(result.sections[0]!.currentPlanDetails?.totalCredits).toBeNull();
    expect(result.sections[0]!.rows[0]!.price).toBe('199');
    expect(result.completeness).toBe('partial');
  });

  it('keeps both real personal windows, zero and precise decimals without inserting null strings', async () => {
    const { client, calls } = expansionClient();
    const result = await new TokenPlanListService(client).getTokenPlanList({
      edition: 'individual',
    });
    const plans = result.sections[0]!.plans!;
    expect(plans[0]!.quotaWindows).toEqual([
      { windowType: 'weekly', totalCredits: '0' },
      { windowType: 'monthly', totalCredits: '100' },
    ]);
    expect(plans[1]!.quotaWindows).toEqual([{ windowType: 'monthly', totalCredits: '200' }]);
    expect(plans[2]!.quotaWindows).toEqual([{ windowType: 'weekly', totalCredits: '0.0000001' }]);
    expect(plans[3]!.quotaWindows).toEqual([]);
    expect(result.sections[0]!.rows[0]!.weeklyCredits).toBe(0);
    expect(result.sections[0]!.rows[0]!.monthlyCredits).toBeNull();
    expect(
      plans.every(
        (plan) =>
          !Object.hasOwn(plan, 'supportedModels') && !Object.hasOwn(plan, 'harnessAllowances'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.includes('modelCenter') ||
          call.includes('Equity') ||
          call.includes('token-plan.detail') ||
          call.endsWith('/subscription'),
      ),
    ).toBe(false);
  });

  it('expands both editions using one provider request and no Harness requests', async () => {
    const { client, calls } = expansionClient({ authenticated: true });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      authenticated: true,
      includeModels: true,
    });
    expect(calls.filter((call) => call === API_TOKENPLAN_MODEL_PROVIDERS)).toHaveLength(1);
    expect(calls.filter((call) => call === API_TOKENPLAN_SUPPORTED_MODELS)).toHaveLength(2);
    expect(calls).not.toContain(API_TOKENPLAN_TOOL_CATALOG);
    expect(
      calls.some((call) => call.includes('Equity') || call.includes('DescribeFrInstances')),
    ).toBe(false);
    const individual = result.sections[0]!;
    expect(individual.currentPlanDetails).toEqual({
      subscriptionId: 'fixture-subscription',
      endAt: '2027-01-01T00:00:00.000Z',
      totalCredits: '200',
      remainingCredits: null,
      usedPct: 25,
      remainingPct: 75,
      quotaWindowType: 'monthly',
    });
    for (const section of result.sections) {
      expect(section.plans!.every((plan) => !Object.hasOwn(plan, 'harnessAllowances'))).toBe(true);
      expect(section.plans![0]!.supportedModels).toHaveLength(1);
    }
  });

  it('anonymous model expansion does not request Harness or add a login diagnostic', async () => {
    const { client, calls } = expansionClient({ quota: { pro: { weekly: 400 } } });
    const result = await new TokenPlanListService(client).getTokenPlanList({
      includeModels: true,
    });
    expect(result.completeness).toBe('complete');
    for (const section of result.sections) {
      expect(section.plans![0]!.supportedModels).toHaveLength(1);
      expect(section.plans!.every((plan) => !Object.hasOwn(plan, 'harnessAllowances'))).toBe(true);
      expect(section.currentPlanDetails).toBeNull();
      expect(section.diagnostics).toEqual([]);
    }
    expect(calls).not.toContain(API_TOKENPLAN_TOOL_CATALOG);
    expect(calls.some((call) => call.includes('Equity'))).toBe(false);
  });

  it('distinguishes model failure from successful empty models while retaining prices', async () => {
    const failed = expansionClient({ modelFailure: true, quota: { pro: { weekly: 400 } } });
    const failure = await new TokenPlanListService(failed.client).getTokenPlanList({
      edition: 'individual',
      includeModels: true,
    });
    expect(failure.sections[0]!.plans![0]!.supportedModels).toBeNull();
    expect(failure.sections[0]!.rows[0]!.price).toBe('99');
    expect(failure.completeness).toBe('partial');
    const empty = expansionClient({ empty: true, quota: { pro: { weekly: 400 } } });
    const success = await new TokenPlanListService(empty.client).getTokenPlanList({
      edition: 'individual',
      includeModels: true,
    });
    expect(success.sections[0]!.plans![0]!.supportedModels).toEqual([]);
    expect(success.completeness).toBe('complete');
  });

  it('unsupported team quarterly skips every interface including expansions', async () => {
    const { client, calls } = expansionClient();
    const result = await new TokenPlanListService(client).getTokenPlanList({
      edition: 'team',
      billingCycle: 'quarterly',
      authenticated: true,
      includeModels: true,
    });
    expect(calls).toEqual([]);
    expect(result.sections[0]!.plans).toEqual([]);
  });
});

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

describe('Personal Token Plan catalog quota diagnostics', () => {
  function quotaClient(data: Record<string, unknown>) {
    return makeMockApiClient({
      orchestration: buildOrchestrationHandler([]),
      csData: async (input) => {
        expect(input.api).toMatch(/\/quota-config$/);
        expect(input.authMode).toBe('none');
        return input.parse({ data });
      },
    });
  }

  const validQuota = {
    lite: { weekly: 100 },
    essential: { weekly: 200 },
    standard: { weekly: 300 },
    pro: { weekly: 400 },
  };

  it.each([
    { name: 'an empty configuration', data: {} },
    {
      name: 'a missing tier',
      data: {
        lite: validQuota.lite,
        essential: validQuota.essential,
        standard: validQuota.standard,
      },
    },
    { name: 'an empty tier', data: { ...validQuota, pro: {} } },
    { name: 'a tier without either main window', data: { ...validQuota, pro: { five_hour: 100 } } },
  ])('marks $name partial while retaining quotations', async ({ data }) => {
    const result = await new TokenPlanListService(quotaClient(data)).getTokenPlanList({
      edition: 'individual',
    });
    const section = result.sections[0]!;
    expect(result.completeness).toBe('partial');
    expect(section.rows.map((row) => row.price)).toEqual(['99', '149', '199', '399']);
    expect(section.rows.every((row) => row.inventory === true)).toBe(true);
    expect(section.rows[3]).toMatchObject({ monthlyCredits: null });
    expect(section.rows[3]).not.toHaveProperty('weeklyCredits');
    expect(section.plans![3]!.quotaWindows).toEqual([]);
    expect(section.diagnostics).toEqual([
      expect.objectContaining({ errorCode: 'INCOMPLETE_FIELDS' }),
    ]);
    expect(buildTokenPlanListViewModel(result).sections[0]!.diagnostics).toContain(
      'Pro credit limit is temporarily unavailable. Try again later.',
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '100', {}, []])(
    'retains diagnosis when invalid Weekly %j falls back to Monthly',
    async (weekly) => {
      const result = await new TokenPlanListService(
        quotaClient({ ...validQuota, lite: { weekly, monthly: 500 } }),
      ).getTokenPlanList({ edition: 'individual' });
      const section = result.sections[0]!;
      expect(result.completeness).toBe('partial');
      expect(section.rows[0]).toMatchObject({ price: '99', monthlyCredits: '500' });
      expect(section.rows[0]).not.toHaveProperty('weeklyCredits');
      expect(section.plans![0]!.quotaWindows).toEqual([
        { windowType: 'monthly', totalCredits: '500' },
      ]);
      expect(section.diagnostics).toEqual([
        expect.objectContaining({ errorCode: 'INVALID_WEEKLY_QUOTA' }),
      ]);
      const vm = buildTokenPlanListViewModel(result);
      expect(vm.sections[0]!.rows[0]).toMatchObject({
        quotaWindow: 'monthly',
        totalCredits: '500',
      });
      expect(vm.sections[0]!.diagnostics).toEqual(['The weekly credit limit is invalid.']);
      expect(vm.data.completeness).toBe('partial');
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '100', {}, []])(
    'diagnoses invalid Monthly %j while retaining valid Weekly',
    async (monthly) => {
      const result = await new TokenPlanListService(
        quotaClient({ ...validQuota, lite: { weekly: 100, monthly } }),
      ).getTokenPlanList({ edition: 'individual' });
      const section = result.sections[0]!;
      expect(result.completeness).toBe('partial');
      expect(section.rows[0]).toMatchObject({
        price: '99',
        weeklyCredits: 100,
        monthlyCredits: null,
      });
      expect(section.plans![0]!.quotaWindows).toEqual([
        { windowType: 'weekly', totalCredits: '100' },
      ]);
      expect(section.diagnostics).toEqual([
        expect.objectContaining({ errorCode: 'INVALID_MONTHLY_QUOTA' }),
      ]);
      const vm = buildTokenPlanListViewModel(result);
      expect(vm.sections[0]!.rows[0]).toMatchObject({ quotaWindow: 'weekly', totalCredits: '100' });
      expect(vm.sections[0]!.diagnostics).toEqual(['The monthly credit limit is invalid.']);
    },
  );

  it('diagnoses invalid main windows without supplying zero', async () => {
    const result = await new TokenPlanListService(
      quotaClient({ ...validQuota, lite: { weekly: -1, monthly: '500' } }),
    ).getTokenPlanList({ edition: 'individual' });
    expect(result.completeness).toBe('partial');
    expect(result.sections[0]!.plans![0]!.quotaWindows).toEqual([]);
    expect(result.sections[0]!.diagnostics).toEqual([
      expect.objectContaining({ errorCode: 'INVALID_WEEKLY_QUOTA' }),
      expect.objectContaining({ errorCode: 'INVALID_MONTHLY_QUOTA' }),
      expect.objectContaining({ errorCode: 'INCOMPLETE_FIELDS' }),
    ]);
  });

  it.each([
    [{ weekly: 0, monthly: 500 }, 0, null],
    [{ weekly: 100 }, 100, null],
    [{ weekly: null, monthly: 0 }, undefined, '0'],
    [{ monthly: 500 }, undefined, '500'],
  ] as const)(
    'keeps valid zero and optional missing windows complete: %j',
    async (quota, weekly, monthly) => {
      const result = await new TokenPlanListService(
        quotaClient({ ...validQuota, lite: quota }),
      ).getTokenPlanList({ edition: 'individual' });
      expect(result.completeness).toBe('complete');
      expect(result.sections[0]!.diagnostics).toEqual([]);
      expect(result.sections[0]!.rows[0]!.weeklyCredits).toBe(weekly);
      expect(result.sections[0]!.rows[0]!.monthlyCredits).toBe(monthly);
    },
  );
});

describe('Token Plan catalog silent connection recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    const remainingTimers = vi.getTimerCount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(remainingTimers).toBe(0);
  });

  function retryClient(action: string, failures: number, error: Error) {
    const attempts: OrchCall[] = [];
    const handler = buildOrchestrationHandler([]);
    const client = makeMockApiClient({
      orchestration: async (input) => {
        const target =
          input.action === action &&
          (action === 'GetCommodity' ||
            extractSpecFromConfig(input.params ?? {}).specCode === 'pro');
        if (target) {
          attempts.push(input);
          if (attempts.length <= failures) throw error;
        }
        return handler(input);
      },
      flat: async () => ({ Data: [] }),
      csData: async (input) =>
        input.parse({
          data: input.api.endsWith('/quota-config')
            ? Object.fromEntries(
                TOKEN_PLAN_INDIVIDUAL_TIERS.map(({ specCode }) => [specCode, { weekly: 1000 }]),
              )
            : null,
        }),
    });
    return { client, attempts };
  }

  const connectionReset = () =>
    new Error('Network request failed: fetch failed', {
      cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    });

  it.each(
    (['GetCommodity', 'QueryOrderLight', 'CheckInventory'] as const).flatMap((action) =>
      (['individual', 'team'] as const).flatMap((edition) =>
        [false, true].map((authenticated) => ({ action, edition, authenticated })),
      ),
    ),
  )(
    'silently recovers $action for $edition with authenticated=$authenticated',
    async ({ action, edition, authenticated }) => {
      const { client, attempts } = retryClient(action, 1, connectionReset());
      const pending = new TokenPlanListService(client).getTokenPlanList({ edition, authenticated });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.completeness).toBe('complete');
      expect(result.sections[0]!.diagnostics).toEqual([]);
      expect(result.sections[0]!.rows).toHaveLength(edition === 'individual' ? 4 : 3);
      expect(
        result.sections[0]!.rows.every((row) => row.price !== null && row.inventory === true),
      ).toBe(true);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({
        params: attempts[0]!.params,
        signal: attempts[0]!.signal,
        path: attempts[0]!.path,
        authMode: attempts[0]!.authMode,
      });
    },
  );

  it('retains the final diagnostic after exactly one failed retry', async () => {
    const { client, attempts } = retryClient('QueryOrderLight', Infinity, connectionReset());
    const pending = new TokenPlanListService(client).getTokenPlanList({ edition: 'team' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(attempts).toHaveLength(2);
    expect(result.completeness).toBe('partial');
    expect(result.sections[0]!.diagnostics).toEqual([
      expect.objectContaining({ api: 'TokenPlanPrice/pro', errorCode: 'NETWORK_ERROR' }),
    ]);
    expect(result.sections[0]!.rows.find((row) => row.specCode === 'pro')!.price).toBeNull();
    expect(
      result.sections[0]!.rows.filter((row) => row.specCode !== 'pro').every(
        (row) => row.price !== null,
      ),
    ).toBe(true);
  });

  it.each([
    new HttpResponseError(401, 'HTTP 401: Unauthorized'),
    new HttpResponseError(429, 'HTTP 429: Too Many Requests'),
    new HttpResponseError(503, 'HTTP 503: Service Unavailable'),
    new GatewayEnvelopeError('500', 'Network request failed: business rejection'),
    new GatewayShapeError('invalid response'),
    new CliError({ code: 'AUTH_REQUIRED', message: 'authentication required', exitCode: 2 }),
    new Error('Network request failed: invalid JSON', {
      cause: new ResponseParseError(new SyntaxError('invalid JSON')),
    }),
  ])('does not retry business, authentication, HTTP or parse failures: $name', async (error) => {
    const { client, attempts } = retryClient('QueryOrderLight', Infinity, error);
    const pending = new TokenPlanListService(client).getTokenPlanList({ edition: 'team' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(attempts).toHaveLength(1);
    expect(result.completeness).toBe('partial');
    expect(result.sections[0]!.diagnostics).toHaveLength(1);
  });

  it('stops immediately when cancelled during the retry delay', async () => {
    const { client, attempts } = retryClient('GetCommodity', Infinity, connectionReset());
    const controller = new AbortController();
    const pending = new TokenPlanListService(client).getTokenPlanList({
      edition: 'team',
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(1);
    controller.abort();
    await rejected;
    expect(attempts).toHaveLength(1);
  });

  it('does not extend the total deadline to finish the retry delay', async () => {
    const { client, attempts } = retryClient('GetCommodity', Infinity, connectionReset());
    const pending = new TokenPlanListService(client, 100).getTokenPlanList({ edition: 'team' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(attempts).toHaveLength(1);
    expect(result.sections[0]!.diagnostics).toContainEqual(
      expect.objectContaining({ api: 'GetCommodity', errorCode: 'TIMEOUT' }),
    );
  });

  it('cancels an in-flight retry at the original command deadline', async () => {
    const { client, attempts } = retryClient('GetCommodity', 1, connectionReset());
    const handler = client.callOrchestrationApi.getMockImplementation()!;
    client.callOrchestrationApi.mockImplementation(async (input: OrchCall) => {
      if (input.action === 'GetCommodity' && attempts.length === 1) {
        attempts.push(input);
        return new Promise<never>(() => {});
      }
      return handler(input);
    });
    const pending = new TokenPlanListService(client, 250).getTokenPlanList({ edition: 'team' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.signal!.aborted).toBe(true);
    expect(result.sections[0]!.diagnostics).toContainEqual(
      expect.objectContaining({ api: 'GetCommodity', errorCode: 'TIMEOUT' }),
    );
  });

  it('leaves non-catalog read failures to their existing recovery policy', async () => {
    const { client } = retryClient('GetCommodity', 0, connectionReset());
    client.callCsDataApi.mockRejectedValue(connectionReset());
    const pending = new TokenPlanListService(client).getTokenPlanList({ edition: 'individual' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(client.callCsDataApi).toHaveBeenCalledTimes(1);
    expect(result.sections[0]!.rows.every((row) => row.price !== null)).toBe(true);
    expect(result.sections[0]!.diagnostics).toContainEqual(
      expect.objectContaining({ errorCode: 'NETWORK_ERROR' }),
    );
  });
});

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
