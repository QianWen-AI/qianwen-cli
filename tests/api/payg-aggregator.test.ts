import { describe, it, expect } from 'vitest';
import {
  aggregatePaygByModel,
  aggregatePaygByDate,
  type PaygItem,
} from '../../src/api/payg-aggregator.js';

function item(overrides: Partial<PaygItem>): PaygItem {
  return {
    billingDate: '2026-04-01',
    billingMonth: '2026-04',
    modelId: 'qwen3.6-plus',
    usageValue: 0,
    cost: 0,
    billingUnit: 'tokens',
    ...overrides,
  };
}

describe('aggregatePaygByModel (summary view)', () => {
  it('groups items by modelId and sums usage / cost', () => {
    const items: PaygItem[] = [
      item({ modelId: 'qwen3.6-plus', usageValue: 5_000_000, cost: 2.5, billingUnit: 'tokens' }),
      item({ modelId: 'qwen3.6-plus', usageValue: 4_500_000, cost: 2.3, billingUnit: 'tokens' }),
      item({ modelId: 'wan2.6-t2v',   usageValue: 10,        cost: 0.0, billingUnit: 'seconds' }),
    ];
    const r = aggregatePaygByModel(items);

    expect(r.models).toHaveLength(2);
    const llm = r.models.find((m) => m.model_id === 'qwen3.6-plus')!;
    expect(llm.usage.tokens_in).toBe(9_500_000);
    expect(llm.cost).toBeCloseTo(4.8, 6);

    const video = r.models.find((m) => m.model_id === 'wan2.6-t2v')!;
    expect(video.usage.seconds).toBe(10);
    expect(video.cost).toBe(0);
  });

  it('rolls up token usage into the tokens_in bucket (API does not split in/out)', () => {
    const items: PaygItem[] = [
      item({ modelId: 'm', usageValue: 100, billingUnit: 'tokens' }),
      item({ modelId: 'm', usageValue: 200, billingUnit: 'tokens' }),
    ];
    const r = aggregatePaygByModel(items);
    expect(r.models[0].usage).toEqual({ tokens_in: 300 });
  });

  it('uses unit name as the usage key for non-token billing', () => {
    const items: PaygItem[] = [
      item({ modelId: 'img', usageValue: 5,  billingUnit: 'images' }),
      item({ modelId: 'img', usageValue: 10, billingUnit: 'images' }),
    ];
    const r = aggregatePaygByModel(items);
    expect(r.models[0].usage).toEqual({ images: 15 });
  });

  it('total aggregates cost across all models', () => {
    const items: PaygItem[] = [
      item({ modelId: 'a', cost: 1.10, usageValue: 1 }),
      item({ modelId: 'a', cost: 2.20, usageValue: 1 }),
      item({ modelId: 'b', cost: 0.30, usageValue: 1 }),
    ];
    const r = aggregatePaygByModel(items);
    expect(r.total.cost).toBeCloseTo(3.6, 6);
  });

  it('drops items missing modelId', () => {
    const items: PaygItem[] = [
      item({ modelId: '', usageValue: 1, cost: 1 }),
      item({ modelId: 'real', usageValue: 1, cost: 1 }),
    ];
    const r = aggregatePaygByModel(items);
    expect(r.models).toHaveLength(1);
    expect(r.models[0].model_id).toBe('real');
  });

  it('returns empty arrays/zeros on empty input', () => {
    const r = aggregatePaygByModel([]);
    expect(r.models).toEqual([]);
    expect(r.total).toEqual({ cost: 0, currency: 'CNY' });
  });
});

