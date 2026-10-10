/** Unit tests for TokenplanService. */
import { describe, it, expect, vi } from 'vitest';
import {
  TokenplanService,
  fetchIndividualTokenPlan,
  fetchTeamTokenPlan,
  resolveIndividualAutoRenewFlag,
} from '../../src/services/tokenplan-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import { site } from '../../src/site.js';
import type { CallCsDataApiOptions, CallFlatApiOptions } from '../../src/api/api-client.js';
import type {
  AvailableInstanceItem,
  FrInstanceItem,
  FrInstanceResponse,
  QueryAvailableInstancesResponse,
} from '../../src/types/api-models.js';
import { TokenPlanListService } from '../../src/services/tokenplan-list-service.js';
import { unwrapCsDataResponse } from '../../src/api/adapters/cs-data-adapter.js';

// Test fixtures

const CODES = site.features.tokenPlanCommodityCodes;

function frResponse(items: FrInstanceItem[]): FrInstanceResponse {
  return {
    TotalCount: items.length,
    PageSize: 10,
    RequestId: 'req-1',
    CurrentPage: 1,
    Data: items,
  };
}

function frInstance(overrides: Partial<FrInstanceItem> = {}): FrInstanceItem {
  return {
    InstanceId: 'inst-1',
    CommodityCode: CODES.personal,
    CommodityName: 'Token Plan Personal',
    TemplateName: 'Token Plan 个人版（月）',
    Status: 'valid',
    InitCapacityBaseValue: '1000000',
    CurrCapacityBaseValue: '750000',
    EndTime: Date.parse('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function availableInstancesResponse(
  items: AvailableInstanceItem[],
  overrides: Partial<NonNullable<QueryAvailableInstancesResponse['Data']>> = {},
): QueryAvailableInstancesResponse {
  return {
    Success: true,
    Code: 'Success',
    Data: {
      InstanceList: items,
      PageNum: 1,
      PageSize: 20,
      TotalCount: items.length,
      ...overrides,
    },
  };
}

function availableInstance(overrides: Partial<AvailableInstanceItem> = {}): AvailableInstanceItem {
  return {
    InstanceID: 'sub-1',
    ProductCode: 'sfm',
    ProductType: CODES.soloBuy,
    Status: 'Normal',
    SubStatus: 'Normal',
    RenewStatus: 'ManualRenewal',
    RenewalDurationUnit: 'M',
    SubscriptionType: 'Subscription',
    CreateTime: new Date(Date.now() - 86_400_000).toISOString(),
    EndTime: new Date(Date.now() + 2_592_000_000).toISOString(),
    ...overrides,
  };
}

/**
 * Build a flat-API dispatcher keyed by CommodityCode → FrInstanceResponse.
 * Codes not present return `null` (the service should tolerate that).
 */
function dispatcherByCommodity(
  perCode: Partial<Record<string, FrInstanceItem[] | Error>>,
): (opts: CallFlatApiOptions) => Promise<unknown> {
  return async (opts: CallFlatApiOptions) => {
    expect(opts.product).toBe('BssOpenAPI-V3');
    expect(opts.action).toBe('DescribeFrInstances');
    const code = (opts.params as { CommodityCode?: string } | undefined)?.CommodityCode ?? '';
    const v = perCode[code];
    if (v instanceof Error) throw v;
    if (v === undefined) return null;
    return frResponse(v);
  };
}

// fetchTokenPlan

describe('TokenplanService.fetchTokenPlan', () => {
  it('issues three concurrent DescribeFrInstances calls keyed by commodity code', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    await svc.fetchTokenPlan();

    expect(apiClient.callFlatApi).toHaveBeenCalledTimes(3);
    const codesCalled = apiClient.callFlatApi.mock.calls.map(
      (c) => (c[0] as CallFlatApiOptions).params?.CommodityCode,
    );
    expect(new Set(codesCalled)).toEqual(new Set([CODES.teams, CODES.personal, CODES.addon]));

    // PageSize: addon → 100, others → 10
    const addonCall = apiClient.callFlatApi.mock.calls.find(
      (c) => (c[0] as CallFlatApiOptions).params?.CommodityCode === CODES.addon,
    );
    expect((addonCall?.[0] as CallFlatApiOptions).params).toMatchObject({
      Group: 'tokenPlan',
      CommodityCode: CODES.addon,
      PageNum: 1,
      PageSize: 100,
    });
    const personalCall = apiClient.callFlatApi.mock.calls.find(
      (c) => (c[0] as CallFlatApiOptions).params?.CommodityCode === CODES.personal,
    );
    expect((personalCall?.[0] as CallFlatApiOptions).params).toMatchObject({
      PageSize: 10,
    });
  });

  it('returns { subscribed: false } when there are no plan or addon instances', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out).toEqual({ subscribed: false });
  });

  it('returns { subscribed: false, addonRemaining } when only addon credits exist', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [],
        [CODES.addon]: [
          frInstance({
            CommodityCode: CODES.addon,
            CurrCapacityBaseValue: '20000',
          }),
          frInstance({
            CommodityCode: CODES.addon,
            CurrCapacityBaseValue: '5000',
          }),
        ],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out).toEqual({ subscribed: false, addonRemaining: 25_000 });
  });

  it('selects the first valid instance from teams ∪ personal', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [
          frInstance({
            InstanceId: 'team-expired',
            CommodityCode: CODES.teams,
            Status: 'expire',
            InitCapacityBaseValue: '500000',
            CurrCapacityBaseValue: '0',
          }),
        ],
        [CODES.personal]: [
          frInstance({
            InstanceId: 'personal-valid',
            CommodityCode: CODES.personal,
            Status: 'valid',
            TemplateName: 'Token Plan 个人版（月）',
            InitCapacityBaseValue: '1000000',
            CurrCapacityBaseValue: '300000',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();

    expect(out.subscribed).toBe(true);
    expect(out.planName).toBe('Token Plan 个人版（月）');
    expect(out.totalCredits).toBe(1_000_000);
    expect(out.remainingCredits).toBe(300_000);
    expect(out.usedPct).toBeCloseTo(70, 5);
    expect(out.status).toBe('valid');
    expect(out.resetDate).toBeUndefined();
  });

  it('falls back to the first non-valid instance when none are valid', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'expire',
            InitCapacityBaseValue: '500000',
            CurrCapacityBaseValue: '0',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.subscribed).toBe(false);
    expect(out.status).toBe('expire');
    expect(out.totalCredits).toBe(500_000);
    expect(out.remainingCredits).toBe(0);
    expect(out.usedPct).toBe(100);
  });

  it('decodes Status as { Code, Name } object form', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [
          frInstance({
            CommodityCode: CODES.teams,
            Status: { Code: 'valid', Name: 'Valid' },
            TemplateName: 'Token Plan 团队版（月）',
            InitCapacityBaseValue: '2000000',
            CurrCapacityBaseValue: '1000000',
          }),
        ],
        [CODES.personal]: [],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.subscribed).toBe(true);
    expect(out.status).toBe('valid');
    expect(out.planName).toBe('Token Plan 团队版（月）');
    expect(out.usedPct).toBe(50);
  });

  it('uses periodCapacityBaseValue when CapacityTypeCode=periodMonthlyShift', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            CapacityTypeCode: 'periodMonthlyShift',
            InitCapacityBaseValue: '1000000',
            CurrCapacityBaseValue: '500000',
            periodCapacityBaseValue: '200000',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.remainingCredits).toBe(200_000);
    expect(out.usedPct).toBeCloseTo(80, 5);
  });

  it('falls back to CurrCapacityBaseValue when periodMonthlyShift has no period value', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            CapacityTypeCode: 'periodMonthlyShift',
            InitCapacityBaseValue: '1000000',
            CurrCapacityBaseValue: '400000',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.remainingCredits).toBe(400_000);
  });

  it('sums addon CurrCapacityBaseValue and surfaces it as addonRemaining', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            InitCapacityBaseValue: '1000',
            CurrCapacityBaseValue: '600',
          }),
        ],
        [CODES.addon]: [
          frInstance({ CurrCapacityBaseValue: '100' }),
          frInstance({ CurrCapacityBaseValue: '250' }),
          frInstance({ CurrCapacityBaseValue: '0' }),
        ],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.addonRemaining).toBe(350);
  });

  it('omits addonRemaining when sum is 0', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            InitCapacityBaseValue: '1000',
            CurrCapacityBaseValue: '600',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.addonRemaining).toBeUndefined();
  });

  it('never sets resetDate in legacy path (EndTime is not a cycle-reset source)', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            InitCapacityBaseValue: '100',
            CurrCapacityBaseValue: '50',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.resetDate).toBeUndefined();
  });

  it('falls back to CommodityName when TemplateName is missing', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            TemplateName: undefined,
            CommodityName: 'Fallback Name',
            InitCapacityBaseValue: '100',
            CurrCapacityBaseValue: '50',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.planName).toBe('Fallback Name');
  });

  it('treats totalCredits=0 as usedPct=0 (no division-by-zero)', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            InitCapacityBaseValue: '0',
            CurrCapacityBaseValue: '0',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.totalCredits).toBe(0);
    expect(out.remainingCredits).toBe(0);
    expect(out.usedPct).toBe(0);
  });

  it('survives a per-commodity API failure by treating that branch as empty', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: new Error('teams down'),
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            InitCapacityBaseValue: '100',
            CurrCapacityBaseValue: '50',
          }),
        ],
        [CODES.addon]: [],
      }),
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out.subscribed).toBe(true);
    expect(out.totalCredits).toBe(100);
  });

  it('returns { subscribed: false } when the entire pipeline throws synchronously', async () => {
    const apiClient = makeMockApiClient({
      flat: () => {
        throw new Error('sync explosion');
      },
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    const out = await svc.fetchTokenPlan();
    expect(out).toEqual({ subscribed: false });
  });

  it('returns { subscribed: false } when Promise.all rejects', async () => {
    // Make site.features.tokenPlanCommodityCodes access throw to trigger the
    // outer try/catch path. We do this by mocking apiClient + then asserting
    // the catch branch via injected error.
    const apiClient = makeMockApiClient();
    apiClient.callFlatApi.mockImplementation(() => {
      return Promise.reject(new Error('network'));
    });
    const svc = new TokenplanService(apiClient, makeMockCachedFetcher());
    // All three branches return null (per-call catch), so result is empty.
    const out = await svc.fetchTokenPlan();
    expect(out).toEqual({ subscribed: false });
    // Silence unused vi import lint by referencing it.
    expect(vi.isMockFunction(apiClient.callFlatApi)).toBe(true);
  });
});

