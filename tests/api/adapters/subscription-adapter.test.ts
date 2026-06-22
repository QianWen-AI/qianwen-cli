/**
 * Tests for the subscription adapter — pure transformations from raw
 * flat-parameter responses into Service-layer DTOs. The adapter has no I/O
 * and no side effects, so these tests focus on:
 *   - field mapping precision (PlanName → plan, Status='VALID' → activeInstance)
 *   - fallback chains (PostTaxAmount → PretaxAmount → Amount; GmtCreate → GmtPay → OrderTime)
 *   - boolean coercion (number 0/1 → boolean for AutoRenewal)
 *   - boundary semantics (empty Data, missing fields, partial period blocks)
 */
import { describe, it, expect } from 'vitest';
import {
  transformSubscriptionGray,
  transformSeatSubscriptionSummary,
  transformSubscriptionDetail,
  transformAutoRenewal,
  transformInstancesRenewable,
  transformOrderList,
  transformOrderDetail,
} from '../../../src/api/adapters/subscription-adapter.js';

// ────────────────────────────────────────────────────────────────────
// transformSubscriptionGray
// ────────────────────────────────────────────────────────────────────

describe('transformSubscriptionGray', () => {
  it('returns the boolean IsGray when present', () => {
    expect(transformSubscriptionGray({ IsGray: true })).toEqual({ isGray: true });
    expect(transformSubscriptionGray({ IsGray: false })).toEqual({ isGray: false });
  });

  it('returns null when IsGray is missing or non-boolean', () => {
    expect(transformSubscriptionGray({})).toEqual({ isGray: null });
    expect(transformSubscriptionGray(null)).toEqual({ isGray: null });
    expect(transformSubscriptionGray({ IsGray: 'true' })).toEqual({ isGray: null });
    expect(transformSubscriptionGray({ IsGray: 1 })).toEqual({ isGray: null });
  });
});

// ────────────────────────────────────────────────────────────────────
// transformSeatSubscriptionSummary
// ────────────────────────────────────────────────────────────────────

