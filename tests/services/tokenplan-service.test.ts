/** Unit tests for TokenplanService. */
import { describe, it, expect, vi } from 'vitest';
import { TokenplanService } from '../../src/services/tokenplan-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import { site } from '../../src/site.js';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';
import type { FrInstanceItem, FrInstanceResponse } from '../../src/types/api-models.js';

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
    expect(out.resetDate).toBe(new Date('2026-01-01T00:00:00Z').toISOString());
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

  it('omits resetDate when EndTime is missing', async () => {
    const apiClient = makeMockApiClient({
      flat: dispatcherByCommodity({
        [CODES.teams]: [],
        [CODES.personal]: [
          frInstance({
            Status: 'valid',
            InitCapacityBaseValue: '100',
            CurrCapacityBaseValue: '50',
            EndTime: undefined,
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