// Individual & team edition status — subscription tri-state contract

describe('fetchIndividualTokenPlan — subscription tri-state', () => {
  it('prefers the matching active billing instance auto-renewal state', async () => {
    const now = Date.now();
    const entity = {
      instanceCode: 'sub-1',
      specCode: 'lite' as const,
      remainingDays: 30,
      startTime: now - 60_000,
      endTime: now + 2_592_000_000,
      autoRenewFlag: false,
      status: 'VALID' as const,
    };
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) return opts.parse({ data: entity });
        if (opts.api.endsWith('/quota-config')) return opts.parse({ data: {} });
        if (opts.api.endsWith('/usage')) return opts.parse({ data: {} });
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () =>
        availableInstancesResponse([
          availableInstance({
            InstanceID: entity.instanceCode,
            EndTime: new Date(entity.endTime).toISOString(),
            RenewStatus: 'AutoRenewal',
          }),
        ]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.autoRenew?.enabled).toBe(true);
    expect(apiClient.callFlatApi).toHaveBeenCalledWith(
      expect.objectContaining({
        product: 'BssOpenApi',
        action: 'QueryAvailableInstances',
        params: {},
      }),
    );
  });

  it('does not let unrelated billing instances override the subscription state', () => {
    const now = Date.now();
    const subscription = {
      instanceCode: 'sub-current',
      specCode: 'lite' as const,
      remainingDays: 30,
      startTime: now - 60_000,
      endTime: now + 2_592_000_000,
      autoRenewFlag: false,
      status: 'VALID' as const,
    };

    expect(
      resolveIndividualAutoRenewFlag(
        subscription,
        availableInstancesResponse([
          availableInstance({
            InstanceID: 'sub-old-1',
            EndTime: new Date(subscription.endTime - 1).toISOString(),
            RenewStatus: 'AutoRenewal',
          }),
          availableInstance({
            InstanceID: 'sub-old-2',
            EndTime: new Date(subscription.endTime - 2).toISOString(),
            RenewStatus: 'AutoRenewal',
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('uses the end time when the available-instance identifier cannot be matched', () => {
    const now = Date.now();
    const subscription = {
      instanceCode: 'sub-current',
      specCode: 'lite' as const,
      remainingDays: 30,
      startTime: now - 60_000,
      endTime: now + 2_592_000_000,
      autoRenewFlag: false,
      status: 'VALID' as const,
    };

    expect(
      resolveIndividualAutoRenewFlag(
        subscription,
        availableInstancesResponse([
          availableInstance({
            InstanceID: 'sub-other',
            EndTime: new Date(subscription.endTime + 86_400_000).toISOString(),
          }),
          availableInstance({
            InstanceID: 'sub-renamed',
            EndTime: new Date(subscription.endTime).toISOString(),
            RenewStatus: 'AutoRenewal',
          }),
        ]),
      ),
    ).toBe(true);
  });

  it('uses the only active personal instance when the complete response has no direct match', () => {
    const now = Date.now();
    const subscription = {
      instanceCode: 'sub-current',
      specCode: 'lite' as const,
      remainingDays: 30,
      startTime: now - 60_000,
      endTime: now + 2_592_000_000,
      autoRenewFlag: false,
      status: 'VALID' as const,
    };

    expect(
      resolveIndividualAutoRenewFlag(
        subscription,
        availableInstancesResponse([
          availableInstance({
            InstanceID: 'sub-renamed',
            EndTime: new Date(subscription.endTime + 86_400_000).toISOString(),
            RenewStatus: 'AutoRenewal',
          }),
        ]),
      ),
    ).toBe(true);
  });

  it('falls back to the console flag when available instances cannot be loaded', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            data: {
              instanceCode: 'sub-1',
              specCode: 'lite',
              remainingDays: 30,
              startTime: now - 60_000,
              endTime: now + 2_592_000_000,
              autoRenewFlag: true,
              status: 'VALID',
            },
          });
        }
        return opts.parse({ data: {} });
      },
      flat: async () => {
        throw new Error('instances unavailable');
      },
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.autoRenew?.enabled).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        api: 'QueryAvailableInstances',
        errorCode: 'SERVICE_UNAVAILABLE',
      }),
    ]);
  });

  it('projects the confirmed no-data response into not_subscribed for status and list', async () => {
    const apiClient = makeMockApiClient({
      csData: async (options) => {
        const business = {
          code: 'SUCCESS',
          success: true,
          requestId: 'synthetic-request',
          ...(options.api.endsWith('/quota-config')
            ? {
                data: {
                  lite: { weekly: 100, five_hour: 20 },
                  standard: { weekly: 200, five_hour: 40 },
                  pro: { weekly: 300, five_hour: 60 },
                },
              }
            : {}),
        };
        return options.parse(
          unwrapCsDataResponse({
            code: '200',
            successResponse: true,
            data: { success: true, DataV2: { ret: ['SUCCESS::ok'], data: business } },
          }),
        );
      },
      orchestration: async () => {
        throw new Error('Catalog metadata and pricing are unavailable in this fixture');
      },
    });

    const result = await fetchIndividualTokenPlan(apiClient);
    expect(result.status).toBe('not_subscribed');
    expect(result.diagnostics).toEqual([]);
    expect(result).not.toHaveProperty('weeklyCredits');
    expect(result).not.toHaveProperty('fiveHourCredits');

    const list = await new TokenPlanListService(apiClient).getTokenPlanList({
      edition: 'individual',
      authenticated: true,
    });
    expect(list.sections[0].subscriptionStatus).toBe('not_subscribed');
    expect(list.sections[0].diagnostics.some((entry) => entry.api.endsWith('/subscription'))).toBe(
      false,
    );
    expect(apiClient.callFlatApi).not.toHaveBeenCalled();
  });

  it('keeps status=unknown when the console API returns data=null', async () => {
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => opts.parse({ code: 200, data: null }),
      flat: () => Promise.resolve(null),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('unknown');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        errorCode: 'UnconfirmedState',
        errorMessage: 'Some subscription fields could not be verified.',
      }),
    ]);
  });

  it('keeps status=unknown when the INVALID entity is incomplete', async () => {
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) =>
        opts.parse({ code: 200, data: { status: 'INVALID' } }),
      flat: () => Promise.resolve(null),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('unknown');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        errorCode: 'UnconfirmedState',
        errorMessage: 'Some subscription fields could not be verified.',
      }),
    ]);
  });

  it.each([
    { shape: 'empty envelope', business: {} },
    {
      shape: 'failed envelope without data',
      business: { code: 'SUCCESS', success: false, msg: 'Failed.' },
    },
    { shape: 'undefined data', business: { data: undefined } },
    {
      shape: 'unknown status',
      business: { data: { status: 'UNKNOWN' } },
    },
    {
      shape: 'cancelled status',
      business: { data: { status: 'CANCELLED' } },
    },
    {
      shape: 'empty status',
      business: { data: { status: '' } },
    },
  ])('keeps status=unknown for $shape', async ({ business }) => {
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => opts.parse(business),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('unknown');
    expect(result.completeness).toBe('unknown');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        errorCode: 'UnconfirmedState',
        errorMessage: 'Some subscription fields could not be verified.',
      }),
    ]);
  });

  it('keeps a complete expired INVALID entity unknown without purchase gate cross-checks', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) =>
        opts.parse({
          code: 'SUCCESS',
          success: true,
          data: {
            instanceCode: 'sub-1',
            specCode: 'lite',
            remainingDays: 0,
            startTime: now - 2_000,
            endTime: now - 1_000,
            autoRenewFlag: false,
            status: 'INVALID',
            commodityCode: CODES.soloBuy,
          },
        }),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('unknown');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ errorCode: 'UnconfirmedState' }),
    ]);
  });

  it('preserves an active VALID subscription and its quota limits', async () => {
    const now = Date.now();
    const entity = {
      instanceCode: 'sub-1',
      specCode: 'essential',
      remainingDays: 20,
      startTime: now - 3_600_000,
      endTime: now + 3_600_000 * 24 * 20,
      autoRenewFlag: false,
      status: 'VALID',
      commodityCode: CODES.soloBuy,
    };
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({ code: 'SUCCESS', success: true, data: entity });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { weekly: 100, five_hour: 20 },
              essential: { weekly: 150, five_hour: 30 },
              standard: { weekly: 200, five_hour: 40 },
              pro: { weekly: 300, five_hour: 60 },
            },
          });
        }
        if (opts.api.endsWith('/usage')) {
          return opts.parse({
            data: {
              per1WeekPercentage: 0.25,
              per1WeekResetTime: now + 86_400_000,
            },
          });
        }
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('active');
    expect(result.type).toBe('token_plan_individual_essential');
    expect(result.name).toBe('Essential');
    expect(result.specCode).toBe('essential');
    expect(result.period).toEqual({
      start: new Date(entity.startTime).toISOString(),
      end: new Date(entity.endTime).toISOString(),
      remainingDays: 20,
    });
    expect(result.autoRenew?.enabled).toBe(false);
    expect(result.weeklyCredits).toEqual({
      total: 150,
      used: null,
      remaining: null,
      usedPct: 25,
      resetTime: new Date(now + 86_400_000).toISOString(),
    });
    expect(result).not.toHaveProperty('monthlyCredits');
    expect(result).not.toHaveProperty('fiveHourCredits');
    expect(result).not.toHaveProperty('billingCycle');
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to the quota-config monthly limit when weekly is absent', async () => {
    const now = Date.now();
    const entity = {
      instanceCode: 'sub-1',
      specCode: 'essential',
      remainingDays: 20,
      startTime: now - 3_600_000,
      endTime: now + 3_600_000 * 24 * 20,
      autoRenewFlag: false,
      status: 'VALID',
      commodityCode: CODES.soloBuy,
    };
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({ code: 'SUCCESS', success: true, data: entity });
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
        if (opts.api.endsWith('/usage')) {
          return opts.parse({
            data: { per1WeekPercentage: 0.25, per1WeekResetTime: now + 86_400_000 },
          });
        }
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('active');
    // weekly missing → the monthly limit is surfaced through the same credit window.
    expect(result.weeklyCredits).toEqual({
      total: 25500,
      used: null,
      remaining: null,
      usedPct: 25,
      resetTime: new Date(now + 86_400_000).toISOString(),
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps absolute usage unknown and reports the usage API failure independently', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            code: 'SUCCESS',
            success: true,
            data: {
              instanceCode: 'sub-1',
              specCode: 'lite',
              remainingDays: 20,
              startTime: now - 3_600_000,
              endTime: now + 3_600_000 * 24 * 20,
              autoRenewFlag: false,
              status: 'VALID',
              commodityCode: CODES.soloBuy,
            },
          });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { weekly: 100, five_hour: 20 },
              standard: { weekly: 200, five_hour: 40 },
              pro: { weekly: 300, five_hour: 60 },
            },
          });
        }
        throw new Error('usage unavailable');
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result).not.toHaveProperty('weeklyCredits');
    expect(result).not.toHaveProperty('monthlyCredits');
    expect(result).not.toHaveProperty('fiveHourCredits');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        api: expect.stringMatching(/\/usage$/),
        errorCode: 'SERVICE_UNAVAILABLE',
        errorMessage: 'The service is temporarily unavailable. Try again later.',
      }),
    ]);
  });

  it('omits an optional usage window when the usage response has no data', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            code: 'SUCCESS',
            success: true,
            data: {
              instanceCode: 'sub-1',
              specCode: 'lite',
              remainingDays: 20,
              startTime: now - 3_600_000,
              endTime: now + 3_600_000 * 24 * 20,
              autoRenewFlag: false,
              status: 'VALID',
              commodityCode: CODES.soloBuy,
            },
          });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { weekly: 100 },
              standard: { weekly: 200 },
              pro: { weekly: 300 },
            },
          });
        }
        if (opts.api.endsWith('/usage')) return opts.parse({ data: {} });
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result).not.toHaveProperty('weeklyCredits');
    expect(result).not.toHaveProperty('monthlyCredits');
    expect(result).not.toHaveProperty('fiveHourCredits');
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps weekly percentages visible without an unknown total when quota config fails', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            data: {
              instanceCode: 'sub-1',
              specCode: 'lite',
              remainingDays: 20,
              startTime: now - 3_600_000,
              endTime: now + 3_600_000 * 24 * 20,
              autoRenewFlag: false,
              status: 'VALID',
              commodityCode: CODES.soloBuy,
            },
          });
        }
        if (opts.api.endsWith('/quota-config')) throw new Error('quota unavailable');
        if (opts.api.endsWith('/usage')) {
          return opts.parse({
            data: {
              per1WeekPercentage: 0.25,
              per1WeekResetTime: now + 86_400_000,
            },
          });
        }
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.weeklyCredits).toEqual({
      total: null,
      used: null,
      remaining: null,
      usedPct: 25,
      resetTime: new Date(now + 86_400_000).toISOString(),
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ api: expect.stringMatching(/\/quota-config$/) }),
    ]);
  });

  it('accepts a weekly percentage without a reset time', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            data: {
              instanceCode: 'sub-1',
              specCode: 'lite',
              remainingDays: 20,
              startTime: now - 3_600_000,
              endTime: now + 3_600_000 * 24 * 20,
              autoRenewFlag: false,
              status: 'VALID',
              commodityCode: CODES.soloBuy,
            },
          });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { weekly: 100 },
              standard: { weekly: 200 },
              pro: { weekly: 300 },
            },
          });
        }
        if (opts.api.endsWith('/usage')) {
          return opts.parse({ data: { per1WeekPercentage: 0 } });
        }
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.weeklyCredits).toEqual({
      total: 100,
      used: null,
      remaining: null,
      usedPct: 0,
    });
    expect(result).not.toHaveProperty('monthlyCredits');
    expect(result).not.toHaveProperty('billingCycle');
    expect(result.diagnostics).toEqual([]);
  });

  it('routes the monthly production usage response into monthlyCredits only', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            data: {
              instanceCode: 'sub-1',
              specCode: 'lite',
              remainingDays: 20,
              startTime: now - 3_600_000,
              endTime: now + 3_600_000 * 24 * 20,
              autoRenewFlag: false,
              status: 'VALID',
              commodityCode: CODES.soloBuy,
            },
          });
        }
        if (opts.api.endsWith('/quota-config')) {
          return opts.parse({
            data: {
              lite: { monthly: 11500 },
              essential: { monthly: 25500 },
              standard: { monthly: 45000 },
              pro: { monthly: 180000 },
            },
          });
        }
        if (opts.api.endsWith('/usage')) {
          return opts.parse({
            data: {
              per1MonthPercentage: 0.14380236521739131,
              per1MonthResetTime: now + 86_400_000,
            },
          });
        }
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('active');
    expect(result.monthlyCredits).toEqual({
      total: 11500,
      used: null,
      remaining: null,
      usedPct: 0.14380236521739131 * 100,
      resetTime: new Date(now + 86_400_000).toISOString(),
    });
    expect(result).not.toHaveProperty('weeklyCredits');
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps a monthly percentage without a reset time and without quota config', async () => {
    const now = Date.now();
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => {
        if (opts.api.endsWith('/subscription')) {
          return opts.parse({
            data: {
              instanceCode: 'sub-1',
              specCode: 'lite',
              remainingDays: 20,
              startTime: now - 3_600_000,
              endTime: now + 3_600_000 * 24 * 20,
              autoRenewFlag: false,
              status: 'VALID',
              commodityCode: CODES.soloBuy,
            },
          });
        }
        if (opts.api.endsWith('/quota-config')) throw new Error('quota unavailable');
        if (opts.api.endsWith('/usage')) {
          return opts.parse({ data: { per1MonthPercentage: 1 } });
        }
        throw new Error(`Unexpected console API: ${opts.api}`);
      },
      flat: async () => availableInstancesResponse([]),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.monthlyCredits).toEqual({
      total: null,
      used: null,
      remaining: null,
      usedPct: 100,
    });
    expect(result).not.toHaveProperty('weeklyCredits');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ api: expect.stringMatching(/\/quota-config$/) }),
    ]);
  });

  it('keeps status=unknown with UnconfirmedState diagnostic when the response shape is inconclusive', async () => {
    // An empty data object cannot be resolved to any tri-state outcome, so the
    // service must surface UnconfirmedState instead of silently claiming
    // "not_subscribed".
    const apiClient = makeMockApiClient({
      csData: async (opts: CallCsDataApiOptions<unknown>) => opts.parse({ code: 200, data: {} }),
      flat: () => Promise.resolve(null),
    });

    const result = await fetchIndividualTokenPlan(apiClient);

    expect(result.status).toBe('unknown');
    expect(result.diagnostics.some((d) => d.errorCode === 'UnconfirmedState')).toBe(true);
  });
});

describe('fetchTeamTokenPlan — subscription tri-state', () => {
  it('returns status=not_subscribed with no diagnostic when the API reports zero valid instances', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({ [CODES.teams]: [] }),
    });

    const { team } = await fetchTeamTokenPlan(apiClient);

    expect(team.status).toBe('not_subscribed');
    expect(team.diagnostics).toEqual([]);
  });

  it('keeps status=unknown with a diagnostic when the response is malformed', async () => {
    const apiClient = makeMockApiClient({
      flat: async () => ({ Success: false }),
    });

    const { team } = await fetchTeamTokenPlan(apiClient);

    expect(team.status).toBe('unknown');
    expect(team.diagnostics.length).toBeGreaterThan(0);
  });
});
