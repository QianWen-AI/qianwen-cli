import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSubscriptionStatusViewModel } from '../../../src/view-models/subscription/status.js';
import { buildTokenPlanStatusViewModel } from '../../../src/view-models/subscription/tokenplan-status.js';
import { buildTokenPlanSeatsViewModel } from '../../../src/view-models/subscription/tokenplan-seats.js';
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

const individual = {
  edition: 'individual' as const,
  commodityCode: 'sfm_tokenplanpersonal_dp_cn',
  status: 'active' as const,
  type: 'token_plan_individual_standard',
  name: 'Standard',
  specCode: 'standard',
  period: {
    start: '2026-07-27T11:00:00.000Z',
    end: '2026-09-27T11:00:00.000Z',
    remainingDays: 12,
  },
  remainingDays: 12,
  autoRenew: { enabled: true, period: 1, periodUnit: 'Year' },
  weeklyCredits: { total: 1000, used: 200, remaining: 800 },
  seatSummary: null,
  completeness: 'complete' as const,
  diagnostics: [],
};

const team = {
  edition: 'team' as const,
  commodityCode: 'sfm_tokenplanteams_dp_cn',
  status: 'not_subscribed' as const,
  type: 'token_plan_team',
  name: null,
  specCode: null,
  period: null,
  remainingDays: null,
  autoRenew: null,
  seatSummary: null,
  completeness: 'complete' as const,
  diagnostics: [],
};

