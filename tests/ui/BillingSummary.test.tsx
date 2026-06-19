import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { BillingSummaryInk } from '../../src/ui/BillingSummary.js';
import type { BillingSummaryViewModel } from '../../src/view-models/billing/index.js';

const baseField = (label: string, value: string) => ({ label, value, raw: value });

const makeVm = (overrides: Partial<BillingSummaryViewModel> = {}): BillingSummaryViewModel => ({
  cycle: '2026-01',
  chargeType: 'PostPaid',
  currency: 'CNY',
  cycles: [],
  totals: {
    aftertaxAmount: '113',
  },
  fields: [baseField('Total', '¥113')],
  ...overrides,
});

const frame = (vm: BillingSummaryViewModel): string => {
  const { lastFrame } = render(<BillingSummaryInk vm={vm} />);
  return stripAnsi(lastFrame() ?? '');
};

describe('BillingSummaryInk', () => {
  it('renders the section title and subtitle (cycle · chargeType)', () => {
    const out = frame(makeVm());
    expect(out).toContain('Bill Summary');
    expect(out).toContain('2026-01');
    expect(out).toContain('PostPaid');
  });

  it('renders the total field label and value', () => {
    const out = frame(makeVm());
    expect(out).toContain('Total');
    expect(out).toContain('¥113');
    expect(out).not.toContain('Spend before tax');
    expect(out).not.toContain('Tax');
  });

  it('omits the chargeType separator when chargeType is undefined', () => {
    const out = frame(makeVm({ chargeType: undefined }));
    expect(out).toContain('2026-01');
    expect(out).not.toContain('PostPaid');
  });

  it('renders em-dash placeholders for missing amounts', () => {
    const fields = [baseField('Total', '—')];
    const out = frame(
      makeVm({
        fields,
      }),
    );
    expect(out).toContain('—');
  });
});
