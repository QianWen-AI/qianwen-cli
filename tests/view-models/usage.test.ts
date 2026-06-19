import { describe, it, expect } from 'vitest';
import {
  buildUsageSummaryViewModel,
  buildUsageBreakdownViewModel,
} from '../../src/view-models/usage.js';
import type {
  UsageSummaryResponse,
  UsageBreakdownResponse,
  UsageBreakdownRow,
} from '../../src/types/usage.js';
import { site } from '../../src/site.js';

const s = {
  ...site,
  ...site.features,
  currencySymbol: site.features.currency === 'CNY' ? '¥' : '$',
};

describe('buildUsageSummaryViewModel', () => {
  const mockResponse: UsageSummaryResponse = {
    period: { from: '2026-04-01', to: '2026-04-07' },
    free_tier: [
      {
        model_id: 'qwen3.6-plus',
        quota: { remaining: 850000, total: 1000000, unit: 'tokens', used_pct: 15, resetDate: null },
      },
      {
        model_id: 'wan2.6-t2i',
        quota: { remaining: 38, total: 50, unit: 'images', used_pct: 24, resetDate: null },
      },
      {
        model_id: 'qwen3.5-omni-plus',
        quota: null,
      },
    ],
    token_plan: { subscribed: false },
    pay_as_you_go: {
      models: [
        {
          model_id: 'qwen3.6-plus',
          usage: { tokens: 600000 },
          cost: 0.38,
          currency: 'CNY',
        },
        {
          model_id: 'wan2.6-t2i',
          usage: { images: 45 },
          cost: 1.35,
          currency: 'CNY',
        },
      ],
      total: { cost: 1.73, currency: 'CNY' },
    },
  };

  it('builds view model with all sections', () => {
    const vm = buildUsageSummaryViewModel(mockResponse);

    expect(vm.period).toBe('2026-04-07');

    // Free Tier
    expect(vm.freeTier).toBeDefined();
    expect(vm.freeTier!.rows).toHaveLength(3);
    // Sorted by remaining% ascending (most urgent first)
    // wan2.6-t2i: used_pct=24 → remaining=76% comes before qwen3.6-plus: remaining=85%
    expect(vm.freeTier!.rows[0]).toMatchObject({
      modelId: 'wan2.6-t2i',
      remaining: '38 img',
      total: '50 img',
      progressBar: { percentage: 76, mode: 'remaining', label: '76%' },
      isFreeOnly: false,
    });
    expect(vm.freeTier!.rows[1]).toMatchObject({
      modelId: 'qwen3.6-plus',
      remaining: '850K tok',
      total: '1M tok',
      progressBar: { percentage: 85, mode: 'remaining', label: '85%' },
      isFreeOnly: false,
    });
    // isFreeOnly models (null quota) are sorted last
    expect(vm.freeTier!.rows[2]).toMatchObject({
      modelId: 'qwen3.5-omni-plus',
      isFreeOnly: true,
    });
    expect(vm.freeTier!.footer).toBe('3 models with free tier');

    // Pay-as-you-go
    expect(vm.payAsYouGo).toBeDefined();
    expect(vm.payAsYouGo!.rows).toHaveLength(2);
    // Sorted by cost descending: wan2.6-t2i (¥1.35) first, qwen3.6-plus (¥0.38) second
    expect(vm.payAsYouGo!.rows[0].usage).toContain('img');
    expect(vm.payAsYouGo!.rows[1].usage).toContain('tok');
    expect(vm.payAsYouGo!.total.cost).toBe(`${s.currencySymbol}1.73`);
  });

  it('builds Token Plan section when subscribed', () => {
    const response = {
      ...mockResponse,
      token_plan: {
        subscribed: true,
        planName: 'Token Plan 团队版（月）',
        status: 'valid' as const,
        totalCredits: 25000,
        remainingCredits: 25000,
        usedPct: 0,
        resetDate: '2026-06-01T00:00:00Z',
        addonRemaining: 1000,
      },
    };
    const vm = buildUsageSummaryViewModel(response as any);
    expect(vm.tokenPlan).toBeDefined();
    expect(vm.tokenPlan!.planName).toBe('Token Plan 团队版（月）');
    expect(vm.tokenPlan!.status).toBe('valid');
    expect(vm.tokenPlan!.usageDisplay).toBe('25,000 / 25,000 Credits');
    expect(vm.tokenPlan!.progressBar.percentage).toBe(100);
    expect(vm.tokenPlan!.resetDate).toBe('2026-06-01');
    expect(vm.tokenPlan!.addonRemaining).toBe('1,000 Credits');
  });

  it('skips Token Plan when not subscribed', () => {
    const response = { ...mockResponse, token_plan: { subscribed: false } };
    const vm = buildUsageSummaryViewModel(response as any);
    expect(vm.tokenPlan).toBeUndefined();
  });

  it('Token Plan exhaust status shows 0% progress', () => {
    const response = {
      ...mockResponse,
      token_plan: {
        subscribed: true,
        planName: 'Token Plan 团队版（月）',
        status: 'exhaust' as const,
        totalCredits: 25000,
        remainingCredits: 0,
        usedPct: 100,
        resetDate: '2026-06-01T00:00:00Z',
      },
    };
    const vm = buildUsageSummaryViewModel(response as any);
    expect(vm.tokenPlan!.status).toBe('exhaust');
    expect(vm.tokenPlan!.progressBar.percentage).toBe(0);
    expect(vm.tokenPlan!.progressBar.label).toBe('0%');
  });

  it('handles empty pay-as-you-go', () => {
    const response = {
      ...mockResponse,
      pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
    };
    const vm = buildUsageSummaryViewModel(response);
    expect(vm.payAsYouGo!.isEmpty).toBe(true);
  });

  it('PAYG usage: renders single "X tok" for the neutral tokens key', () => {
    // Mirrors the real upstream behavior: API returns undifferentiated token count.
    const response = {
      ...mockResponse,
      pay_as_you_go: {
        models: [
          { model_id: 'qwen3.6-plus', usage: { tokens: 9_500_000 }, cost: 4.83, currency: 'CNY' },
        ],
        total: { cost: 4.83, currency: 'CNY' },
      },
    };
    const vm = buildUsageSummaryViewModel(response);
    expect(vm.payAsYouGo!.rows[0].usage).toBe('9.5M tok');
  });

  it('PAYG usage: falls back to dynamic key format for unknown usage keys', () => {
    const response = {
      ...mockResponse,
      pay_as_you_go: {
        models: [{ model_id: 'future-llm', usage: { calls: 500 }, cost: 0.1, currency: 'CNY' }],
        total: { cost: 0.1, currency: 'CNY' },
      },
    };
    const vm = buildUsageSummaryViewModel(response);
    expect(vm.payAsYouGo!.rows[0].usage).toBe('500 calls');
  });
});

