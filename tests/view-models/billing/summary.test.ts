import { describe, it, expect } from 'vitest';
import { buildBillingSummaryViewModel } from '../../../src/view-models/billing/summary.js';
import { defaultViewContext } from '../../../src/view-models/billing/shared.js';
import type { SettleBillSummary } from '../../../src/types/billing-extra.js';

const ctx = defaultViewContext();

function makeSummary(overrides: Partial<SettleBillSummary> = {}): SettleBillSummary {
  return {
    cycles: [],
    totals: {
      pretaxAmount: '0',
      tax: '0',
      aftertaxAmount: '0',
    },
    currency: 'CNY',
    period: { from: '2026-04-01', to: '2026-04-30' },
    ...overrides,
  };
}

describe('buildBillingSummaryViewModel', () => {
  it('builds field list with only Total for non-zero totals', () => {
    const data = makeSummary({
      totals: {
        pretaxAmount: '12.345',
        tax: '0.617',
        aftertaxAmount: '12.962',
      },
    });
    const vm = buildBillingSummaryViewModel(data, ctx);
    expect(vm.cycle).toBe('2026-04-01 → 2026-04-30');
    expect(vm.fields).toHaveLength(1);
    expect(vm.fields[0]).toEqual({
      label: 'Total',
      value: '¥12.962',
      raw: '12.962',
    });
    expect(vm.totals.aftertaxAmount).toBe('12.962');
    expect(vm.currency).toBe('CNY');
  });

  it('uses single date when from === to', () => {
    const vm = buildBillingSummaryViewModel(
      makeSummary({ period: { from: '2026-04-15', to: '2026-04-15' } }),
      ctx,
    );
    expect(vm.cycle).toBe('2026-04-15');
  });

  it('derives totals via sumAmountStrings when totals is missing', () => {
    const data = {
      ...makeSummary(),
      totals: undefined as unknown as SettleBillSummary['totals'],
      cycles: [
        {
          billingCycle: '2026-04',
          pretaxAmount: '0.1',
          tax: '0.005',
          aftertaxAmount: '0.105',
        },
        {
          billingCycle: '2026-03',
          pretaxAmount: '0.2',
          tax: '0.01',
          aftertaxAmount: '0.21',
        },
      ],
    } as SettleBillSummary;
    const vm = buildBillingSummaryViewModel(data, ctx);
    // 0.105 + 0.21 = 0.315 → high-precision math, no IEEE-754 drift
    expect(vm.totals.aftertaxAmount).toBe('0.315');
    expect(vm.cycles).toHaveLength(2);
    expect(vm.cycles[0].display).toHaveLength(1);
  });

  it('handles empty cycles → totals fall back to 0', () => {
    const data = {
      ...makeSummary(),
      totals: undefined as unknown as SettleBillSummary['totals'],
      cycles: [],
    } as SettleBillSummary;
    const vm = buildBillingSummaryViewModel(data, ctx);
    expect(vm.totals.aftertaxAmount).toBe('0');
    expect(vm.cycles).toHaveLength(0);
  });

  it('chargeType passes through unchanged', () => {
    const vm = buildBillingSummaryViewModel(makeSummary({ chargeType: 'postpaid' }), ctx);
    expect(vm.chargeType).toBe('postpaid');
  });

  it('formats per-cycle display with currency symbol', () => {
    const vm = buildBillingSummaryViewModel(
      makeSummary({
        cycles: [
          {
            billingCycle: '2026-04',
            pretaxAmount: '5',
            tax: '0.25',
            aftertaxAmount: '5.25',
          },
        ],
      }),
      ctx,
    );
    expect(vm.cycles).toHaveLength(1);
    expect(vm.cycles[0].billingCycle).toBe('2026-04');
    expect(vm.cycles[0].display).toHaveLength(1);
    expect(vm.cycles[0].display[0]).toEqual({ label: 'Total', value: '¥5.25', raw: '5.25' });
  });

  it('renders em-dash for non-finite raw values', () => {
    const vm = buildBillingSummaryViewModel(
      makeSummary({
        totals: {
          pretaxAmount: 'NaN',
          tax: '',
          aftertaxAmount: 'NaN',
        },
      }),
      ctx,
    );
    expect(vm.fields[0].label).toBe('Total');
    expect(vm.fields[0].value).toBe('—');
  });
});