describe('buildSubscriptionStatusViewModel', () => {
  afterEach(() => vi.unstubAllEnvs());
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

  it('groups edition fields without a synthetic account section', () => {
    const vm = buildSubscriptionStatusViewModel(
      makeStatus({
        individual,
        team,
      }),
      [],
    );
    expect(vm.fields).toEqual([]);
    expect(vm.sections.find((section) => section.id === 'account')).toBeUndefined();
    const individualFields = vm.sections.find(
      (section) => section.id === 'tokenplan-individual',
    )?.fields;
    expect(individualFields).toContainEqual({
      label: 'Period',
      value: '2026-07-27 → 2026-09-27 (12 days remaining)',
    });
    expect(individualFields).not.toContainEqual(
      expect.objectContaining({ label: 'Remaining Days' }),
    );
    expect(individualFields).not.toContainEqual(expect.objectContaining({ label: 'Renewable' }));
    expect(vm.sections.find((section) => section.id === 'tokenplan-team')?.fields).toEqual([
      { label: 'Status', value: 'not_subscribed' },
      { label: 'Name', value: 'Token Plan Team Edition' },
    ]);

    const activeVm = buildSubscriptionStatusViewModel(
      makeStatus({
        team: {
          ...team,
          status: 'active',
          period: {
            start: '2026-07-27T11:00:00.000Z',
            end: '2026-09-27T11:00:00.000Z',
            remainingDays: 12,
          },
          remainingDays: 12,
          autoRenew: { enabled: false, period: null, periodUnit: null },
        },
      }),
      [],
    );
    expect(
      activeVm.sections.find((section) => section.id === 'tokenplan-team')?.fields,
    ).toContainEqual({ label: 'Renewable', value: 'Yes' });
  });

  it('shows a stable Individual product name when no subscription exists', () => {
    const notSubscribedIndividual = {
      ...individual,
      status: 'not_subscribed' as const,
      type: null,
      name: null,
      specCode: null,
      period: null,
      remainingDays: null,
      autoRenew: null,
      weeklyCredits: undefined,
    };

    const aggregate = buildSubscriptionStatusViewModel(
      makeStatus({ individual: notSubscribedIndividual, team: undefined }),
      [],
    );
    expect(
      aggregate.sections.find((section) => section.id === 'tokenplan-individual')?.fields,
    ).toEqual([
      { label: 'Status', value: 'not_subscribed' },
      { label: 'Name', value: 'Token Plan Individual Edition' },
    ]);

    const tokenPlan = buildTokenPlanStatusViewModel(
      {
        product: 'Token Plan Team Edition',
        individual: notSubscribedIndividual,
        period: null,
        autoRenew: null,
        renewable: null,
        seatSummary: null,
        diagnostics: [],
      },
      'text',
    );
    expect(tokenPlan.editionSections[0]?.fields).toEqual([
      { label: 'Status', value: 'not_subscribed' },
      { label: 'Name', value: 'Token Plan Individual Edition' },
    ]);
  });

  it('renders server-reported weekly usage without inventing absolute Credits', () => {
    const vm = buildSubscriptionStatusViewModel(
      makeStatus({
        individual: {
          ...individual,
          weeklyCredits: {
            total: 2500,
            used: null,
            remaining: null,
            usedPct: 37.5,
            resetTime: '2026-09-19T06:52:00.000Z',
          },
        },
      }),
      [],
    );

    expect(
      vm.sections
        .find((section) => section.id === 'tokenplan-individual')
        ?.fields.find((field) => field.label === 'Weekly Credits')?.value,
    ).toBe('2500 total; 37.5% used (62.5% remaining); resets 2026-09-19 14:52:00');
    const fields = vm.sections.find((section) => section.id === 'tokenplan-individual')?.fields;
    expect(fields).not.toContainEqual(expect.objectContaining({ label: '5-Hour Credits' }));
  });

  it('omits personal credit windows when the usage API has no cycle data', () => {
    const { weeklyCredits: _weeklyCredits, ...withoutUsage } = individual;
    const vm = buildSubscriptionStatusViewModel(makeStatus({ individual: withoutUsage }), []);
    const fields = vm.sections.find((section) => section.id === 'tokenplan-individual')?.fields;

    expect(fields).not.toContainEqual(expect.objectContaining({ label: 'Weekly Credits' }));
    expect(fields).not.toContainEqual(expect.objectContaining({ label: 'Monthly Credits' }));
    expect(fields).not.toContainEqual(expect.objectContaining({ label: '5-Hour Credits' }));
    expect(fields).not.toContainEqual(expect.objectContaining({ label: 'Billing Cycle' }));
  });

  it('renders a seven-day percentage without an unknown total when quota config is absent', () => {
    const vm = buildSubscriptionStatusViewModel(
      makeStatus({
        individual: {
          ...individual,
          weeklyCredits: {
            total: null,
            used: null,
            remaining: null,
            usedPct: 37.5,
            resetTime: '2026-09-19T06:52:00.000Z',
          },
        },
      }),
      [],
    );
    const weekly = vm.sections
      .find((section) => section.id === 'tokenplan-individual')
      ?.fields.find((field) => field.label === 'Weekly Credits')?.value;

    expect(weekly).toBe('37.5% used (62.5% remaining); resets 2026-09-19 14:52:00');
    expect(weekly).not.toContain('unknown');
  });

  it.each(['UTC', 'Asia/Shanghai', 'America/Los_Angeles'])(
    'renders monthly reset time in UTC+8 without a suffix when the host timezone is %s',
    (timezone) => {
      vi.stubEnv('TZ', timezone);
      const { weeklyCredits: _weeklyCredits, ...withoutWeekly } = individual;
      const monthlyIndividual = {
        ...withoutWeekly,
        monthlyCredits: {
          total: 11500,
          used: null,
          remaining: null,
          usedPct: 14.38,
          resetTime: '2026-09-29T16:00:00.000Z',
        },
      };
      const vm = buildSubscriptionStatusViewModel(
        makeStatus({ individual: monthlyIndividual }),
        [],
      );
      const fields = vm.sections.find((section) => section.id === 'tokenplan-individual')?.fields;

      expect(fields?.find((field) => field.label === 'Monthly Credits')?.value).toBe(
        '11500 total; 14.38% used (85.62% remaining); resets 2026-09-30 00:00:00',
      );
      expect(fields).not.toContainEqual(expect.objectContaining({ label: 'Weekly Credits' }));

      // Both status commands share the edition-section formatter.
      const tokenPlan = buildTokenPlanStatusViewModel(
        {
          product: 'Token Plan Individual Edition',
          individual: monthlyIndividual,
          period: null,
          autoRenew: null,
          renewable: null,
          seatSummary: null,
          diagnostics: [],
        },
        'text',
      );
      expect(
        tokenPlan.editionSections[0]?.fields.find((field) => field.label === 'Monthly Credits')
          ?.value,
      ).toBe('11500 total; 14.38% used (85.62% remaining); resets 2026-09-30 00:00:00');
      expect(tokenPlan.individual?.monthlyCredits?.resetTime).toBe('2026-09-29T16:00:00.000Z');
    },
  );

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
    expect(vm.footnote).toContain('1 diagnostic');
    expect(vm.notice).toBe(vm.footnote);
    expect(vm.diagnostics).toEqual([
      {
        api: 'GetSubscription',
        errorCode: 'RPC_TIMEOUT',
        errorMessage: 'request timed out',
      },
    ]);
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
          {
            orderId: 'ord-001',
            orderType: 'purchase',
            orderTime: '2026-04-15T10:00:00Z',
            amount: '199.00',
            status: 'PAID',
          },
          {
            orderId: 'ord-002',
            orderType: 'renew',
            orderTime: '2026-04-20T08:30:00Z',
            amount: '99.00',
            status: 'UNPAID',
          },
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

describe('Token Plan human-readable diagnostics', () => {
  const diagnostic: SubscriptionDiagnostic = {
    api: 'internal/tokenplan/api/path',
    errorCode: 'PROTOCOL_ERROR',
    errorMessage: 'The response could not be verified. Try again later.',
  };

  it('omits API paths and protocol codes from status warnings', () => {
    const vm = buildTokenPlanStatusViewModel(
      {
        product: 'Token Plan Team Edition',
        period: null,
        autoRenew: null,
        renewable: null,
        seatSummary: null,
        diagnostics: [diagnostic],
      },
      'text',
    );

    expect(vm.warnings).toEqual(['⚠ The response could not be verified. Try again later.']);
  });

  it('omits API paths and protocol codes from seat warnings', () => {
    const vm = buildTokenPlanSeatsViewModel(
      {
        page: { current: 1, size: 20, total: 0 },
        filter: { specType: null },
        items: [],
        diagnostics: [diagnostic],
      },
      'text',
    );

    expect(vm.warnings).toEqual(['⚠ The response could not be verified. Try again later.']);
  });
});

describe('Token Plan status date display', () => {
  it('uses the China-site calendar date instead of truncating the UTC date', () => {
    const vm = buildTokenPlanStatusViewModel(
      {
        product: 'Token Plan Individual',
        period: null,
        autoRenew: null,
        renewable: null,
        seatSummary: null,
        diagnostics: [],
        individual: {
          ...individual,
          period: {
            start: '2026-09-15T07:53:25.000Z',
            end: '2026-10-15T16:00:00.000Z',
            remainingDays: 28,
          },
          remainingDays: 28,
        },
      },
      'text',
    );

    expect(vm.editionSections[0]?.fields.find((field) => field.label === 'Period')?.value).toBe(
      '2026-09-15 → 2026-10-16 (28 days remaining)',
    );
  });
});
