/** Unit tests for SubscriptionService. */
import { describe, it, expect, vi } from 'vitest';
import { SubscriptionService } from '../../src/services/subscription-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import type { SubscriptionAdapter } from '../../src/services/subscription-service.js';
import type { TokenplanService } from '../../src/services/tokenplan-service.js';
import type { TokenPlan } from '../../src/types/usage.js';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';

// Mock TokenplanService factory

function makeMockTokenplanService(
  result: TokenPlan = { subscribed: false },
): TokenplanService {
  return {
    fetchTokenPlan: vi.fn(async () => result),
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
      period: raw?.PeriodStart ? { start: raw.PeriodStart, end: raw.PeriodEnd ?? '' } : null,
    }),
    transformSubscriptionDetail: (raw) => ({
      activeInstance: raw?.Data?.[0]
        ? {
            plan: raw.Data[0].PlanName ?? null,
            period: raw.Data[0].StartTime
              ? { start: String(raw.Data[0].StartTime), end: String(raw.Data[0].EndTime ?? '') }
              : null,
          }
        : null,
    }),
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
      amount: String(raw?.Amount ?? '0'),
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

describe('SubscriptionService.getStatus', () => {
  it('returns assembled status from five sub-calls (plan=undefined)', async () => {
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
        QueryAccountBaseInfoApi: { Data: { NbId: '12345' } },
      }),
    });
    const svc = new SubscriptionService(
      api,
      makeStubAdapter(),
      makeMockCachedFetcher(),
      makeMockTokenplanService({
        subscribed: true,
        totalCredits: 1000,
        remainingCredits: 750,
        planName: 'Token Plan Team',
      }),
    );

    const out = await svc.getStatus();
    expect(out.data).toBeDefined();
    expect(out.data?.isGray).toBe(true);
    expect(out.data?.autoRenew).toBe(true);
    expect(out.data?.quota).toMatchObject({ remaining: 750, total: 1000 });
    expect(out.diagnostics).toHaveLength(0);
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
    const out = await svc.getStatus();

    expect(out.data?.isGray).toBe(false);
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(out.diagnostics.some((d) => d.api === 'GetSeatSubscriptionSummary')).toBe(true);
  });

  it('returns data=null when ALL sub-calls fail', async () => {
    const api = makeMockApiClient({
      flat: async () => {
        throw new Error('global down');
      },
    });
    const tokenplan = makeMockTokenplanService();
    (tokenplan.fetchTokenPlan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('global down'));
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), tokenplan);
    const out = await svc.getStatus();
    expect(out.data).toBeNull();
    expect(out.diagnostics.length).toBeGreaterThan(0);
  });

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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
    await svc.getStatus();
    expect(orderListParams?.CommodityCodeList).toBe(
      'sfm_tokenplanteams_dp_cn,sfm_tokenplanteamsaddon_dp_cn',
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
    await expect(svc.listOrders({ page: 1, pageSize: 10 })).rejects.toThrow(/not available/);
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
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
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
    const out = await svc.getOrderDetail('O-5');
    expect(out.orderId).toBe('O-5');
    expect(out.orderType).toBe('RENEW');
  });

  it('throws CliError when response has Code but no Data', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Code: 'PERM_DENIED', Message: 'forbidden' }),
    });
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
    await expect(svc.getOrderDetail('O-99')).rejects.toThrow(/not available/);
  });
});

// Error propagation

describe('SubscriptionService error propagation', () => {
  it('throws when the ApiClient rejects on listOrders', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        if (opts.action === 'QueryAccountBaseInfoApi') return null;
        throw new Error('network');
      },
    });
    const svc = new SubscriptionService(api, makeStubAdapter(), makeMockCachedFetcher(), makeMockTokenplanService());
    await expect(svc.listOrders({ page: 1, pageSize: 10 })).rejects.toThrow('network');
  });
});
