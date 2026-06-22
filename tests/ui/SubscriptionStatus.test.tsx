import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { SubscriptionStatusInk } from '../../src/ui/SubscriptionStatus.js';
import type { SubscriptionStatusViewModel } from '../../src/view-models/subscription/index.js';

const makeVm = (
  overrides: Partial<SubscriptionStatusViewModel> = {},
): SubscriptionStatusViewModel => ({
  available: true,
  banner: null,
  footnote: null,
  fields: [
    { label: 'Plan', value: 'Pro' },
    { label: 'Period', value: '2026-01-01 → 2026-12-31' },
    { label: 'Auto-Renew', value: 'Yes' },
    { label: 'Renewable', value: 'Yes' },
    { label: 'Gray', value: 'No' },
  ],
  sections: [],
  quota: null,
  quotaBar: null,
  diagnostics: [],
  errorBanner: null,
  notice: null,
  tokenPlanSection: null,
  creditPackSection: null,
  codingPlanSection: null,
  recentOrdersSection: null,
  ...overrides,
});

const frame = (vm: SubscriptionStatusViewModel) =>
  stripAnsi(render(<SubscriptionStatusInk vm={vm} />).lastFrame() ?? '');

describe('SubscriptionStatusInk', () => {
  it('renders title and all field rows', () => {
    const out = frame(makeVm());
    expect(out).toContain('Subscription Status');
    expect(out).toContain('Plan');
    expect(out).toContain('Pro');
    expect(out).toContain('Period');
    expect(out).toContain('2026-01-01');
    expect(out).toContain('Auto-Renew');
    expect(out).toContain('Renewable');
    expect(out).toContain('Gray');
  });

  it('renders the unavailable banner when banner is set', () => {
    const out = frame(
      makeVm({
        banner: 'Subscription unavailable',
        fields: [],
      }),
    );
    expect(out).toContain('Subscription unavailable');
  });

  it('lists diagnostics under the banner when available', () => {
    const out = frame(
      makeVm({
        banner: 'Subscription unavailable',
        fields: [],
        diagnostics: [
          {
            api: 'GetUserPlan',
            errorCode: 'AuthExpired',
            errorMessage: 'token expired',
          },
        ],
      }),
    );
    expect(out).toContain('GetUserPlan');
    expect(out).toContain('AuthExpired');
    expect(out).toContain('token expired');
  });

  it('renders quota row with display and bar when quota is set', () => {
    const out = frame(
      makeVm({
        quota: {
          total: 1000,
          remaining: 250,
          usedPct: 75,
          bar: '████████████████████····',
          display: '250 / 1,000 (75%)',
        },
      }),
    );
    expect(out).toContain('Quota');
    expect(out).toContain('250 / 1,000 (75%)');
    expect(out).toContain('████');
  });

  it('renders footnote as the section footer when set', () => {
    const out = frame(
      makeVm({
        footnote: 'Note: 1 source(s) unavailable',
      }),
    );
    expect(out).toContain('1 source(s) unavailable');
  });

  it('omits quota section when quota is null', () => {
    const out = frame(makeVm({ quota: null }));
    expect(out).not.toContain('Quota');
  });

  it('renders Recent Orders section with mapped labels', () => {
    const vm = makeVm({
      recentOrdersSection: {
        orders: [
          { id: 'ord-101', type: 'purchase', typeLabel: 'Purchase', date: '2026-04-15', amount: '¥199.00', statusLabel: 'Paid', statusColor: 'green' as const },
          { id: 'ord-102', type: 'renew', typeLabel: 'Renew', date: '2026-04-20', amount: '¥99.00', statusLabel: 'Unpaid', statusColor: 'orange' as const },
        ],
      },
      tokenPlanSection: {
        status: 'Active',
        autoRenew: 'Yes',
        expires: '2026-12-31',
        tiers: [],
      },
    });
    const out = frame(vm);
    expect(out).toMatch(/═══\s+Recent Orders/);
    expect(out).toContain('ord-101');
    expect(out).toContain('Purchase');
    expect(out).toContain('2026-04-15');
    expect(out).toContain('199.00');
  });
});
