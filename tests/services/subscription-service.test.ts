/** Unit tests for SubscriptionService. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionService } from '../../src/services/subscription-service.js';
import { SubscriptionTokenPlanService } from '../../src/services/subscription-tokenplan-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import type { SubscriptionAdapter } from '../../src/services/subscription-service.js';
import type { TokenplanService } from '../../src/services/tokenplan-service.js';
import type { TokenPlan } from '../../src/types/usage.js';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';
import * as tokenPlanModule from '../../src/services/tokenplan-service.js';
import { teamWithSeatDetails } from '../helpers/tokenplan-status.js';
import { buildSubscriptionStatusViewModel } from '../../src/view-models/subscription/status.js';
import { formatSubscriptionStatusJson } from '../../src/view-models/subscription/shared.js';
import type { TokenPlanHarnessAllowance } from '../../src/types/tokenplan-benefits.js';
import type { TokenPlanHarnessBenefits } from '../../src/services/tokenplan-benefits.js';

const harness = vi.hoisted(() => ({ load: vi.fn<() => Promise<TokenPlanHarnessBenefits>>() }));
vi.mock('../../src/services/tokenplan-benefits.js', () => ({
  createTokenPlanBenefitsReader: () => ({ loadHarnessBenefits: harness.load }),
}));
beforeEach(() => {
  harness.load.mockReset().mockResolvedValue({ allowances: [], hasResourcePack: false });
});
afterEach(() => vi.useRealTimers());

// Mock TokenplanService factory

function makeMockTokenplanService(
  result: TokenPlan = { subscribed: false },
  teamInstanceId: string | null = null,
): TokenplanService {
  return {
    fetchTokenPlan: vi.fn(async () => result),
    fetchTokenPlanEditions: vi.fn(async () => ({ tokenPlan: result, teamInstanceId })),
  } as unknown as TokenplanService;
}

// Minimal SubscriptionAdapter stub

function makeStubAdapter(): SubscriptionAdapter {
  return {
    transformSubscriptionGray: (raw) => ({
      isGray: raw?.IsGray ?? false,
    }),
    transformSeatSubscriptionSummary: (raw) => ({
      plan: raw?.PlanName ?? null,
      planCode: raw?.PlanCode ?? null,
      period: raw?.PeriodStart ? { start: raw.PeriodStart, end: raw.PeriodEnd ?? '' } : null,
      seats: raw?.Seats ?? null,
    }),
    transformSubscriptionDetail: (raw) => {
      const data = raw?.Data;
      const first = (Array.isArray(data) ? data : (data?.SubscriptionList ?? []))[0];
      const activeInstance = first
        ? {
            instanceId: first.InstanceId ?? '',
            status: first.Status ?? '',
            plan: first.PlanName ?? null,
            period: first.StartTime
              ? { start: String(first.StartTime), end: String(first.EndTime ?? '') }
              : null,
          }
        : null;
      return { instances: activeInstance ? [activeInstance] : [], activeInstance };
    },
    transformAutoRenewal: (raw) => ({
      autoRenew: raw?.AutoRenewal ?? raw?.EnableRenew ?? false,
    }),
    transformInstancesRenewable: (raw) => ({
      renewable: raw?.Renewable ?? false,
    }),
    transformOrderList: (raw) => ({
      orders: (raw?.Data ?? []).map((o) => ({
        orderId: o.OrderId ?? '',
        orderType: o.OrderType ?? '',
        orderTime: o.OrderTime ?? o.GmtCreate ?? '',
        amount: String(o.Amount ?? '0'),
        status: o.Status ?? '',
      })),
      pagination: {
        totalCount: raw?.TotalCount ?? 0,
        pageSize: raw?.PageSize ?? 10,
        currentPage: raw?.CurrentPage ?? 1,
      },
    }),
    transformOrderDetail: (raw) => ({
      orderId: raw?.OrderId ?? '',
      orderType: raw?.OrderType ?? '',
      orderTime: raw?.OrderTime ?? '',
      amount: String(raw?.Amount ?? '0'),
      status: raw?.Status ?? '',
      items: [],
      invoiceUrl: raw?.InvoiceUrl ?? null,
    }),
  };
}

// Dispatcher helper

function routeByAction(
  routes: Record<string, unknown | Error>,
): (opts: CallFlatApiOptions) => Promise<unknown> {
  return async (opts) => {
    const v = routes[opts.action];
    if (v instanceof Error) throw v;
    return v ?? null;
  };
}

// getStatus

describe('Individual status display data', () => {
  const allowance: TokenPlanHarnessAllowance = {
    toolId: 'tool',
    toolName: 'Tool',
    totalQuota: '10',
    remainingQuota: '8',
    quotaUnit: 'calls',
    startAt: null,
    endAt: null,
  };
  function statusApi(active = true) {
    const now = Date.now();
    return makeMockApiClient({
      csData: async (opts) => {
        if (opts.api.endsWith('/subscription'))
          return opts.parse(
            active
              ? {
                  data: {
                    instanceCode: 'personal-1',
                    specCode: 'lite',
                    remainingDays: 30,
                    startTime: now - 60_000,
                    endTime: now + 2_592_000_000,
                    autoRenewFlag: false,
                    status: 'VALID',
                  },
                }
              : { code: 'SUCCESS', success: true },
          );
        if (opts.api.endsWith('/quota-config'))
          return opts.parse({ data: { lite: { weekly: 1000, monthly: 2000 } } });
        return opts.parse({ data: { per1WeekPercentage: 0.25, per1MonthPercentage: 0.5 } });
      },
      flat: async (opts) => {
        if (opts.action === 'DescribeFrInstances')
          return { TotalCount: 0, PageSize: 100, CurrentPage: 1, Data: [] };
        if (opts.action === 'GetSubscriptionDetail')
          return { Success: true, Code: 'Success', Data: { TotalCount: 0, SubscriptionList: [] } };
        if (opts.action === 'CheckTokenPlanAutoRenewal')
          return { Success: true, Code: 'Success', Data: { AutoRenewal: 0 } };
        if (opts.action === 'QueryAvailableInstances')
          return {
            Success: true,
            Code: 'Success',
            Data: {
              InstanceList: [
                {
                  InstanceID: 'personal-1',
                  ProductCode: 'sfm',
                  ProductType: 'sfm_tokenplansolo_public_cn',
                  RenewStatus: 'ManualRenewal',
                },
              ],
            },
          };
        return { Success: true, Code: 'Success', Data: {} };
      },
    });
  }
  function service(api: ReturnType<typeof statusApi>) {
    const cache = makeMockCachedFetcher();
    return new SubscriptionService(
      api,
      makeStubAdapter(),
      cache,
      new tokenPlanModule.TokenplanService(api, cache),
    );
  }

  it('shares dedicated personal fields and reads each existing API only once for human output', async () => {
    const api = statusApi();
    harness.load.mockResolvedValue({ allowances: [allowance], hasResourcePack: true });
    const aggregate = await service(api).getStatus({ includeIndividualDetails: true });
    expect(api.callCsDataApi).toHaveBeenCalledTimes(3);
    expect(
      api.callFlatApi.mock.calls.filter(([opts]) => opts.action === 'QueryAvailableInstances'),
    ).toHaveLength(1);
    expect(api.callFlatApi).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'QueryAvailableInstances',
        params: {
          InstanceIDs: 'personal-1',
          ProductCode: 'sfm',
          ProductType: 'sfm_tokenplansolo_public_cn',
          PageNum: 1,
          PageSize: 20,
        },
      }),
    );
    expect(harness.load).toHaveBeenCalledTimes(1);
    const dedicated = await new SubscriptionTokenPlanService(api).getTokenPlanStatus({
      edition: 'individual',
    });
    expect(aggregate.data?.individual).toEqual(dedicated.individual);
    expect(aggregate.data?.individual?.tiers?.[0]).toMatchObject({
      windowType: 'weekly',
      usedPct: 25,
      remainingPct: 75,
    });
  });

  it('preserves the legacy data and request scope when personal details are not requested', async () => {
    const api = statusApi();
    const aggregate = await service(api).getStatus();
    expect(harness.load).not.toHaveBeenCalled();
    expect(aggregate.data?.individual).not.toHaveProperty('subscriptionId');
    expect(aggregate.data?.individual).not.toHaveProperty('tiers');
    expect(aggregate.data?.individual).not.toHaveProperty('harnessAllowances');
    expect(api.callFlatApi).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'QueryAvailableInstances', params: {} }),
    );
  });

  it('skips Harness for a confirmed unsubscribed personal account', async () => {
    const result = await service(statusApi(false)).getStatus({ includeIndividualDetails: true });
    expect(result.data?.individual?.status).toBe('not_subscribed');
    expect(harness.load).not.toHaveBeenCalled();
  });

  it.each(['empty', 'failed', 'pending', 'legacy-code'])(
    'keeps confirmed subscription fields when Harness is %s',
    async (scenario) => {
      if (scenario === 'failed') harness.load.mockRejectedValue(new Error('private backend text'));
      if (scenario === 'pending')
        harness.load.mockResolvedValue({ allowances: [], hasResourcePack: true });
      if (scenario === 'legacy-code')
        harness.load.mockRejectedValue(
          Object.assign(new Error('private backend text'), { code: 'TOKENPLAN_HARNESS_PENDING' }),
        );
      const result = await service(statusApi()).getStatus({ includeIndividualDetails: true });
      expect(result.data?.individual?.status).toBe('active');
      expect(result.data?.individual?.subscriptionId).toBe('personal-1');
      if (scenario === 'empty' || scenario === 'pending') {
        expect(result.data?.individual).toMatchObject({
          harnessAllowances: [],
          harnessHasResourcePack: scenario === 'pending',
        });
        expect(result.diagnostics).toEqual([]);
      } else {
        expect(result.data?.individual).not.toHaveProperty('harnessAllowances');
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            api: 'HarnessAllowances',
            errorCode: 'SERVICE_UNAVAILABLE',
          }),
        );
      }
      expect(JSON.stringify(result.diagnostics)).not.toContain('private backend text');
    },
  );

  it('bounds a hung Harness read without discarding personal data or accepting late results', async () => {
    vi.useFakeTimers();
    let release: ((value: TokenPlanHarnessBenefits) => void) | undefined;
    harness.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service(statusApi()).getStatus({ includeIndividualDetails: true });
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await pending;
    expect(result.data?.individual?.status).toBe('active');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ api: 'HarnessAllowances', errorCode: 'Timeout' }),
    );
    expect(result.data?.individual).not.toHaveProperty('harnessAllowances');
    const before = structuredClone(result);
    release?.({ allowances: [allowance], hasResourcePack: true });
    await Promise.resolve();
    expect(result).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('team seat usage aggregation', () => {
  const reset = '2026-12-01T00:00:00.000Z';
  const group = (total: string, remaining = total, overrides: Record<string, unknown> = {}) => ({
    SpecType: 'standard',
    SubscriptionTotalNumber: 1,
    SubscriptionAssignedNumber: 0,
    NextCycleFlushTime: reset,
    EquityList: [{ EquityType: 'CREDITS', TotalValue: total, SurplusValue: remaining }],
    ...overrides,
  });

  async function status(groups: unknown[], autoRenew: number | null = 1) {
    const raw = { Success: true, Code: 'Success', Data: { SubscriptionGroupList: groups } };
    const before = structuredClone(raw);
    const api = makeMockApiClient({
      flat: routeByAction({
        QuerySubscriptionGray: { IsGray: false },
        GetSeatSubscriptionSummary: raw,
        GetSubscriptionSummary: { Success: true, Code: 'Success', Data: {} },
        CheckTokenPlanAutoRenewal: {
          Success: true,
          Code: 'Success',
          Data: { AutoRenewal: autoRenew },
        },
        GetSubscriptionDetail: { Data: [], TotalCount: 0 },
      }),
    });
    const team = { ...tokenPlanModule.unknownTokenPlanEdition('team'), status: 'active' as const };
    const result = await new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService({ subscribed: true, team }),
    ).getStatus();
    expect(raw).toEqual(before);
    expect(
      api.callFlatApi.mock.calls.filter(([opts]) => opts.action === 'GetSeatSubscriptionSummary'),
    ).toHaveLength(1);
    return result;
  }

  it.each([0, 1])(
    'matches report F-001 without multiplying Credits by seats (renewal=%s)',
    async (renewal) => {
      const result = await status([group('1000', '800'), group('1000', '600')], renewal);
      const summary = {
        seatType: 'standard',
        seatCount: 2,
        assignedCount: 0,
        totalCredits: '2000',
        remainingCredits: '1400',
        remainingPct: 70,
        resetAt: reset,
      };
      const tier = {
        specType: 'standard',
        seats: 2,
        totalCredits: 2000,
        remainingCredits: 1400,
        usedPct: 30,
        remainingPct: 70,
        nextCycleFlushTime: renewal === 0 ? null : reset,
      };
      expect(result.data?.seatTiers).toEqual([tier]);
      expect(result.data?.team?.seatSummaries).toEqual([summary]);
      expect(formatSubscriptionStatusJson(result.data)).toMatchObject({
        seatTiers: [
          { ...tier, nextCycleFlushTime: renewal === 0 ? null : '2026-12-01T08:00:00.000+08:00' },
        ],
        team: { seatSummaries: [summary] },
      });
      const vm = buildSubscriptionStatusViewModel(result.data, result.diagnostics);
      expect(vm.tokenPlanSection?.tiers).toHaveLength(1);
      expect(vm.tokenPlanSection?.tiers[0].bar).toContain('1,400 / 2,000');
      expect(vm.tokenPlanSection?.tiers[0].usedPct).toBe(30);
    },
  );

  it.each([0, 1, null])(
    'merges the original window independently of auto-renewal=%s',
    async (renewal) => {
      const result = await status([group('100', '40'), group('200', '110')], renewal);
      expect(result.data?.seatTiers).toEqual([
        {
          specType: 'standard',
          seats: 2,
          totalCredits: 300,
          remainingCredits: 150,
          usedPct: 50,
          remainingPct: 50,
          nextCycleFlushTime: renewal === 0 ? null : reset,
        },
      ]);
      expect(result.data?.team?.seatSummaries?.[0]).toMatchObject({
        seatCount: 2,
        assignedCount: 0,
        totalCredits: '300',
        remainingCredits: '150',
        resetAt: reset,
      });
      expect(result.diagnostics.filter((d) => d.api === 'GetSeatSubscriptionSummary')).toEqual([]);
      const vm = buildSubscriptionStatusViewModel(result.data, result.diagnostics);
      expect(vm.tokenPlanSection?.tiers[0].bar).toContain('150 / 300');
      expect(vm.tokenPlanSection?.tiers[0].bar).not.toContain('unknown');
    },
  );

  it.each([false, true])(
    'sums decimals exactly regardless of input order (reversed=%s)',
    async (reverse) => {
      const groups = [group('0.1', '0.05'), group('0.2', '0.1')];
      const result = await status(reverse ? groups.reverse() : groups);
      expect(result.data?.seatTiers[0]).toMatchObject({
        totalCredits: 0.3,
        remainingCredits: 0.15,
        usedPct: 50,
        remainingPct: 50,
      });
      expect(result.data?.team?.seatSummaries?.[0]).toMatchObject({
        totalCredits: '0.3',
        remainingCredits: '0.15',
      });
      const vm = buildSubscriptionStatusViewModel(result.data, result.diagnostics);
      expect(vm.tokenPlanSection?.tiers[0].bar).toContain('0.15 / 0.3');
    },
  );

  it.each([
    { NextCycleFlushTime: '2027-01-01T00:00:00.000Z' },
    { NextCycleFlushTime: null },
    { EquityList: [{ EquityType: 'CREDITS', TotalValue: '200' }] },
  ])('keeps incompatible groups unknown with a diagnostic: %j', async (overrides) => {
    const result = await status([group('100'), group('200', '100', overrides)], 0);
    expect(result.data?.seatTiers[0]).toMatchObject({
      seats: 2,
      totalCredits: null,
      remainingCredits: null,
      usedPct: null,
      remainingPct: null,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        api: 'GetSeatSubscriptionSummary',
        errorCode: 'ConflictingCreditGroups',
      }),
    );
    expect(result.data?.team?.seatSummaries?.[0]).toMatchObject({
      seatCount: 2,
      totalCredits: null,
      remainingCredits: null,
      remainingPct: null,
      resetAt: 'NextCycleFlushTime' in overrides ? null : reset,
    });
  });

  it('retains zero and partial fields without substituting a total or duplicating diagnostics', async () => {
    const result = await status([
      group('0'),
      group('10', '0', { SpecType: 'pro' }),
      group('20', '0', {
        SpecType: 'max',
        EquityList: [{ EquityType: 'CREDITS', TotalValue: '20' }],
      }),
    ]);
    expect(result.data?.seatTiers).toMatchObject([
      { specType: 'standard', totalCredits: 0, remainingCredits: 0, remainingPct: null },
      { specType: 'pro', totalCredits: 10, remainingCredits: 0, remainingPct: 0 },
      { specType: 'max', totalCredits: 20, remainingCredits: null, remainingPct: null },
    ]);
    expect(
      result.diagnostics.filter(
        (d) => d.api === 'GetSeatSubscriptionSummary' && d.errorCode === 'IncompleteCredits',
      ),
    ).toHaveLength(1);
  });

  it('preserves exact large Credits while leaving unsafe legacy numbers unknown', async () => {
    const result = await status([group('9007199254740993'), group('1')]);
    expect(result.data?.team?.seatSummaries?.[0]).toMatchObject({
      totalCredits: '9007199254740994',
      remainingCredits: '9007199254740994',
      remainingPct: 100,
    });
    expect(result.data?.seatTiers[0]).toMatchObject({
      totalCredits: null,
      remainingCredits: null,
      remainingPct: 100,
      usedPct: 0,
    });
    expect(result.diagnostics.filter((d) => d.errorCode === 'UnrepresentableCredits')).toHaveLength(
      1,
    );
    const vm = buildSubscriptionStatusViewModel(result.data, result.diagnostics);
    expect(vm.tokenPlanSection?.tiers[0].bar).toContain(
      '9,007,199,254,740,994 / 9,007,199,254,740,994',
    );
    expect(vm.tokenPlanSection?.tiers[0].bar).not.toContain('unknown');
  });

  it('rejects lossy decimal conversion and supports small decimal values', async () => {
    const result = await status([
      group('1234567890123.123456789012'),
      group('0.000000000001', '0.000000000001', { SpecType: 'pro' }),
    ]);
    expect(result.data?.seatTiers[0].totalCredits).toBeNull();
    expect(result.data?.team?.seatSummaries?.[0].totalCredits).toBe('1234567890123.123456789012');
    expect(result.data?.seatTiers[1].totalCredits).toBe(1e-12);
    expect(result.diagnostics.filter((d) => d.errorCode === 'UnrepresentableCredits')).toHaveLength(
      1,
    );
  });

  it('validates the sum of seat counts as a safe integer', async () => {
    const result = await status([
      group('1', '1', { SubscriptionTotalNumber: Number.MAX_SAFE_INTEGER }),
      group('1'),
    ]);
    expect(result.data?.seatTiers[0]).toMatchObject({
      seats: null,
      totalCredits: 2,
      remainingCredits: 2,
    });
    expect(result.data?.team?.seatSummaries?.[0].seatCount).toBeNull();
  });
});

describe('status seat details integration', () => {
  it.each(['complete', 'failed', 'history', 'mismatch', 'unknown-credits'])(
    'both status commands attach independent seat details (%s)',
    async (scenario) => {
      const failed = scenario === 'failed';
      const history = scenario === 'history';
      const mismatch = scenario === 'mismatch';
      const unknownCredits = scenario === 'unknown-credits';
      const team = teamWithSeatDetails();
      delete team.seatDetails;
      const getTeam = vi
        .spyOn(tokenPlanModule, 'fetchTeamTokenPlan')
        .mockResolvedValue({ team, instanceId: 'team-1' });
      const getIndividual = vi
        .spyOn(tokenPlanModule, 'fetchIndividualTokenPlan')
        .mockResolvedValue({
          ...tokenPlanModule.unknownTokenPlanEdition('individual'),
          status: 'not_subscribed',
        });
      const api = makeMockApiClient({
        flat: async ({ action }) => {
          if (action === 'GetSubscriptionDetail') {
            if (failed) throw new Error('private detail failure');
            return {
              Data: [
                ...(history
                  ? Array.from({ length: 15 }, (_, i) => ({
                      InstanceCode: `historical-seat-${i}`,
                      SpecType: 'standard',
                      Status: 'REFUNDED',
                      Assignable: true,
                      EquityList: [{}],
                    }))
                  : []),
                {
                  InstanceCode: 'seat-1',
                  SpecType: 'standard',
                  Status: 'NORMAL',
                  ...(history ? { Assignable: true } : { MemberId: '' }),
                  EquityList: [
                    {
                      EquityType: unknownCredits ? 'REQUESTS' : 'CREDITS',
                      TotalValue: '25',
                      SurplusValue: '20',
                    },
                  ],
                },
              ],
              TotalCount: history ? 16 : 1,
            };
          }
          if ((history || mismatch) && action === 'GetSeatSubscriptionSummary')
            return {
              Data: {
                SubscriptionGroupList: [
                  {
                    SpecType: 'standard',
                    SubscriptionTotalNumber: mismatch ? 2 : 1,
                    SubscriptionAssignedNumber: 0,
                    EquityList: [{ EquityType: 'CREDITS', TotalValue: '25', SurplusValue: '20' }],
                  },
                ],
              },
            };
          if ((history || mismatch) && action === 'GetSubscriptionSummary')
            return {
              Data: { TotalCount: mismatch ? 2 : 1, TotalValue: '25', TotalSurplusValue: '20' },
            };
          return null;
        },
      });
      try {
        const dedicated = await new SubscriptionTokenPlanService(api).getTokenPlanStatus();
        const general = await new SubscriptionService(
          api,
          makeStubAdapter(),
          makeMockCachedFetcher(),
          makeMockTokenplanService({ subscribed: true, team }, 'team-1'),
        ).getStatus();
        expect(dedicated.team?.seatDetails).toEqual(general.data?.team?.seatDetails);
        expect(dedicated.team?.seatSummaries).toEqual(general.data?.team?.seatSummaries);
        if (history || mismatch) {
          expect(dedicated.team?.seatSummaries).toEqual([
            {
              seatType: 'standard',
              seatCount: mismatch ? 2 : 1,
              assignedCount: 0,
              totalCredits: '25',
              remainingCredits: '20',
              remainingPct: 80,
              resetAt: null,
            },
          ]);
        }
        expect(dedicated.team?.seatDetails).toMatchObject({
          fetchedCount: failed ? 0 : history ? 16 : 1,
          completeness: failed ? 'unknown' : mismatch || unknownCredits ? 'partial' : 'complete',
        });
        if (history) {
          expect(dedicated.team?.seatDetails).toMatchObject({
            historicalCount: 15,
            collectionCompleteness: 'complete',
            diagnostics: [],
            items: [{ instanceCode: 'seat-1', status: 'NORMAL', assignment: 'unassigned' }],
          });
        }
        expect(dedicated.team?.status).toBe('active');
        expect(general.data?.team?.status).toBe('active');
        expect(
          api.callFlatApi.mock.calls.filter(([opts]) => opts.action === 'GetSubscriptionDetail'),
        ).toHaveLength(2);
        if (failed) {
          expect(general.diagnostics).toContainEqual(
            expect.objectContaining({ api: 'GetSubscriptionDetail' }),
          );
          expect(JSON.stringify(dedicated)).not.toContain('private detail failure');
        }
        if (mismatch) {
          const warning = expect.objectContaining({
            api: 'GetSubscriptionDetail',
            errorCode: 'SeatSummaryMismatch',
          });
          expect(dedicated.diagnostics).toContainEqual(warning);
          expect(general.diagnostics).toContainEqual(warning);
          expect(dedicated.team?.seatDetails?.items).toHaveLength(1);
          expect(dedicated.team?.seatSummary?.total?.seats).toBe(2);
        }
        if (unknownCredits) {
          const warning = expect.objectContaining({
            api: 'GetSubscriptionDetail',
            errorCode: 'IncompleteCredits',
          });
          expect(dedicated.diagnostics).toContainEqual(warning);
          expect(general.diagnostics).toContainEqual(warning);
          expect(dedicated.team?.seatDetails).toMatchObject({
            collectionCompleteness: 'complete',
            diagnostics: [warning],
            items: [{ totalValue: null, surplusValue: null }],
          });
        }
      } finally {
        getTeam.mockRestore();
        getIndividual.mockRestore();
      }
    },
  );
});

describe('SubscriptionService.getStatus', () => {
  it('returns assembled status with a verified renewable flag (plan=undefined)', async () => {
    const api = makeMockApiClient({
      flat: routeByAction({
        QuerySubscriptionGray: { IsGray: true },
        GetSeatSubscriptionSummary: {
          PlanName: 'Token Plan Team',
          PeriodStart: '2026-01-01',
          PeriodEnd: '2026-12-31',
        },
        DescribeFrInstances: {
          Data: [{ InitCapacityBaseValue: '1000', CurrCapacityBaseValue: '750' }],
        },
        CheckTokenPlanAutoRenewal: { AutoRenewal: true },
        CheckInstancesRenewable: {
          Success: true,
          Code: 'Success',
          Data: [
            {
              InstanceId: 'team-instance-1',
              CommodityCode: 'sfm_tokenplanteams_dp_cn',
              CanRenew: true,
            },
          ],
        },
        QueryAccountBaseInfoApi: { Data: { NbId: '12345' } },
      }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(
        {
          subscribed: true,
          totalCredits: 1000,
          remainingCredits: 750,
          planName: 'Token Plan Team',
        },
        'team-instance-1',
      ),
    );

    const out = await svc.getStatus();
    expect(out.data).toBeDefined();
    expect(out.data?.isGray).toBe(true);
    expect(out.data?.autoRenew).toBe(true);
    expect(out.data?.renewable).toBe(true);
    expect(out.data?.quota).toMatchObject({ remaining: 750, total: 1000 });
    expect(out.diagnostics).toHaveLength(0);
  });

  it('nulls seat-tier nextCycleFlushTime when auto-renewal is OFF', async () => {
    const api = makeMockApiClient({
      flat: routeByAction({
        QuerySubscriptionGray: { IsGray: false },
        GetSeatSubscriptionSummary: {
          PlanName: 'Token Plan Team',
          PeriodStart: '2026-07-27T11:00:00.000Z',
          PeriodEnd: '2026-08-27T11:00:00.000Z',
          SubscriptionGroupList: [
            {
              SpecType: 'standard',
              SubscriptionTotalNumber: 2,
              EquityList: [{ EquityType: 'CREDITS', TotalValue: '50000', SurplusValue: '49997' }],
              NextCycleFlushTime: '2026-08-27T11:00:00.000Z',
            },
          ],
        },
        CheckTokenPlanAutoRenewal: { AutoRenewal: false },
        QueryAccountBaseInfoApi: { Data: { NbId: '12345' } },
      }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );

    const out = await svc.getStatus();
    expect(out.data?.autoRenew).toBe(false);
    expect(out.data?.seatTiers.length).toBeGreaterThan(0);
    // Auto-renewal is off → there is no next cycle → flush time must be null,
    // never the expiry date the server echoes back.
    for (const tier of out.data?.seatTiers ?? []) {
      expect(tier.nextCycleFlushTime).toBeNull();
    }
  });

  it('keeps seat-tier nextCycleFlushTime when auto-renewal is ON', async () => {
    const api = makeMockApiClient({
      flat: routeByAction({
        QuerySubscriptionGray: { IsGray: false },
        GetSeatSubscriptionSummary: {
          PlanName: 'Token Plan Team',
          PeriodStart: '2026-07-27T11:00:00.000Z',
          PeriodEnd: '2026-08-27T11:00:00.000Z',
          SubscriptionGroupList: [
            {
              SpecType: 'standard',
              SubscriptionTotalNumber: 2,
              EquityList: [{ EquityType: 'CREDITS', TotalValue: '50000', SurplusValue: '49997' }],
              NextCycleFlushTime: '2026-08-27T11:00:00.000Z',
            },
          ],
        },
        CheckTokenPlanAutoRenewal: { AutoRenewal: true },
        QueryAccountBaseInfoApi: { Data: { NbId: '12345' } },
      }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );

    const out = await svc.getStatus();
    expect(out.data?.autoRenew).toBe(true);
    expect(out.data?.seatTiers[0]?.nextCycleFlushTime).toBe('2026-08-27T11:00:00.000Z');
  });

  it('returns diagnostics when a sub-call fails (no full abort)', async () => {
    const api = makeMockApiClient({
      flat: routeByAction({
        QuerySubscriptionGray: { IsGray: false },
        GetSeatSubscriptionSummary: new Error('seat timeout'),
        DescribeFrInstances: null,
        CheckTokenPlanAutoRenewal: null,
        QueryAccountBaseInfoApi: null,
      }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    const out = await svc.getStatus();

    expect(out.data?.isGray).toBe(false);
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(out.diagnostics).toContainEqual({
      api: 'GetSeatSubscriptionSummary',
      errorCode: 'SERVICE_UNAVAILABLE',
      errorMessage: 'The service is temporarily unavailable. Try again later.',
    });
    expect(JSON.stringify(out.diagnostics)).not.toContain('seat timeout');
  });

  it.each([false, true])(
    'returns data=null when status sub-calls fail (details succeed=%s)',
    async (detailsSucceed) => {
      const api = makeMockApiClient({
        flat: async ({ action }) => {
          if (detailsSucceed && action === 'GetSubscriptionDetail')
            return { Data: [], TotalCount: 0 };
          throw new Error('global down');
        },
      });
      const tokenplan = makeMockTokenplanService();
      (tokenplan.fetchTokenPlanEditions as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('global down'),
      );
      const svc = new SubscriptionService(
        api,
        makeStubAdapter(),
        makeMockCachedFetcher(),
        tokenplan,
      );
      const out = await svc.getStatus();
      expect(out.data).toBeNull();
      expect(out.diagnostics.length).toBeGreaterThan(0);
    },
  );

  it('plan=token includes seat + autoRenew + FrInstances', async () => {
    const api = makeMockApiClient({
      flat: routeByAction({
        QuerySubscriptionGray: { IsGray: false },
        GetSeatSubscriptionSummary: { PlanName: 'TP' },
        CheckTokenPlanAutoRenewal: { AutoRenewal: true },
        DescribeFrInstances: null,
        QueryAccountBaseInfoApi: null,
      }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    const out = await svc.getStatus({ plan: 'token' });
    expect(out.data).toBeDefined();
    const actions = api.callFlatApi.mock.calls.map((c) => (c[0] as CallFlatApiOptions).action);
    expect(actions).toContain('GetSeatSubscriptionSummary');
    expect(actions).toContain('CheckTokenPlanAutoRenewal');
  });

  it('scopes recent orders to the token-plan commodity codes', async () => {
    let orderListParams: Record<string, unknown> | undefined;
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') {
          return { Data: { NbId: '2688801000001' } };
        }
        if (opts.action === 'QueryOrderList') {
          orderListParams = opts.params as Record<string, unknown>;
          return { Data: [], TotalCount: 0, PageSize: 3, CurrentPage: 1 };
        }
        return null;
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    await svc.getStatus();
    expect(orderListParams?.CommodityCodeList).toBe(
      'sfm_tokenplanteams_dp_cn,sfm_tokenplanteamsaddon_dp_cn,sfm_tokenplansolo_public_cn',
    );
  });

  it('quotaFromFr returns null for empty Data', async () => {
    const api = makeMockApiClient({
      flat: routeByAction({
        QuerySubscriptionGray: { IsGray: false },
        GetSeatSubscriptionSummary: {},
        DescribeFrInstances: { Data: [] },
        CheckTokenPlanAutoRenewal: null,
        QueryAccountBaseInfoApi: null,
      }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    const out = await svc.getStatus();
    expect(out.data?.quota).toBeNull();
  });
});

// listOrders

describe('SubscriptionService.listOrders', () => {
  it('resolves NbId via AccountCenter and forwards it to QueryOrderList', async () => {
    const actions: string[] = [];
    const api = makeMockApiClient({
      flat: async (opts) => {
        actions.push(opts.action);
        if (opts.action === 'QueryAccountBaseInfoApi') {
          return { Data: { NbId: 'NB-99' } };
        }
        if (opts.action === 'QueryOrderList') {
          expect(opts.params).toMatchObject({ Nbid: 'NB-99', CurrentPage: 1, PageSize: 10 });
          return {
            Data: [{ OrderId: 'O-1', OrderType: 'NEW', Amount: '100', Status: 'paid' }],
            TotalCount: 1,
            PageSize: 10,
            CurrentPage: 1,
          };
        }
        return null;
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    const out = await svc.listOrders({ page: 1, pageSize: 10 });
    expect(actions).toContain('QueryAccountBaseInfoApi');
    expect(out.orders).toHaveLength(1);
    expect(out.orders[0]?.orderId).toBe('O-1');
    expect(out.pagination).toEqual({ page: 1, pageSize: 10, total: 1 });
  });

  it('proceeds without NbId when QueryAccountBaseInfoApi fails', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') {
          throw new Error('account center down');
        }
        if (opts.action === 'QueryOrderList') {
          return { Data: [], TotalCount: 0, PageSize: 10, CurrentPage: 1 };
        }
        return null;
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    const out = await svc.listOrders({ page: 1, pageSize: 10 });
    expect(out.orders).toEqual([]);
  });

  it('throws CliError when upstream returns Code without Data (Nbid injection failure)', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') return null;
        if (opts.action === 'QueryOrderList') {
          return { Code: 'INNER_ERROR', Message: 'NbidRequired' };
        }
        return null;
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    await expect(svc.listOrders({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      code: 'ORDER_RESPONSE_INVALID',
      message: 'Subscription orders could not be retrieved.',
      exitCode: 4,
    });
  });

  it('forwards CommodityCodeList into the QueryOrderList params when provided', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') {
          return { Data: { NbId: 'NB-1' } };
        }
        return { Data: [], TotalCount: 0, PageSize: 20, CurrentPage: 1 };
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    await svc.listOrders({
      page: 1,
      pageSize: 20,
      commodityCodeList: 'sfm_tokenplanteams_dp_cn,sfm_tokenplanteamsaddon_dp_cn',
    });
    const listCall = api.callFlatApi.mock.calls.find(
      (call) => (call[0] as CallFlatApiOptions).action === 'QueryOrderList',
    );
    expect(listCall).toBeDefined();
    const params = (listCall![0] as CallFlatApiOptions).params as Record<string, unknown>;
    expect(params?.CommodityCodeList).toBe(
      'sfm_tokenplanteams_dp_cn,sfm_tokenplanteamsaddon_dp_cn',
    );
  });

  it('omits CommodityCodeList from the QueryOrderList params when not provided', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') {
          return { Data: { NbId: 'NB-1' } };
        }
        return { Data: [], TotalCount: 0, PageSize: 20, CurrentPage: 1 };
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    await svc.listOrders({ page: 1, pageSize: 20 });
    const listCall = api.callFlatApi.mock.calls.find(
      (call) => (call[0] as CallFlatApiOptions).action === 'QueryOrderList',
    );
    const params = (listCall![0] as CallFlatApiOptions).params as Record<string, unknown>;
    expect(params && 'CommodityCodeList' in params).toBe(false);
  });

  it('caches the NbId for 30 minutes (second call skips AccountCenter)', async () => {
    let accountCalls = 0;
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') {
          accountCalls++;
          return { Data: { NbId: 'NB-1' } };
        }
        return { Data: [], TotalCount: 0, PageSize: 10, CurrentPage: 1 };
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    await svc.listOrders({ page: 1, pageSize: 10 });
    await svc.listOrders({ page: 2, pageSize: 10 });
    expect(accountCalls).toBe(1);
  });

  it('converts from/to dates to epoch milliseconds', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') {
          return { Data: { NbId: 'NB-1' } };
        }
        return { Data: [], TotalCount: 0, PageSize: 20, CurrentPage: 1 };
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    await svc.listOrders({ page: 1, pageSize: 20, from: '2026-04-01', to: '2026-04-30' });

    // Verify startDate/endDate are epoch milliseconds (local timezone)
    const listCall = api.callFlatApi.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'QueryOrderList',
    );
    const params = (listCall![0] as { params?: Record<string, unknown> }).params;
    expect(params?.startDate).toBe(new Date('2026-04-01T00:00:00').getTime());
    expect(params?.endDate).toBe(new Date('2026-04-30T23:59:59.999').getTime());
  });
});

// getOrderDetail

describe('SubscriptionService.getOrderDetail', () => {
  it('calls QueryOrderDetail and returns the adapter-transformed result', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('QueryOrderDetail');
        expect(opts.params).toEqual({ OrderId: 'O-5' });
        return {
          OrderId: 'O-5',
          OrderType: 'RENEW',
          Amount: '200',
        };
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    const out = await svc.getOrderDetail('O-5');
    expect(out.orderId).toBe('O-5');
    expect(out.orderType).toBe('RENEW');
  });

  it('throws CliError when response has Code but no Data', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Code: 'PERM_DENIED', Message: 'forbidden' }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    await expect(svc.getOrderDetail('O-99')).rejects.toMatchObject({
      code: 'ORDER_RESPONSE_INVALID',
      message: 'Subscription orders could not be retrieved.',
      exitCode: 4,
    });
  });
});

// Error propagation

describe('SubscriptionService error propagation', () => {
  it('normalizes ApiClient failures without exposing the backend message', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') return null;
        throw new Error('backend payload must stay private');
      },
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService(),
    );
    const failure = await svc
      .listOrders({ page: 1, pageSize: 10 })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'SUBSCRIPTION_SERVICE_UNAVAILABLE',
      message: 'Subscription orders could not be retrieved.',
      exitCode: 1,
    });
    expect(String(failure)).not.toContain('backend payload must stay private');
  });
});

describe('SubscriptionTokenPlanService safe seat diagnostics', () => {
  it('does not expose backend codes when the seats API rejects the request', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Success: false, Code: 'INTERNAL_BACKEND_CODE' }),
    });
    const service = new SubscriptionTokenPlanService(api);

    await expect(service.listTokenPlanSeats()).rejects.toMatchObject({
      code: 'TOKENPLAN_SEATS_UNAVAILABLE',
      message: 'Token Plan seats could not be loaded. Try again later.',
    });
  });

  it('uses stable messages for malformed seat quota and configuration fields', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Success: true,
        Data: {
          SubscriptionList: [
            {
              InstanceCode: 'sensitive-instance-id',
              SpecType: 'standard',
              EquityList: [],
              Config: '{not-json',
            },
          ],
          TotalCount: 1,
        },
      }),
    });
    const service = new SubscriptionTokenPlanService(api);
    const result = await service.listTokenPlanSeats();

    expect(result.diagnostics).toEqual([
      {
        api: 'GetSubscriptionDetail',
        errorCode: 'EquityListEmpty',
        errorMessage: 'Seat quota details are unavailable.',
      },
      {
        api: 'GetSubscriptionDetail',
        errorCode: 'ConfigParseFailed',
        errorMessage: 'Seat configuration could not be verified.',
      },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('sensitive-instance-id');
    expect(JSON.stringify(result.diagnostics)).not.toContain('Unexpected token');
  });
});

describe('SubscriptionTokenPlanService seat spec filtering', () => {
  it.each(['standard', 'pro', 'max'])(
    'forwards %s to GetSubscriptionDetail and filters mixed backend results',
    async (specType) => {
      const api = makeMockApiClient({
        flat: async () => ({
          Success: true,
          Data: {
            SubscriptionList: ['standard', 'pro', 'max'].map((tier) => ({
              InstanceCode: `seat-${tier}`,
              SpecType: tier,
              Status: 'NORMAL',
            })),
          },
        }),
      });
      const service = new SubscriptionTokenPlanService(api);
      const result = await service.listTokenPlanSeats({ specType });
      expect(api.callFlatApi).toHaveBeenCalledExactlyOnceWith({
        product: 'BssOpenAPI-V3',
        action: 'GetSubscriptionDetail',
        params: { productCode: 'sfm_tokenplanteams_dp_cn', pageNo: 1, pageSize: 20, specType },
      });
      expect(result.filter).toEqual({ specType });
      expect(result.items.map((item) => item.instanceCode)).toEqual([`seat-${specType}`]);
    },
  );
});
