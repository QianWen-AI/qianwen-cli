import { describe, it, expect } from 'vitest';
import { buildBillingLimitViewModel } from '../../../src/view-models/billing/limit.js';
import { defaultViewContext } from '../../../src/view-models/billing/shared.js';
import type { UsageLimit } from '../../../src/types/billing-extra.js';

const ctx = defaultViewContext();

function makeLimit(overrides: Partial<UsageLimit> = {}): UsageLimit {
  return {
    status: 'active',
    limitAmount: '500',
    currency: 'CNY',
    alertThreshold: '80',
    ...overrides,
  } as UsageLimit;
}

describe('buildBillingLimitViewModel', () => {
  it('returns the three card fields in display order', () => {
    const vm = buildBillingLimitViewModel(makeLimit(), ctx);
    expect(vm.fields.map((f) => f.label)).toEqual([
      'Status',
      'Limit',
      'Alert threshold',
    ]);
  });

  it('maps known statuses to friendly labels', () => {
    const cases: Array<[UsageLimit['status'], string]> = [
      ['normal', 'Active'],
      ['active', 'Active'],
      ['exceeded', 'Exceeded'],
      ['warning', 'Warning'],
      ['unknown', 'Unknown'],
    ];
    for (const [raw, label] of cases) {
      const vm = buildBillingLimitViewModel(makeLimit({ status: raw }), ctx);
      expect(vm.fields[0].value).toBe(label);
    }
  });

  it('preserves raw status string when not in label map', () => {
    const vm = buildBillingLimitViewModel(makeLimit({ status: 'paused' }), ctx);
    expect(vm.fields[0].value).toBe('paused');
  });

  it('reads the currency symbol from the view context', () => {
    const vm = buildBillingLimitViewModel(makeLimit(), { ...ctx, currency: 'CNY' });
    const limitField = vm.fields.find((f) => f.label === 'Limit');
    expect(limitField?.value).toContain('¥');
  });

  it('limitAmount null → em-dash', () => {
    const vm = buildBillingLimitViewModel(makeLimit({ limitAmount: null }), ctx);
    expect(vm.fields[1].value).toBe('—');
  });

  it('alertThreshold non-numeric → em-dash', () => {
    const vm = buildBillingLimitViewModel(makeLimit({ alertThreshold: 'invalid' }), ctx);
    expect(vm.fields[2].value).toBe('—');
  });

  it('alertThreshold empty → em-dash', () => {
    const vm = buildBillingLimitViewModel(makeLimit({ alertThreshold: '' }), ctx);
    expect(vm.fields[2].value).toBe('—');
  });
});
