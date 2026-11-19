import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionTokenPlanService } from '../../src/services/subscription-tokenplan-service.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import { site } from '../../src/site.js';
import type { TokenPlanHarnessAllowance } from '../../src/types/tokenplan-benefits.js';
import type { TokenPlanHarnessBenefits } from '../../src/services/tokenplan-benefits.js';

const harness = vi.hoisted(() => ({ load: vi.fn<() => Promise<TokenPlanHarnessBenefits>>() }));
vi.mock('../../src/services/tokenplan-benefits.js', () => ({
  createTokenPlanBenefitsReader: () => ({ loadHarnessBenefits: harness.load }),
}));

const codes = site.features.tokenPlanCommodityCodes;

function statusApi(active = false) {
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
        return opts.parse({ data: { lite: { weekly: 1000 } } });
      return opts.parse({ data: { per1WeekPercentage: 0.25 } });
    },
    flat: async (opts) => {
      if (opts.action === 'DescribeFrInstances')
        return { TotalCount: 0, PageSize: 100, CurrentPage: 1, Data: [] };
      if (opts.action === 'GetSubscriptionDetail')
        return { Success: true, Code: 'Success', Data: { TotalCount: 0, SubscriptionList: [] } };
      if (opts.action === 'CheckTokenPlanAutoRenewal')
        return { Success: true, Code: 'Success', Data: { AutoRenewal: 0 } };
      if (opts.action === 'QueryAvailableInstances')
        return { Success: true, Code: 'Success', Data: { InstanceList: [] } };
      return { Success: true, Code: 'Success', Data: {} };
    },
  });
}

