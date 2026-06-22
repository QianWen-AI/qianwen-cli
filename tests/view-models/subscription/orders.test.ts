import { describe, it, expect } from 'vitest';
import { buildSubscriptionOrdersViewModel } from '../../../src/view-models/subscription/orders.js';
import type { SubscriptionOrders } from '../../../src/types/subscription.js';

function makeOrders(overrides: Partial<SubscriptionOrders> = {}): SubscriptionOrders {
  return {
    orders: [],
    pagination: { page: 1, pageSize: 20, total: 0 },
    ...overrides,
  };
}

describe('buildSubscriptionOrdersViewModel', () => {
  it('renders empty state when no orders', () => {
    const vm = buildSubscriptionOrdersViewModel(makeOrders());
    expect(vm.isEmpty).toBe(true);
    expect(vm.rows).toHaveLength(0);
    expect(vm.pagingNote).toBe('No orders');
    expect(vm.summaryLine).toBe(vm.pagingNote);
  });

  it('builds rows with type label, amount and currency', () => {
    const vm = buildSubscriptionOrdersViewModel(
      makeOrders({
        orders: [
          {
            orderId: 'ord-001',
            orderType: 'Purchase',
            orderTime: '2026-04-01 10:00',
            amount: '99',
            currency: 'CNY',
            status: 'PAID',
          },
          {
            orderId: 'ord-002',
            orderType: 'REFUND',
            orderTime: '2026-04-02 11:00',
            amount: '20',
            currency: 'CNY',
            status: 'REFUNDED',
          },
        ],
        pagination: { page: 1, pageSize: 20, total: 2 },
      }),
    );
    expect(vm.isEmpty).toBe(false);
    expect(vm.rows).toHaveLength(2);
    expect(vm.rows[0]).toMatchObject({
      orderId: 'ord-001',
      orderType: 'purchase',
      orderTypeLabel: 'Purchase',
      orderTime: '2026-04-01 10:00',
      amountDisplay: '¥99',
      amountRaw: '99',
      currency: 'CNY',
      status: 'PAID',
    });
    expect(vm.rows[1].orderType).toBe('refund');
    expect(vm.rows[1].orderTypeLabel).toBe('Refund');
    expect(vm.pagingNote).toBe('Page 1 • Showing 1–2 of 2');
  });

  it('paginates correctly when total > pageSize', () => {
    const vm = buildSubscriptionOrdersViewModel(
      makeOrders({
        orders: Array.from({ length: 10 }, (_, i) => ({
          orderId: `ord-${i}`,
          orderType: 'purchase',
          orderTime: `2026-04-${String(i + 1).padStart(2, '0')} 10:00`,
          amount: '1',
          status: 'PAID',
        })),
        pagination: { page: 2, pageSize: 10, total: 25 },
      }),
    );
    expect(vm.pagingNote).toBe('Page 2 • Showing 11–20 of 25');
    expect(vm.pagination).toEqual({ page: 2, pageSize: 10, total: 25 });
    expect(vm.totalCount).toBe(25);
  });

  it('renders em-dash for missing fields', () => {
    const vm = buildSubscriptionOrdersViewModel(
      makeOrders({
        orders: [{ orderId: '', orderType: '', orderTime: '', amount: 'oops', status: '' }],
        pagination: { page: 1, pageSize: 1, total: 1 },
      }),
    );
    const row = vm.rows[0];
    expect(row.orderId).toBe('—');
    expect(row.orderType).toBe('unknown');
    // empty string passes through ?? (only null/undefined trigger fallback)
    expect(row.orderTypeLabel).toBe('');
    expect(row.orderTime).toBe('—');
    expect(row.amountDisplay).toBe('—');
    expect(row.status).toBe('—');
  });

  it('renew type maps to label "Renew"', () => {
    const vm = buildSubscriptionOrdersViewModel(
      makeOrders({
        orders: [
          {
            orderId: 'ord-r',
            orderType: 'Renew',
            orderTime: '2026-04-01',
            amount: '50',
            status: 'PAID',
          },
        ],
        pagination: { page: 1, pageSize: 10, total: 1 },
      }),
    );
    expect(vm.rows[0].orderTypeLabel).toBe('Renew');
  });

  it('detailError surfaced on the row view-model', () => {
    const vm = buildSubscriptionOrdersViewModel(
      makeOrders({
        orders: [
          {
            orderId: 'ord-x',
            orderType: 'purchase',
            orderTime: '2026-04-01',
            amount: '1',
            status: 'PAID',
            detailError: 'GetOrderDetail failed',
          },
        ],
        pagination: { page: 1, pageSize: 10, total: 1 },
      }),
    );
    expect(vm.rows[0].detailError).toBe('GetOrderDetail failed');
  });

  it('exposes columns in canonical order', () => {
    const vm = buildSubscriptionOrdersViewModel(makeOrders());
    expect(vm.columns.map((c) => c.key)).toEqual([
      'orderId',
      'orderTypeLabel',
      'orderTime',
      'amountDisplay',
      'statusLabel',
    ]);
  });
});