describe('aggregatePaygByDate (breakdown view)', () => {
  it('groups by billingDate and bundles non-token usage', () => {
    const items: PaygItem[] = [
      item({ billingDate: '2026-04-01', modelId: 'wan2.6-t2v', usageValue: 10, cost: 0,    billingUnit: 'seconds' }),
      item({ billingDate: '2026-04-02', modelId: 'wan2.6-t2v', usageValue: 5,  cost: 0,    billingUnit: 'seconds' }),
    ];
    const rows = aggregatePaygByDate(items);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ period: '2026-04-01', billingUnit: 'seconds' });
    expect((rows[0] as any).seconds).toBe(10);
    expect(rows[1]).toMatchObject({ period: '2026-04-02', billingUnit: 'seconds' });
    expect((rows[1] as any).seconds).toBe(5);
  });

  it('sorts rows by period ascending', () => {
    const items: PaygItem[] = [
      item({ billingDate: '2026-04-19', usageValue: 1 }),
      item({ billingDate: '2026-04-02', usageValue: 1 }),
      item({ billingDate: '2026-04-10', usageValue: 1 }),
    ];
    const rows = aggregatePaygByDate(items);
    expect(rows.map((r) => r.period)).toEqual(['2026-04-02', '2026-04-10', '2026-04-19']);
  });

  it('puts token usage into tokens_in (top-level), other units flat with their unit name', () => {
    const items: PaygItem[] = [
      item({ billingDate: '2026-04-01', usageValue: 1000, billingUnit: 'tokens' }),
      item({ billingDate: '2026-04-02', usageValue: 7,    billingUnit: 'images' }),
    ];
    const rows = aggregatePaygByDate(items);
    expect(rows[0].tokens_in).toBe(1000);
    expect((rows[1] as any).images).toBe(7);
  });

  it('marks billingUnit="tokens" when a single date mixes multiple units', () => {
    // Defensive default: ambiguous days fall back to tokens.
    const items: PaygItem[] = [
      item({ billingDate: '2026-04-01', usageValue: 100, billingUnit: 'tokens' }),
      item({ billingDate: '2026-04-01', usageValue: 5,   billingUnit: 'images' }),
    ];
    const rows = aggregatePaygByDate(items);
    expect(rows[0].billingUnit).toBe('tokens');
    expect(rows[0].tokens_in).toBe(100);
    expect((rows[0] as any).images).toBe(5);
  });

  it('skips items missing billingDate', () => {
    const items: PaygItem[] = [
      item({ billingDate: '', usageValue: 1 }),
      item({ billingDate: '2026-04-01', usageValue: 2 }),
    ];
    const rows = aggregatePaygByDate(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_in).toBe(2);
  });

  it('rounds cost to 4 decimal places', () => {
    const items: PaygItem[] = [
      item({ billingDate: '2026-04-01', cost: 0.123456789, usageValue: 1 }),
    ];
    const rows = aggregatePaygByDate(items);
    expect(rows[0].cost).toBe(0.1235);
  });

  it('returns [] on empty input', () => {
    expect(aggregatePaygByDate([])).toEqual([]);
  });
});

describe('summary and breakdown reconcile on shared input', () => {
  it('per-model totals from summary == sum of breakdown for that model', () => {
    const items: PaygItem[] = [
      item({ billingDate: '2026-04-01', modelId: 'm', usageValue: 100, cost: 0.10, billingUnit: 'tokens' }),
      item({ billingDate: '2026-04-02', modelId: 'm', usageValue: 200, cost: 0.20, billingUnit: 'tokens' }),
      item({ billingDate: '2026-04-03', modelId: 'm', usageValue: 300, cost: 0.30, billingUnit: 'tokens' }),
    ];
    const summary = aggregatePaygByModel(items);
    const breakdown = aggregatePaygByDate(items.filter((i) => i.modelId === 'm'));

    const summaryUsage = summary.models[0].usage.tokens_in;
    const breakdownUsage = breakdown.reduce((s, r) => s + (r.tokens_in ?? 0), 0);
    expect(summaryUsage).toBe(breakdownUsage);

    const summaryCost = summary.models[0].cost;
    const breakdownCost = breakdown.reduce((s, r) => s + r.cost, 0);
    expect(Math.abs(summaryCost - breakdownCost)).toBeLessThan(0.0001);
  });
});
