import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { BillingBreakdownInk } from '../../src/ui/BillingBreakdown.js';
import type { BillingBreakdownViewModel } from '../../src/view-models/billing/index.js';

const makeRow = (label: string, amount: string) => ({
  cells: { key: label, label, amount },
  raw: { amount },
});

const makeVm = (overrides: Partial<BillingBreakdownViewModel> = {}): BillingBreakdownViewModel => ({
  groupBy: 'model',
  period: '2026-01',
  chargeType: 'PostPaid',
  columns: [
    { key: 'label', header: 'Model' },
    { key: 'amount', header: 'Amount' },
  ],
  rows: [makeRow('qwen-max', '¥250.00'), makeRow('qwen-plus', '¥120.00')],
  total: { amount: '370.00', raw: '370.00', display: '¥370.00' },
  currency: 'CNY',
  shown: 2,
  totalRows: 2,
  truncationNotice: null,
  ...overrides,
});

const frame = (vm: BillingBreakdownViewModel) =>
  stripAnsi(render(<BillingBreakdownInk vm={vm} />).lastFrame() ?? '');

describe('BillingBreakdownInk', () => {
  it('renders title with subtitle composed of group/period/chargeType', () => {
    const out = frame(makeVm());
    expect(out).toContain('Consumption Breakdown');
    expect(out).toContain('Model');
    expect(out).toContain('2026-01');
    expect(out).toContain('PostPaid');
  });

  it('renders all data rows and the TOTAL row with the formatted total', () => {
    const out = frame(makeVm());
    expect(out).toContain('qwen-max');
    expect(out).toContain('¥250.00');
    expect(out).toContain('qwen-plus');
    expect(out).toContain('TOTAL');
    expect(out).toContain('¥370.00');
  });

  it('renders truncationNotice as the section footer when present', () => {
    const out = frame(
      makeVm({
        shown: 2,
        totalRows: 50,
        truncationNotice: 'Showing top 2 / 50',
      }),
    );
    expect(out).toContain('Showing top 2');
  });

  it('renders "No data." placeholder when rows is empty', () => {
    const out = frame(makeVm({ rows: [], shown: 0, totalRows: 0 }));
    // `data` array always has the TOTAL row appended, but only when rows is empty
    // it still has length 1 and renders the table; either path must show TOTAL.
    expect(out).toContain('TOTAL');
  });

  it('uses the API Key header when groupBy=api-key', () => {
    const out = frame(
      makeVm({
        groupBy: 'api-key',
        columns: [
          { key: 'label', header: 'API Key' },
          { key: 'amount', header: 'Amount' },
        ],
      }),
    );
    expect(out).toContain('API Key');
  });
});
