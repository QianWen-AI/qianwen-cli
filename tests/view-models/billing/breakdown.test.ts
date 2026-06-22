import { describe, it, expect } from 'vitest';
import { buildBillingBreakdownViewModel } from '../../../src/view-models/billing/breakdown.js';
import { defaultViewContext } from '../../../src/view-models/billing/shared.js';
import type { ConsumeBreakdown } from '../../../src/types/billing-extra.js';

const ctx = defaultViewContext();

function makeBreakdown(overrides: Partial<ConsumeBreakdown> = {}): ConsumeBreakdown {
  return {
    groupBy: 'model',
    period: { from: '2026-04-01', to: '2026-04-30' },
    chargeType: 'all',
    rows: [],
    totalRows: 0,
    totalAmount: '0',
    currency: 'CNY',
    ...overrides,
  };
}

describe('buildBillingBreakdownViewModel', () => {
  it('builds rows with formatted amount and label', () => {
    const data = makeBreakdown({
      rows: [
        { groupKey: 'qwen3.6-plus', groupLabel: 'qwen3.6-plus', amount: '1.23' },
        { groupKey: 'qwen3-max', groupLabel: 'qwen3-max', amount: '0.5' },
      ],
      totalRows: 2,
      totalAmount: '1.73',
    });
    const vm = buildBillingBreakdownViewModel(data, ctx);

    expect(vm.groupBy).toBe('model');
    expect(vm.period).toBe('2026-04-01 → 2026-04-30');
    expect(vm.columns.map((c) => c.header)).toEqual(['Model', 'Amount']);
    expect(vm.rows).toHaveLength(2);
    expect(vm.rows[0].cells).toMatchObject({
      key: 'qwen3.6-plus',
      label: 'qwen3.6-plus',
      amount: '¥1.23',
    });
    expect(vm.shown).toBe(2);
    expect(vm.totalRows).toBe(2);
    expect(vm.truncationNotice).toBeNull();
    expect(vm.total.amount).toBe('1.73');
    expect(vm.total.display).toBe('¥1.73');
  });

  it('uses dimension-specific column header per groupBy', () => {
    const headers: Record<string, string> = {
      model: 'Model',
      'api-key': 'API Key',
    };
    for (const [g, h] of Object.entries(headers)) {
      const vm = buildBillingBreakdownViewModel(
        makeBreakdown({ groupBy: g as ConsumeBreakdown['groupBy'] }),
        ctx,
      );
      expect(vm.columns[0].header).toBe(h);
      expect(vm.columns.some((c) => c.header === 'Amount')).toBe(true);
    }
  });

  it('emits truncationNotice when shown < totalRows', () => {
    const data = makeBreakdown({
      rows: [{ groupKey: 'a', groupLabel: 'A', amount: '1' }],
      totalRows: 5,
    });
    const vm = buildBillingBreakdownViewModel(data, ctx);
    expect(vm.truncationNotice).toBe('Showing top 1 / 5');
  });

  it('renders em-dash for zero amount', () => {
    const vm = buildBillingBreakdownViewModel(
      makeBreakdown({
        rows: [{ groupKey: 'idle', groupLabel: 'idle', amount: '0' }],
        totalRows: 1,
        totalAmount: '0',
      }),
      ctx,
    );
    expect(vm.rows[0].cells.amount).toBe('—');
  });

  it('falls back to groupKey when groupLabel is empty', () => {
    const vm = buildBillingBreakdownViewModel(
      makeBreakdown({
        rows: [{ groupKey: 'wsp-7', groupLabel: '', amount: '0.5' }],
        totalRows: 1,
      }),
      ctx,
    );
    expect(vm.rows[0].cells.label).toBe('wsp-7');
  });

  it('renders em-dash for total when there are no rows', () => {
    const vm = buildBillingBreakdownViewModel(
      makeBreakdown({ rows: [], totalRows: 0, totalAmount: '0' }),
      ctx,
    );
    expect(vm.total.amount).toBe('—');
    expect(vm.total.display).toBe('—');
  });

  it('totalAmount NaN → em-dash on total.amount', () => {
    const vm = buildBillingBreakdownViewModel(
      makeBreakdown({
        rows: [{ groupKey: 'x', groupLabel: 'x', amount: '1' }],
        totalRows: 1,
        totalAmount: 'oops',
      }),
      ctx,
    );
    expect(vm.total.amount).toBe('—');
  });

  it('honors currency override on view-context', () => {
    const vm = buildBillingBreakdownViewModel(makeBreakdown({ currency: 'USD' }), {
      ...ctx,
      currency: 'USD',
    });
    expect(vm.currency).toBe('USD');
  });
});
