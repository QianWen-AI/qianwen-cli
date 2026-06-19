import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { SubscriptionOrdersInk } from '../../src/ui/SubscriptionOrders.js';
import type { SubscriptionOrdersViewModel } from '../../src/view-models/subscription/index.js';

const makeRow = (overrides: Partial<SubscriptionOrdersViewModel['rows'][number]> = {}) => ({
  orderId: 'ord-001',
  orderType: 'purchase',
  orderTypeLabel: 'Purchase',
  orderTime: '2026-01-15',
  amountDisplay: '¥99',
  amountRaw: '99',
  amount: '¥99',
  currency: 'CNY',
  status: 'PAID',
  statusLabel: 'Paid',
  statusColor: 'green' as const,
  detailError: null,
  ...overrides,
});

const makeVm = (
  overrides: Partial<SubscriptionOrdersViewModel> = {},
): SubscriptionOrdersViewModel => ({
  rows: [makeRow()],
  columns: [
    { key: 'orderId', header: 'Order ID' },
    { key: 'orderTypeLabel', header: 'Type' },
    { key: 'orderTime', header: 'Time' },
    { key: 'amountDisplay', header: 'Amount' },
    { key: 'statusLabel', header: 'Status' },
  ],
  pagination: { page: 1, pageSize: 10, total: 1 },
  diagnostics: [],
  isEmpty: false,
  emptyPlaceholder: 'No orders',
  pagingNote: 'Page 1 • Showing 1–1 of 1',
  summaryLine: '1 order',
  page: 1,
  pageSize: 10,
  totalCount: 1,
  ...overrides,
});

const frame = (vm: SubscriptionOrdersViewModel) =>
  stripAnsi(render(<SubscriptionOrdersInk vm={vm} />).lastFrame() ?? '');

describe('SubscriptionOrdersInk', () => {
  it('renders title, paging note, and a populated row', () => {
    const out = frame(makeVm());
    expect(out).toContain('Subscription Orders');
    expect(out).toContain('ord-001');
    expect(out).toContain('Purchase');
    expect(out).toContain('2026-01-15');
    expect(out).toContain('¥99');
    expect(out).toContain('Paid');
    expect(out).toContain('Showing 1');
  });

  it('renders empty state with placeholder text when isEmpty', () => {
    const out = frame(
      makeVm({
        rows: [],
        isEmpty: true,
        emptyPlaceholder: 'No orders',
        pagingNote: 'No orders',
      }),
    );
    expect(out).toContain('Subscription Orders');
    expect(out).toContain('No orders');
  });

  it('marks status with (!) suffix when row has detailError', () => {
    const out = frame(
      makeVm({
        rows: [makeRow({ status: 'PAID', statusLabel: 'Paid', statusColor: 'green', detailError: 'fetch failed' })],
      }),
    );
    expect(out).toContain('Paid (!)');
  });

  it('renders diagnostics line when diagnostics are present', () => {
    const out = frame(
      makeVm({
        diagnostics: [
          { api: 'QueryOrder', errorCode: 'Timeout', errorMessage: 'gateway' },
          { api: 'QueryOrder', errorCode: 'Timeout', errorMessage: 'gateway' },
        ],
      }),
    );
    expect(out).toMatch(/2 detail call\(s\) failed/);
  });

  it('does not render diagnostics line when none', () => {
    const out = frame(makeVm({ diagnostics: [] }));
    expect(out).not.toMatch(/detail call\(s\) failed/);
  });

  it('renders multiple rows in order', () => {
    const out = frame(
      makeVm({
        rows: [
          makeRow({ orderId: 'a-1', orderTypeLabel: 'Purchase' }),
          makeRow({ orderId: 'a-2', orderTypeLabel: 'Renew' }),
          makeRow({ orderId: 'a-3', orderTypeLabel: 'Refund' }),
        ],
      }),
    );
    expect(out).toContain('a-1');
    expect(out).toContain('a-2');
    expect(out).toContain('a-3');
    expect(out).toContain('Renew');
    expect(out).toContain('Refund');
  });
});
