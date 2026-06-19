/**
 * Tests for UsageService — composes BillingService + FreetierService + TokenplanService
 * concurrently into a single summary, and delegates breakdown queries to BillingService.
 */
import { describe, it, expect, vi } from 'vitest';
import { UsageService } from '../../src/services/usage-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import type { BillingService } from '../../src/services/billing-service.js';
import type { FreetierService } from '../../src/services/freetier-service.js';
import type { TokenplanService } from '../../src/services/tokenplan-service.js';
import type {
  PayAsYouGo,
  TokenPlan,
  FreeTierUsage,
  UsageBreakdownResponse,
} from '../../src/types/usage.js';

// ────────────────────────────────────────────────────────────────────
// Stub factories — only the surfaces UsageService consumes
// ────────────────────────────────────────────────────────────────────

interface StubBillingService extends Pick<BillingService, 'getPaygSummary' | 'getPaygBreakdown'> {
  getPaygSummary: ReturnType<typeof vi.fn>;
  getPaygBreakdown: ReturnType<typeof vi.fn>;
}

interface StubFreetierService extends Pick<FreetierService, 'fetchFreeTierUsageList'> {
  fetchFreeTierUsageList: ReturnType<typeof vi.fn>;
}

interface StubTokenplanService extends Pick<TokenplanService, 'fetchTokenPlan'> {
  fetchTokenPlan: ReturnType<typeof vi.fn>;
}

function makeStubBilling(overrides?: {
  payg?: PayAsYouGo;
  breakdown?: UsageBreakdownResponse;
}): StubBillingService {
  const defaultPayg: PayAsYouGo = {
    models: [],
    total: { cost: 0, currency: 'CNY' },
  };
  const defaultBreakdown: UsageBreakdownResponse = {
    model_id: 'all',
    period: { from: '2026-06-01', to: '2026-06-30' },
    granularity: 'day',
    rows: [],
    total: { cost: 0, currency: 'CNY' },
  };
  return {
    getPaygSummary: vi.fn(async () => overrides?.payg ?? defaultPayg),
    getPaygBreakdown: vi.fn(async () => overrides?.breakdown ?? defaultBreakdown),
  };
}

function makeStubFreetier(items: FreeTierUsage[] = []): StubFreetierService {
  return { fetchFreeTierUsageList: vi.fn(async () => items) };
}

function makeStubTokenplan(plan: TokenPlan = { subscribed: false }): StubTokenplanService {
  return { fetchTokenPlan: vi.fn(async () => plan) };
}

function buildService(opts?: {
  billing?: StubBillingService;
  freetier?: StubFreetierService;
  tokenplan?: StubTokenplanService;
}): {
  svc: UsageService;
  billing: StubBillingService;
  freetier: StubFreetierService;
  tokenplan: StubTokenplanService;
} {
  const billing = opts?.billing ?? makeStubBilling();
  const freetier = opts?.freetier ?? makeStubFreetier();
  const tokenplan = opts?.tokenplan ?? makeStubTokenplan();
  const svc = new UsageService(
    makeMockApiClient(),
    billing as unknown as BillingService,
    freetier as unknown as FreetierService,
    tokenplan as unknown as TokenplanService,
    makeMockCachedFetcher(),
  );
  return { svc, billing, freetier, tokenplan };
}

// ────────────────────────────────────────────────────────────────────
// getUsageSummary
// ────────────────────────────────────────────────────────────────────

describe('UsageService.getUsageSummary', () => {
  it('fans out to all three sub-services concurrently with the supplied date range', async () => {
    const { svc, billing, freetier, tokenplan } = buildService({
      billing: makeStubBilling({
        payg: {
          models: [
            { model_id: 'qwen-plus', usage: { tokens_in: 100 }, cost: 1.5, currency: 'CNY' },
          ],
          total: { cost: 1.5, currency: 'CNY' },
        },
      }),
      freetier: makeStubFreetier([{ model_id: 'qwen-plus', quota: null }]),
      tokenplan: makeStubTokenplan({ subscribed: true, planName: 'P1' }),
    });

    const out = await svc.getUsageSummary({ from: '2026-05-01', to: '2026-05-31' });

    expect(out.period).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(out.free_tier).toHaveLength(1);
    expect(out.token_plan.subscribed).toBe(true);
    expect(out.pay_as_you_go.models).toHaveLength(1);

    expect(billing.getPaygSummary).toHaveBeenCalledWith({
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(freetier.fetchFreeTierUsageList).toHaveBeenCalledTimes(1);
    expect(tokenplan.fetchTokenPlan).toHaveBeenCalledTimes(1);
  });

  it('defaults from to first-of-this-month UTC and to to today UTC when omitted', async () => {
    const { svc, billing } = buildService();
    const out = await svc.getUsageSummary();

    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = today.replace(/-\d{2}$/, '-01');
    expect(out.period).toEqual({ from: firstOfMonth, to: today });
    expect(billing.getPaygSummary).toHaveBeenCalledWith({
      from: firstOfMonth,
      to: today,
    });
  });

  it('propagates a billing service failure (no swallowing at the orchestrator)', async () => {
    const billing = makeStubBilling();
    billing.getPaygSummary.mockRejectedValueOnce(new Error('billing down'));
    const { svc } = buildService({ billing });

    await expect(svc.getUsageSummary({ from: '2026-06-01', to: '2026-06-30' })).rejects.toThrow(
      'billing down',
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// getUsageBreakdown
// ────────────────────────────────────────────────────────────────────

describe('UsageService.getUsageBreakdown', () => {
  it('delegates to billing.getPaygBreakdown with explicit options', async () => {
    const billing = makeStubBilling({
      breakdown: {
        model_id: 'qwen-plus',
        period: { from: '2026-04-01', to: '2026-04-30' },
        granularity: 'month',
        rows: [],
        total: { cost: 0, currency: 'CNY' },
      },
    });
    const { svc } = buildService({ billing });

    const out = await svc.getUsageBreakdown({
      model: 'qwen-plus',
      granularity: 'month',
      from: '2026-04-01',
      to: '2026-04-30',
    });

    expect(billing.getPaygBreakdown).toHaveBeenCalledWith({
      from: '2026-04-01',
      to: '2026-04-30',
      granularity: 'month',
      modelFilter: 'qwen-plus',
    });
    expect(out.model_id).toBe('qwen-plus');
  });

  it('defaults granularity to day and fills in dates when omitted', async () => {
    const billing = makeStubBilling();
    const { svc } = buildService({ billing });
    await svc.getUsageBreakdown({ model: 'qwen-plus' });

    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = today.replace(/-\d{2}$/, '-01');
    expect(billing.getPaygBreakdown).toHaveBeenCalledWith({
      from: firstOfMonth,
      to: today,
      granularity: 'day',
      modelFilter: 'qwen-plus',
    });
  });
});