beforeEach(() => {
  harness.load.mockReset();
  harness.load.mockResolvedValue({ allowances: [], hasResourcePack: false });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SubscriptionTokenPlanService.getTokenPlanStatus edition isolation', () => {
  it('requests only personal status and skips Harness for a confirmed absent subscription', async () => {
    const api = statusApi();
    const result = await new SubscriptionTokenPlanService(api).getTokenPlanStatus({
      edition: 'individual',
    });
    expect(result).not.toHaveProperty('team');
    expect(result.individual?.status).toBe('not_subscribed');
    expect(api.callFlatApi).not.toHaveBeenCalled();
    expect(harness.load).not.toHaveBeenCalled();
    expect(result.diagnostics).toEqual([]);
  });

  it('requests only team APIs, preserves the old seat collection, and does not query organizations', async () => {
    const api = statusApi();
    const result = await new SubscriptionTokenPlanService(api).getTokenPlanStatus({
      edition: 'team',
    });
    expect(result).not.toHaveProperty('individual');
    expect(api.callCsDataApi).not.toHaveBeenCalled();
    expect(harness.load).not.toHaveBeenCalled();
    expect(result.team?.subscriptionId).toBeNull();
    expect(result.team?.seatDetails?.items).toEqual([]);
    expect(result.team?.seatSummaries).toEqual([]);
    const actions = api.callFlatApi.mock.calls.map(([opts]) => opts.action);
    expect(actions).toContain('GetSubscriptionDetail');
    expect(actions).not.toContain('GetSubscriptionSeatDetails');
    expect(actions).not.toContain('UacGetAccountDetail');
    expect(actions).not.toContain('QuerySubscription');
    expect(api.callFlatApi).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GetSeatSubscriptionSummary',
        params: { productCode: codes.teams },
      }),
    );
  });

  it('defaults to both editions and preserves the legacy team top-level fields', async () => {
    const result = await new SubscriptionTokenPlanService(statusApi(true)).getTokenPlanStatus();
    expect(result.individual?.status).toBe('active');
    expect(result.team?.status).toBe('not_subscribed');
    expect(result.period).toBeNull();
    expect(result.autoRenew).toBeNull();
  });

  it('adds the confirmed team end time without inventing a start time or subscription ID', async () => {
    const api = statusApi();
    const original = api.callFlatApi.getMockImplementation()!;
    api.callFlatApi.mockImplementation(async (opts) =>
      opts.action === 'GetSeatSubscriptionSummary'
        ? {
            Success: true,
            Code: 'Success',
            Data: { EndTime: '2026-12-01T00:00:00Z', RemainingDays: 34, SubscriptionGroupList: [] },
          }
        : original(opts),
    );
    const result = await new SubscriptionTokenPlanService(api).getTokenPlanStatus({
      edition: 'team',
    });
    expect(result.team?.endAt).toBe('2026-12-01T00:00:00.000Z');
    expect(result.team?.remainingDays).toBe(34);
    expect(result.team?.subscriptionId).toBeNull();
    expect(result.period).toBeNull();
  });

  it('returns loaded personal allowances and preserves the subscription when Harness fails', async () => {
    const allowance: TokenPlanHarnessAllowance = {
      toolId: 'tool-1',
      toolName: 'Tool',
      totalQuota: '10',
      remainingQuota: '8',
      quotaUnit: 'calls',
      startAt: null,
      endAt: null,
    };
    harness.load.mockResolvedValueOnce({ allowances: [allowance], hasResourcePack: true });
    const service = new SubscriptionTokenPlanService(statusApi(true));
    expect(
      (await service.getTokenPlanStatus({ edition: 'individual' })).individual?.harnessAllowances,
    ).toEqual([allowance]);
    harness.load.mockRejectedValueOnce(new Error('equity unavailable'));
    const partial = await service.getTokenPlanStatus({ edition: 'individual' });
    expect(partial.individual?.status).toBe('active');
    expect(partial.individual).not.toHaveProperty('harnessAllowances');
    expect(partial.diagnostics).toContainEqual(
      expect.objectContaining({ api: 'HarnessAllowances', errorCode: 'SERVICE_UNAVAILABLE' }),
    );
  });

  it('propagates caller abort and clears the soft deadline even when requests ignore the signal', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    let requestSignal: AbortSignal | undefined;
    const api = makeMockApiClient({
      csData: async (opts) => {
        requestSignal = opts.signal;
        return new Promise(() => {});
      },
    });
    const pending = new SubscriptionTokenPlanService(api).getTokenPlanStatus({
      edition: 'individual',
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('retains the successful empty-state catalog flag %s', async (flag) => {
    harness.load.mockResolvedValueOnce({ allowances: [], hasResourcePack: flag });
    const result = await new SubscriptionTokenPlanService(statusApi(true)).getTokenPlanStatus({
      edition: 'individual',
    });
    expect(result.individual).toMatchObject({
      harnessAllowances: [],
      harnessHasResourcePack: flag,
    });
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ api: 'HarnessAllowances' }),
    );
  });

  it('treats the former pending code as an ordinary failure without exposing backend text', async () => {
    harness.load.mockRejectedValueOnce(
      Object.assign(new Error('sensitive backend detail'), { code: 'TOKENPLAN_HARNESS_PENDING' }),
    );
    const result = await new SubscriptionTokenPlanService(statusApi(true)).getTokenPlanStatus({
      edition: 'individual',
    });
    expect(result.individual).not.toHaveProperty('harnessAllowances');
    expect(result.diagnostics).toContainEqual({
      api: 'HarnessAllowances',
      errorCode: 'SERVICE_UNAVAILABLE',
      errorMessage: 'The service is temporarily unavailable. Try again later.',
    });
  });

  it('bounds ignored signals, marks only the selected edition unknown, and discards late responses', async () => {
    vi.useFakeTimers();
    const release: Array<() => void> = [];
    const api = makeMockApiClient({
      csData: async (opts) =>
        new Promise((resolve) => {
          release.push(() =>
            resolve(
              opts.parse(
                opts.api.endsWith('/subscription')
                  ? { code: 'SUCCESS', success: true }
                  : { data: {} },
              ),
            ),
          );
        }),
    });
    const pending = new SubscriptionTokenPlanService(api).getTokenPlanStatus({
      edition: 'individual',
    });
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await pending;
    const before = structuredClone(result);
    expect(result).not.toHaveProperty('team');
    expect(result.individual?.status).toBe('unknown');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ api: 'IndividualSubscription', errorCode: 'Timeout' }),
    );
    expect(vi.getTimerCount()).toBe(0);
    for (const resolve of release) resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(before);
    expect(harness.load).not.toHaveBeenCalled();
  });

  it('does not start requests when the caller is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const api = statusApi();
    await expect(
      new SubscriptionTokenPlanService(api).getTokenPlanStatus({ signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(api.callFlatApi).not.toHaveBeenCalled();
    expect(api.callCsDataApi).not.toHaveBeenCalled();
  });
});
