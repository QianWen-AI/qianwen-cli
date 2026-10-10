import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { SubscriptionStatusInk } from '../../src/ui/SubscriptionStatus.js';
import { SubscriptionTokenPlanStatusInk } from '../../src/ui/SubscriptionTokenPlanStatus.js';
import { buildTokenPlanStatusViewModel } from '../../src/view-models/subscription/tokenplan-status.js';
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

  it('groups edition sections under Token Plans without a synthetic Account section', () => {
    const out = frame(
      makeVm({
        fields: [],
        sections: [
          {
            id: 'tokenplan-individual',
            title: 'Individual',
            fields: [{ label: 'Status', value: 'active' }],
          },
        ],
      }),
    );
    expect(out).toContain('Token Plans');
    expect(out).toContain('Individual');
    expect(out).not.toContain('Account');
    expect(out).not.toContain('Gray');
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

  it('lists safe diagnostic messages without API names or internal codes', () => {
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
    expect(out).toContain('token expired');
    expect(out).not.toContain('GetUserPlan');
    expect(out).not.toContain('AuthExpired');
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

  it('renders Team seat usage and scoped recent orders without a duplicate Token Plan summary', () => {
    const vm = makeVm({
      recentOrdersSection: {
        orders: [
          {
            id: 'ord-101',
            type: 'purchase',
            typeLabel: 'Purchase',
            date: '2026-04-15',
            amount: '¥199.00',
            statusLabel: 'Paid',
            statusColor: 'green' as const,
          },
          {
            id: 'ord-102',
            type: 'renew',
            typeLabel: 'Renew',
            date: '2026-04-20',
            amount: '¥99.00',
            statusLabel: 'Unpaid',
            statusColor: 'orange' as const,
          },
        ],
      },
      tokenPlanSection: {
        status: 'Active',
        autoRenew: 'Yes',
        expires: '2026-12-31',
        tiers: [
          {
            label: 'Standard (2 seats)',
            bar: '██████████████████████░░ 44,982 / 50,000',
            remaining: 44_982,
            total: 50_000,
            usedPct: 10.036,
          },
        ],
      },
      sections: [
        {
          id: 'tokenplan-team',
          title: 'Team',
          fields: [{ label: 'Status', value: 'active' }],
        },
      ],
    });
    const out = frame(vm);
    expect(out).toContain('Seat Usage');
    expect(out).toContain('Standard (2 seats)');
    expect(out).not.toContain('Expires:');
    expect(out).toMatch(/═══\s+Recent Token Plan Orders/);
    expect(out).toContain('ord-101');
    expect(out).toContain('Purchase');
    expect(out).toContain('2026-04-15');
    expect(out).toContain('199.00');
  });
});

describe('SubscriptionTokenPlanStatusInk', () => {
  it('shows only seat types and quantities in the dedicated summary', () => {
    const vm = buildTokenPlanStatusViewModel(
      {
        product: 'Token Plan Team Edition',
        period: null,
        autoRenew: null,
        renewable: null,
        diagnostics: [],
        seatSummary: {
          groups: [
            {
              specType: 'standard',
              seats: 1,
              assigned: null,
              totalValue: '25000',
              surplusValue: '25000',
              unit: 'Credits',
              nextCycleFlushTime: null,
            },
          ],
          total: null,
        },
      },
      'tui',
    );

    const out = stripAnsi(render(<SubscriptionTokenPlanStatusInk vm={vm} />).lastFrame() ?? '');
    expect(out).toContain('SEAT SUMMARY');
    expect(out).toMatch(/SEAT TYPE\s+QUANTITY/);
    expect(out).toMatch(/Standard Seat\s+1/);
    expect(out).not.toMatch(/Total Credits|Remaining Credits|25,000/);
    expect(out).not.toContain('Next Cycle');
  });

  it('retains next-cycle data without adding it to the dedicated summary', () => {
    const vm = buildTokenPlanStatusViewModel(
      {
        product: 'Token Plan Team Edition',
        period: null,
        autoRenew: null,
        renewable: null,
        diagnostics: [],
        seatSummary: {
          groups: [
            {
              specType: 'standard',
              seats: 1,
              assigned: null,
              totalValue: '25000',
              surplusValue: '25000',
              unit: 'Credits',
              nextCycleFlushTime: '2026-10-16T00:00:00+08:00',
            },
          ],
          total: null,
        },
      },
      'tui',
    );

    const out = stripAnsi(render(<SubscriptionTokenPlanStatusInk vm={vm} />).lastFrame() ?? '');
    expect(out).toMatch(/Standard Seat\s+1/);
    expect(out).not.toContain('Next Cycle');
    expect(out).not.toContain('2026-10-16');
    expect(vm.seatSummary?.groups[0].nextCycleFlushTime).toBe('2026-10-16T00:00:00+08:00');
  });
});