describe('buildUsageBreakdownViewModel', () => {
  const mockResponse: UsageBreakdownResponse = {
    model_id: 'qwen3.6-plus',
    period: { from: '2026-04-01', to: '2026-04-07' },
    granularity: 'day',
    rows: [
      { period: '2026-04-01', tokens_in: 58200, tokens_out: 14400, cost: 0.19, currency: 'CNY' },
      { period: '2026-04-02', tokens_in: 47500, tokens_out: 11800, cost: 0.16, currency: 'CNY' },
    ],
    total: { tokens_in: 105700, tokens_out: 26200, cost: 0.35, currency: 'CNY' },
  };

  it('builds breakdown view model for token-based model', () => {
    const vm = buildUsageBreakdownViewModel(mockResponse);

    expect(vm.title).toBe('Daily Breakdown');
    expect(vm.modelId).toBe('qwen3.6-plus');
    expect(vm.period).toBe('2026-04-01 → 2026-04-07');
    expect(vm.rows).toHaveLength(2);
    expect(vm.columns).toHaveLength(4); // Date, Tokens (in), Tokens (out), Cost

    expect(vm.rows[0].cells.tokensIn).toBe('58.2K');
    expect(vm.rows[0].cells.tokensOut).toBe('14.4K');
    expect(vm.rows[0].cells.cost).toBe(`${s.currencySymbol}0.19`);

    expect(vm.total.cells.cost).toBe(`${s.currencySymbol}0.35`);
  });

  it('marks current row correctly', () => {
    const today = new Date().toISOString().slice(0, 10);
    const response: UsageBreakdownResponse = {
      ...mockResponse,
      rows: [{ period: today, tokens_in: 50000, tokens_out: 10000, cost: 0.1, currency: 'CNY' }],
      total: { tokens_in: 50000, tokens_out: 10000, cost: 0.1, currency: 'CNY' },
    };

    const vm = buildUsageBreakdownViewModel(response);
    expect(vm.rows[0].isCurrent).toBe(true);
    expect(vm.granularity).toBe('day');
  });

  it('changes title based on granularity', () => {
    const monthResponse = { ...mockResponse, granularity: 'month' as const };
    const vm = buildUsageBreakdownViewModel(monthResponse);
    expect(vm.title).toBe('Monthly Breakdown');

    const quarterResponse = { ...mockResponse, granularity: 'quarter' as const };
    const vm2 = buildUsageBreakdownViewModel(quarterResponse);
    expect(vm2.title).toBe('Quarterly Breakdown');
  });

  it('marks isEmpty and adds emptyHint when there are no rows', () => {
    const emptyResponse: UsageBreakdownResponse = {
      model_id: 'qwen3-max',
      period: { from: '2026-04-01', to: '2026-04-20' },
      granularity: 'day',
      rows: [],
      total: { cost: 0, currency: 'CNY' },
    };
    const vm = buildUsageBreakdownViewModel(emptyResponse);
    expect(vm.isEmpty).toBe(true);
    expect(vm.emptyHint).toBe('No usage in this period — try a wider --period.');
    expect(vm.rows).toHaveLength(0);
  });

  it('does not set emptyHint when rows exist', () => {
    const vm = buildUsageBreakdownViewModel(mockResponse);
    expect(vm.isEmpty).toBe(false);
    expect(vm.emptyHint).toBeUndefined();
  });

  it('adapts columns for image-based billing', () => {
    const imageResponse: any = {
      model_id: 'qwen-image-2.0-pro',
      period: { from: '2026-04-01', to: '2026-04-03' },
      granularity: 'day',
      rows: [{ period: '2026-04-01', usage: { images: 20 }, cost: 0.6, currency: 'CNY' }],
      total: { usage: { images: 20 }, cost: 0.6, currency: 'CNY' },
    };

    const vm = buildUsageBreakdownViewModel(imageResponse);
    const colKeys = vm.columns.map((c) => c.key);
    expect(colKeys).toContain('images');
    expect(colKeys).not.toContain('tokensIn');
  });

  it('uses billingUnitOverride to pick headers regardless of row content', () => {
    // Mimics the real-world bug: image model returned with empty rows OR
    // rows that only carry tokens_in: 0 / tokens_out: 0. Without the override,
    // headers would default to "Tokens (in/out)".
    const response: UsageBreakdownResponse = {
      model_id: 'qwen-image-2.0-pro',
      period: { from: '2026-04-01', to: '2026-04-20' },
      granularity: 'day',
      rows: [],
      total: { cost: 0, currency: 'CNY' },
    };
    const vm = buildUsageBreakdownViewModel(response, { billingUnitOverride: 'images' });
    const colKeys = vm.columns.map((c) => c.key);
    expect(colKeys).toEqual(['period', 'images', 'cost']);
    expect(vm.total.cells.images).toBe('—');
    expect(vm.total.cells.tokensIn).toBeUndefined();
  });

  it('reads non-token totals from response.total.usage', () => {
    const response: UsageBreakdownResponse = {
      model_id: 'wan2.6-r2v',
      period: { from: '2026-04-01', to: '2026-04-20' },
      granularity: 'day',
      rows: [{ period: '2026-04-01', usage: { seconds: 10 }, cost: 0.5, currency: 'CNY' }],
      total: { usage: { seconds: 10 }, cost: 0.5, currency: 'CNY' },
    };
    const vm = buildUsageBreakdownViewModel(response, { billingUnitOverride: 'seconds' });
    // The numeric value from summary (10 sec) must round-trip into breakdown.
    expect(vm.total.cells.seconds).toBe('10');
    expect(vm.rows[0].cells.seconds).toBe('10');
  });

  it('collapses to single "Tokens" column when no row carries tokens_out', () => {
    // The upstream billing API doesn't split in/out, so tokens_out is always 0.
    // Auto-collapse to a single column to avoid the misleading "0" output column.
    const response: UsageBreakdownResponse = {
      model_id: 'qwen3.6-plus',
      period: { from: '2026-04-01', to: '2026-04-20' },
      granularity: 'day',
      rows: [{ period: '2026-04-18', tokens_in: 5_800_000, cost: 2.93, currency: 'CNY' }],
      total: { tokens_in: 5_800_000, cost: 2.93, currency: 'CNY' },
    };
    const vm = buildUsageBreakdownViewModel(response, { billingUnitOverride: 'tokens' });
    const colKeys = vm.columns.map((c) => c.key);
    expect(colKeys).toEqual(['period', 'tokens', 'cost']);
    expect(vm.rows[0].cells.tokens).toBe('5.8M');
    expect(vm.rows[0].cells.tokensIn).toBeUndefined();
    expect(vm.total.cells.tokens).toBe('5.8M');
    expect(vm.total.cells.tokensOut).toBeUndefined();
  });

  it('keeps two-column "Tokens (in/out)" when any row carries tokens_out > 0', () => {
    // Forward-compatible: when the upstream API eventually splits in/out, the
    // existing two-column layout kicks in automatically without a code change.
    const response: UsageBreakdownResponse = {
      model_id: 'future-llm',
      period: { from: '2026-04-01', to: '2026-04-07' },
      granularity: 'day',
      rows: [
        { period: '2026-04-01', tokens_in: 58200, tokens_out: 14400, cost: 0.19, currency: 'CNY' },
      ],
      total: { tokens_in: 58200, tokens_out: 14400, cost: 0.19, currency: 'CNY' },
    };
    const vm = buildUsageBreakdownViewModel(response);
    const colKeys = vm.columns.map((c) => c.key);
    expect(colKeys).toEqual(['period', 'tokensIn', 'tokensOut', 'cost']);
    expect(vm.rows[0].cells.tokensIn).toBe('58.2K');
    expect(vm.rows[0].cells.tokensOut).toBe('14.4K');
    expect(vm.rows[0].cells.tokens).toBeUndefined();
  });

  it('empty token model collapses to single column with 0', () => {
    const response: UsageBreakdownResponse = {
      model_id: 'qwen3-max',
      period: { from: '2026-04-01', to: '2026-04-20' },
      granularity: 'day',
      rows: [],
      total: { cost: 0, currency: 'CNY' },
    };
    const vm = buildUsageBreakdownViewModel(response, { billingUnitOverride: 'tokens' });
    const colKeys = vm.columns.map((c) => c.key);
    expect(colKeys).toEqual(['period', 'tokens', 'cost']);
    expect(vm.total.cells.tokens).toBe('—');
  });

  it('billingUnitOverride=seconds builds Duration column for video/audio models', () => {
    const response: UsageBreakdownResponse = {
      model_id: 'wan2.7-r2v',
      period: { from: '2026-04-01', to: '2026-04-20' },
      granularity: 'day',
      rows: [],
      total: { cost: 0, currency: 'CNY' },
    };
    const vm = buildUsageBreakdownViewModel(response, { billingUnitOverride: 'seconds' });
    const colKeys = vm.columns.map((c) => c.key);
    expect(colKeys).toContain('seconds');
    expect(colKeys).not.toContain('tokensIn');
    expect(vm.total.cells.seconds).toBe('—');
  });
});

