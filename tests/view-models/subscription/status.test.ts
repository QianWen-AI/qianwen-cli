import { describe, it, expect } from 'vitest';
import { buildSubscriptionStatusViewModel } from '../../../src/view-models/subscription/status.js';
import type {
  SubscriptionStatus,
  SubscriptionDiagnostic,
} from '../../../src/types/subscription.js';

function makeStatus(overrides: Partial<SubscriptionStatus> = {}): SubscriptionStatus {
  return {
    isGray: true,
    plan: 'Token Plan Team',
    period: { start: '2026-01-01', end: '2027-01-01' },
    quota: { remaining: 800, total: 1000, usedPct: 20 },
    autoRenew: true,
    renewable: true,
    ...overrides,
  };
}

describe('buildSubscriptionStatusViewModel', () => {
  it('renders unavailable banner when data is null', () => {
    const vm = buildSubscriptionStatusViewModel(null, []);
    expect(vm.available).toBe(false);
    expect(vm.banner).toContain('unavailable');
    expect(vm.fields).toHaveLength(0);
    expect(vm.sections).toHaveLength(0);
    expect(vm.quota).toBeNull();
    expect(vm.errorBanner).toBe(vm.banner);
  });

  it('builds canonical 5-field record with formatting', () => {
    const vm = buildSubscriptionStatusViewModel(makeStatus(), [], {
      columns: 120,
      currency: 'CNY',
      locale: 'en',
      dateFormat: 'iso',
    });
    expect(vm.available).toBe(true);
    expect(vm.banner).toBeNull();
    const labels = vm.fields.map((f) => f.label);
    expect(labels).toEqual(['Plan', 'Period', 'Auto-Renew', 'Renewable', 'Gray']);
    expect(vm.fields[0].value).toBe('Token Plan Team');
    expect(vm.fields[1].value).toBe('2026-01-01 → 2027-01-01');
    expect(vm.fields[2].value).toBe('Yes');
    expect(vm.fields[3].value).toBe('Yes');
    expect(vm.fields[4].value).toBe('Yes');
  });

  it('null booleans render as em-dash; null period as em-dash', () => {
    const vm = buildSubscriptionStatusViewModel(
      makeStatus({ autoRenew: null, renewable: null, isGray: null, period: null, plan: null }),
      [],
    );
    expect(vm.fields[0].value).toBe('—'); // plan
    expect(vm.fields[1].value).toBe('—'); // period
    expect(vm.fields[2].value).toBe('—'); // auto-renew
    expect(vm.fields[3].value).toBe('—'); // renewable
    expect(vm.fields[4].value).toBe('—'); // gray
  });

  it('builds quota section when quota present (wide ctx)', () => {
    const vm = buildSubscriptionStatusViewModel(makeStatus(), [], {
      columns: 120,
      currency: 'CNY',
      locale: 'en',
      dateFormat: 'iso',
    });
    expect(vm.quota).not.toBeNull();
    expect(vm.quota!.display).toContain('800');
    expect(vm.quota!.display).toContain('1,000');
    expect(vm.quota!.usedPct).toBe(20);
    expect(vm.sections.find((s) => s.id === 'quota')?.fields).toHaveLength(2);
  });

  it('quota null → placeholder section', () => {
    const vm = buildSubscriptionStatusViewModel(makeStatus({ quota: null }), [], {
      columns: 120,
      currency: 'CNY',
      locale: 'en',
      dateFormat: 'iso',
    });
    expect(vm.quota).toBeNull();
    const quotaSection = vm.sections.find((s) => s.id === 'quota');
    expect(quotaSection?.placeholder).toBe('Quota unavailable');
  });

  it('emits footnote when diagnostics are present', () => {
    const diagnostics: SubscriptionDiagnostic[] = [
      { api: 'GetSubscription', errorCode: 'RPC_TIMEOUT', errorMessage: 'request timed out' },
    ];
    const vm = buildSubscriptionStatusViewModel(makeStatus(), diagnostics);
    expect(vm.footnote).toContain('1 source');
    expect(vm.notice).toBe(vm.footnote);
    expect(vm.diagnostics).toEqual(diagnostics);
  });

  it('renders narrow-terminal placeholder bar', () => {
    const vm = buildSubscriptionStatusViewModel(makeStatus(), [], {
      columns: 50,
      currency: 'CNY',
      locale: 'en',
      dateFormat: 'iso',
    });
    expect(vm.quotaBar).toMatch(/^\[\d+\.\d{2}%\]$/);
  });

  it('quota total=0 → display falls back to em-dash', () => {
    const vm = buildSubscriptionStatusViewModel(
      makeStatus({ quota: { remaining: 0, total: 0, usedPct: 0 } }),
      [],
      { columns: 120, currency: 'CNY', locale: 'en', dateFormat: 'iso' },
    );
    expect(vm.quota!.display).toBe('—');
  });

  it('maps recentOrders through TYPE_LABEL and ORDER_STATUS_LABEL', () => {
    const vm = buildSubscriptionStatusViewModel(
      makeStatus({
        recentOrders: [
          { orderId: 'ord-001', orderType: 'purchase', orderTime: '2026-04-15T10:00:00Z', amount: '199.00', status: 'PAID' },
          { orderId: 'ord-002', orderType: 'renew', orderTime: '2026-04-20T08:30:00Z', amount: '99.00', status: 'UNPAID' },
        ],
      }),
      [],
    );
    expect(vm.recentOrdersSection).not.toBeNull();
    expect(vm.recentOrdersSection?.orders).toHaveLength(2);
    expect(vm.recentOrdersSection?.orders[0].id).toBe('ord-001');
    expect(vm.recentOrdersSection?.orders[0].type).toBe('purchase');
    expect(vm.recentOrdersSection?.orders[0].typeLabel).toBe('Purchase');
    expect(vm.recentOrdersSection?.orders[0].date).toBe('2026-04-15');
    expect(vm.recentOrdersSection?.orders[0].amount).toContain('199.00');
    expect(vm.recentOrdersSection?.orders[0].statusLabel).toBe('Paid');
    expect(vm.recentOrdersSection?.orders[0].statusColor).toBe('green');
    expect(vm.recentOrdersSection?.orders[1].typeLabel).toBe('Renew');
    expect(vm.recentOrdersSection?.orders[1].statusLabel).toBe('Unpaid');
    expect(vm.recentOrdersSection?.orders[1].statusColor).toBe('orange');
  });
});