describe('transformSeatSubscriptionSummary', () => {
  it('maps a complete payload', () => {
    expect(
      transformSeatSubscriptionSummary({
        PeriodStart: '2026-05-01',
        PeriodEnd: '2026-06-01',
        PlanName: 'Coding Pro',
        PlanCode: 'plan-pro',
        Seats: 10,
      }),
    ).toEqual({
      plan: 'Coding Pro',
      planCode: 'plan-pro',
      period: { start: '2026-05-01', end: '2026-06-01' },
      seats: 10,
    });
  });

  it('returns a null period when either bound is missing or empty', () => {
    expect(
      transformSeatSubscriptionSummary({
        PeriodStart: '',
        PeriodEnd: '2026-06-01',
        PlanName: 'P',
      }).period,
    ).toBeNull();
    expect(
      transformSeatSubscriptionSummary({
        PeriodStart: '2026-05-01',
        PlanName: 'P',
      }).period,
    ).toBeNull();
  });

  it('returns null fields when raw is null/empty', () => {
    expect(transformSeatSubscriptionSummary(null)).toEqual({
      plan: null,
      planCode: null,
      period: null,
      seats: null,
    });
    expect(transformSeatSubscriptionSummary({})).toEqual({
      plan: null,
      planCode: null,
      period: null,
      seats: null,
    });
  });

  it('coerces empty PlanName / PlanCode strings to null', () => {
    const out = transformSeatSubscriptionSummary({ PlanName: '', PlanCode: '', Seats: 0 });
    expect(out.plan).toBeNull();
    expect(out.planCode).toBeNull();
    expect(out.seats).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// transformSubscriptionDetail
// ────────────────────────────────────────────────────────────────────

describe('transformSubscriptionDetail', () => {
  it('selects the first VALID instance as activeInstance', () => {
    const out = transformSubscriptionDetail({
      Data: [
        {
          InstanceId: 'inst-expired',
          Status: 'EXPIRED',
          PlanName: 'Old Plan',
          StartTime: '2025-01-01',
          EndTime: '2025-12-31',
        },
        {
          InstanceId: 'inst-active',
          Status: 'VALID',
          PlanName: 'Current Plan',
          StartTime: '2026-01-01',
          EndTime: '2026-12-31',
        },
        {
          InstanceId: 'inst-fallback',
          Status: 'VALID',
          PlanName: 'Backup Plan',
          StartTime: '2026-06-01',
          EndTime: '2027-05-31',
        },
      ],
    });
    expect(out.instances).toHaveLength(3);
    expect(out.activeInstance?.instanceId).toBe('inst-active');
    expect(out.activeInstance?.plan).toBe('Current Plan');
    expect(out.activeInstance?.period).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('returns null activeInstance when no item has status=VALID', () => {
    const out = transformSubscriptionDetail({
      Data: [
        {
          InstanceId: 'inst-1',
          Status: 'EXPIRED',
          PlanName: 'P',
          StartTime: '2025-01-01',
          EndTime: '2025-12-31',
        },
      ],
    });
    expect(out.activeInstance).toBeNull();
    expect(out.instances).toHaveLength(1);
  });

  it('returns empty instances when raw or Data is missing', () => {
    expect(transformSubscriptionDetail(null)).toEqual({ instances: [], activeInstance: null });
    expect(transformSubscriptionDetail({})).toEqual({ instances: [], activeInstance: null });
  });

  it('falls back to empty defaults for partial entries', () => {
    const out = transformSubscriptionDetail({
      Data: [{ InstanceId: 'i', Status: 'VALID', PlanName: '', StartTime: '', EndTime: '' }],
    });
    expect(out.instances[0]).toEqual({
      instanceId: 'i',
      status: 'VALID',
      plan: null,
      period: null,
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// transformAutoRenewal
// ────────────────────────────────────────────────────────────────────

describe('transformAutoRenewal', () => {
  it('reads boolean Data.AutoRenewal first', () => {
    expect(transformAutoRenewal({ Data: { AutoRenewal: true } })).toEqual({ autoRenew: true });
    expect(transformAutoRenewal({ Data: { AutoRenewal: false } })).toEqual({ autoRenew: false });
  });

  it('coerces numeric Data.AutoRenewal to a boolean', () => {
    expect(transformAutoRenewal({ Data: { AutoRenewal: 1 } })).toEqual({ autoRenew: true });
    expect(transformAutoRenewal({ Data: { AutoRenewal: 0 } })).toEqual({ autoRenew: false });
  });

  it('falls back through EnableRenew → AutoRenewal → Enable', () => {
    expect(transformAutoRenewal({ EnableRenew: true })).toEqual({ autoRenew: true });
    expect(transformAutoRenewal({ AutoRenewal: false })).toEqual({ autoRenew: false });
    expect(transformAutoRenewal({ Enable: true })).toEqual({ autoRenew: true });
  });

  it('returns null when nothing matches', () => {
    expect(transformAutoRenewal({})).toEqual({ autoRenew: null });
    expect(transformAutoRenewal(null)).toEqual({ autoRenew: null });
    expect(transformAutoRenewal({ Data: {} })).toEqual({ autoRenew: null });
  });
});

// ────────────────────────────────────────────────────────────────────
// transformInstancesRenewable
// ────────────────────────────────────────────────────────────────────

describe('transformInstancesRenewable', () => {
  it('reads CanRenew from the first Data item', () => {
    expect(transformInstancesRenewable({ Data: [{ CanRenew: true }] })).toEqual({
      renewable: true,
    });
    expect(
      transformInstancesRenewable({ Data: [{ CanRenew: false }, { CanRenew: true }] }),
    ).toEqual({ renewable: false });
  });

  it('reads camelCase canRenew as a fallback', () => {
    expect(transformInstancesRenewable({ Data: [{ canRenew: true }] })).toEqual({
      renewable: true,
    });
  });

  it('falls back to top-level Renewable when Data is empty', () => {
    expect(transformInstancesRenewable({ Renewable: false })).toEqual({ renewable: false });
    expect(transformInstancesRenewable({ Data: [] })).toEqual({ renewable: null });
  });

  it('returns null when nothing is present', () => {
    expect(transformInstancesRenewable(null)).toEqual({ renewable: null });
    expect(transformInstancesRenewable({})).toEqual({ renewable: null });
  });
});

// ────────────────────────────────────────────────────────────────────
// transformOrderList
// ────────────────────────────────────────────────────────────────────

describe('transformOrderList', () => {
  it('maps orders, picking the first non-empty time field', () => {
    const out = transformOrderList({
      Data: [
        {
          OrderId: 'o-1',
          OrderType: 'purchase',
          GmtCreate: '2026-05-01T10:00:00Z',
          PostTaxAmount: '100.00',
          Currency: 'USD',
          OrderStatus: 'paid',
        },
        {
          OrderId: 'o-2',
          OrderType: 'renew',
          GmtPay: '2026-05-15T10:00:00Z',
          PretaxAmount: '50',
          Status: 'pending',
        },
        {
          OrderId: 'o-3',
          OrderType: 'refund',
          OrderTime: '2026-05-20T10:00:00Z',
          Amount: 25,
          Status: 'refunded',
        },
      ],
      TotalCount: 17,
      PageSize: 10,
      CurrentPage: 2,
    });

    expect(out.orders).toEqual([
      {
        orderId: 'o-1',
        orderType: 'purchase',
        orderTime: '2026-05-01T10:00:00Z',
        amount: '100.00',
        currency: 'USD',
        status: 'paid',
      },
      {
        orderId: 'o-2',
        orderType: 'renew',
        orderTime: '2026-05-15T10:00:00Z',
        amount: '50',
        status: 'pending',
      },
      {
        orderId: 'o-3',
        orderType: 'refund',
        orderTime: '2026-05-20T10:00:00Z',
        amount: '25',
        status: 'refunded',
      },
    ]);

    expect(out.pagination).toEqual({ totalCount: 17, pageSize: 10, currentPage: 2 });
  });

  it('reads real amount fields (PayAmount preferred) and settlement currency', () => {
    const out = transformOrderList({
      Data: [
        {
          OrderId: 'o-real',
          OrderType: 'BUY',
          GmtCreate: '2026-06-08T06:17:29Z',
          OriginalAmount: '99.00',
          PayAmount: '79.20',
          TradeAmount: '79.20',
          CashAmount: '79.20',
          SettCurrency: 'CNY',
          OrderStatus: 'PAID',
        },
      ],
    });
    expect(out.orders[0].amount).toBe('79.20');
    expect(out.orders[0].currency).toBe('CNY');
  });

  it('falls back to OriginalAmount when pay/trade/cash amounts are absent', () => {
    const out = transformOrderList({
      Data: [{ OrderId: 'o-x', GmtCreate: '2026-06-01', OriginalAmount: '54.00' }],
    });
    expect(out.orders[0].amount).toBe('54.00');
  });

  it('omits the currency field when raw Currency is missing or empty', () => {
    const out = transformOrderList({
      Data: [{ OrderId: 'o-1', GmtCreate: '2026-05-01', PostTaxAmount: '1' }],
    });
    expect(out.orders[0]).not.toHaveProperty('currency');
  });

  it('uses fallback pagination defaults (totalCount=orders.length, pageSize=20, page=1)', () => {
    const out = transformOrderList({
      Data: [{ OrderId: 'o-1', GmtCreate: '2026-05-01' }],
    });
    expect(out.pagination).toEqual({ totalCount: 1, pageSize: 20, currentPage: 1 });
  });

  it('returns empty orders for null/empty/missing payloads', () => {
    expect(transformOrderList(null).orders).toEqual([]);
    expect(transformOrderList({}).orders).toEqual([]);
    expect(transformOrderList({ Data: [] }).orders).toEqual([]);
  });

  it('totalCount falls back to orders.length when raw TotalCount is non-numeric', () => {
    const out = transformOrderList({
      Data: [{ OrderId: 'o-1', GmtCreate: '2026-05-01' }],
      TotalCount: 'not-a-number' as unknown as number,
    });
    expect(out.pagination.totalCount).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// transformOrderDetail
// ────────────────────────────────────────────────────────────────────

describe('transformOrderDetail', () => {
  it('maps a complete order detail with line items', () => {
    expect(
      transformOrderDetail({
        OrderId: 'o-1',
        OrderType: 'purchase',
        OrderTime: '2026-05-01T10:00:00Z',
        Amount: '100',
        Status: 'paid',
        Items: [
          { Name: 'Token Plan Personal', Quantity: '1', Amount: '50' },
          { Name: 'Add-on Pack', Quantity: 2, Amount: 25 },
        ],
        InvoiceUrl: 'https://invoice.test.qianwen.com/o-1.pdf',
      }),
    ).toEqual({
      orderId: 'o-1',
      orderType: 'purchase',
      orderTime: '2026-05-01T10:00:00Z',
      amount: '100',
      status: 'paid',
      items: [
        { name: 'Token Plan Personal', quantity: 1, amount: '50' },
        { name: 'Add-on Pack', quantity: 2, amount: '25' },
      ],
      invoiceUrl: 'https://invoice.test.qianwen.com/o-1.pdf',
    });
  });

  it('returns empty/null defaults for null/empty input', () => {
    expect(transformOrderDetail(null)).toEqual({
      orderId: '',
      orderType: '',
      orderTime: '',
      amount: '0',
      status: '',
      items: [],
      invoiceUrl: null,
    });
  });

  it('returns invoiceUrl=null when the URL is empty or missing', () => {
    expect(transformOrderDetail({ OrderId: 'x', InvoiceUrl: '' }).invoiceUrl).toBeNull();
    expect(transformOrderDetail({ OrderId: 'x' }).invoiceUrl).toBeNull();
  });

  it('coerces malformed Quantity / Amount to safe defaults', () => {
    const out = transformOrderDetail({
      OrderId: 'x',
      Items: [{ Name: 'item', Quantity: 'NaN', Amount: '' }],
    });
    expect(out.items[0]).toEqual({ name: 'item', quantity: 0, amount: '0' });
  });

  it('returns empty items when Items is missing or non-array', () => {
    expect(transformOrderDetail({ OrderId: 'x' }).items).toEqual([]);
    expect(transformOrderDetail({ OrderId: 'x', Items: 'not-an-array' }).items).toEqual([]);
  });
});