function makeBreakdownResponse(
  overrides: Partial<UsageBreakdownResponse> & { rows: UsageBreakdownRow[] },
): UsageBreakdownResponse {
  return {
    model_id: 'test-model',
    period: { from: '2026-04-01', to: '2026-04-07' },
    granularity: 'day',
    total: { cost: 0, currency: 'CNY' },
    ...overrides,
  };
}

describe('buildUsageBreakdownViewModel — pickBillingUnit override behaviour', () => {
  it('trusts a non-tokens override (images) even when all rows are zero', () => {
    const vm = buildUsageBreakdownViewModel(
      makeBreakdownResponse({
        model_id: 'wan2.6-t2i',
        rows: [
          { period: '2026-04-01', usage: { images: 0 }, cost: 0 },
          { period: '2026-04-02', usage: { images: 0 }, cost: 0 },
        ],
        total: { usage: { images: 0 }, cost: 0 },
      }),
      { billingUnitOverride: 'images' },
    );
    expect(vm.columns.map((c) => c.header)).toEqual(['Date', 'Images', 'Cost']);
    // Zero usage renders as em-dash, not "0".
    expect(vm.rows[0].cells.images).toBe('—');
    expect(vm.total.cells.images).toBe('—');
  });

  it('trusts a voices override (characters/seconds/voices are equally authoritative)', () => {
    const vm = buildUsageBreakdownViewModel(
      makeBreakdownResponse({
        rows: [{ period: '2026-04-01', usage: { voices: 0 }, cost: 0 }],
        total: { usage: { voices: 0 }, cost: 0 },
      }),
      { billingUnitOverride: 'voices' },
    );
    expect(vm.columns.map((c) => c.header)).toEqual(['Date', 'Voice', 'Cost']);
    expect(vm.rows[0].cells.voices).toBe('—');
  });

  it('lets tokens override yield to a dynamic inferred unit (e.g. "calls")', () => {
    // Scenario: inferBillingUnitFromModel falls through to 'tokens' for a
    // service whose API actually returns Per-1-call lines; the row carries a
    // numeric "calls" key, so the header must follow the data.
    const vm = buildUsageBreakdownViewModel(
      makeBreakdownResponse({
        rows: [
          {
            period: '2026-04-01',
            usage: { calls: 2_000_200 } as Record<string, number>,
            cost: 0.5,
          },
        ],
        total: { usage: { calls: 2_000_200 } as Record<string, number>, cost: 0.5 },
      }),
      { billingUnitOverride: 'tokens' },
    );
    expect(vm.columns.map((c) => c.header)).toEqual(['Date', 'Calls', 'Cost']);
    expect(vm.rows[0].cells.calls).toBe('2M');
    expect(vm.total.cells.calls).toBe('2M');
  });

  it('keeps the tokens override when inferred is also a fixed unit (tokens or voices)', () => {
    // Defensive: rows have tokens data; override='tokens' must win over a
    // hypothetical mis-inference. The fixed-unit guard in pickBillingUnit
    // protects against accidentally letting voices/images replace tokens.
    const vm = buildUsageBreakdownViewModel(
      makeBreakdownResponse({
        rows: [{ period: '2026-04-01', tokens_in: 1234, cost: 0.01 }],
        total: { tokens_in: 1234, cost: 0.01 },
      }),
      { billingUnitOverride: 'tokens' },
    );
    expect(vm.columns.find((c) => c.key === 'tokens')?.header).toBe('Tokens');
    expect(vm.rows[0].cells.tokens).toBe('1.2K');
  });
});
