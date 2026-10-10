/**
 * Unit tests for buildTokenPlanListViewModel — covers the subscription
 * status → user-facing message mapping across the tri-state contract
 * (active / not_subscribed / unknown) for both editions.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildTokenPlanListViewModel } from '../../../src/view-models/subscription/tokenplan-list.js';
import { tokenPlanListFailureFor } from '../../../src/commands/subscription/tokenplan/list.js';
import { renderTextTokenPlanList } from '../../../src/output/text/tokenplan-list.js';
import type {
  TokenPlanListRow,
  TokenPlanListResult,
  TokenPlanListSection,
} from '../../../src/types/tokenplan-catalog.js';
import type { TokenPlanEdition } from '../../../src/types/tokenplan-subscription.js';

function makeSection(
  edition: TokenPlanEdition,
  overrides: Partial<TokenPlanListSection> = {},
): TokenPlanListSection {
  return {
    edition,
    billingCycleSupported: true,
    subscriptionStatus: 'not_subscribed',
    currentPlan: null,
    currentBillingCycle: null,
    subscriptionUrl: null,
    rows: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<TokenPlanListResult> = {}): TokenPlanListResult {
  return {
    authenticated: true,
    edition: 'all',
    billingCycle: 'monthly',
    completeness: 'complete',
    sections: [makeSection('individual'), makeSection('team')],
    ...overrides,
  };
}

function makeIndividualRow(
  specCode: string,
  weeklyCredits?: number,
  monthlyCredits: string | number | null = null,
): TokenPlanListRow {
  return {
    type: `token_plan_individual_${specCode}`,
    specCode,
    seatType: null,
    name: specCode,
    price: '99',
    currency: 'CNY',
    inventory: true,
    ...(weeklyCredits === undefined ? {} : { weeklyCredits }),
    monthlyCredits,
    status: 'purchasable',
  };
}

describe('buildTokenPlanListViewModel — subscription copy', () => {
  it('marks the default billing cycle without exposing a Team summary type', () => {
    const vm = buildTokenPlanListViewModel(makeResult(), { billingCycleDefaulted: true });

    expect(vm.billingCycleLabel).toBe('monthly (default)');
    expect(vm.sections.find((section) => section.edition === 'team')?.type).toBeNull();
  });

  it('uses the PRD error block for an unsupported Team billing cycle', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        billingCycle: 'quarterly',
        sections: [makeSection('team', { billingCycleSupported: false })],
      }),
    );

    expect(vm.sections[0]?.cycleNote).toBe(
      "Error: billing cycle 'quarterly' is not available for Team Token Plans.\n" +
        'Available billing cycles:\n' +
        '  monthly\n' +
        '  yearly',
    );
  });

  it('renders "No active Individual Token Plan subscription." when authenticated and not_subscribed', () => {
    const vm = buildTokenPlanListViewModel(makeResult());
    const individual = vm.sections.find((section) => section.edition === 'individual');
    expect(individual?.subscription).toBe('No active Individual Token Plan subscription.');
  });

  it('renders "No active Team Token Plan subscription." for the team edition when not_subscribed', () => {
    const vm = buildTokenPlanListViewModel(makeResult());
    const team = vm.sections.find((section) => section.edition === 'team');
    expect(team?.subscription).toBe('No active Team Token Plan subscription.');
    const teamOnly = buildTokenPlanListViewModel(
      makeResult({
        edition: 'team',
        billingCycle: 'yearly',
        sections: [makeSection('team')],
      }),
    );
    expect(teamOnly.note).toContain('--edition team --billing-cycle monthly');
    expect(teamOnly.note).not.toContain('quarterly');
  });

  it('renders the already-subscribed copy when subscriptionStatus is active', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'active',
            currentPlan: 'essential',
            subscriptionUrl: 'https://platform.qianwenai.com/home/analytics/token-plan/individual',
          }),
          makeSection('team', { subscriptionStatus: 'not_subscribed' }),
        ],
      }),
    );
    const individual = vm.sections.find((section) => section.edition === 'individual');
    expect(individual?.subscription).toBe(
      "You're already subscribed to an Individual Token Plan. Current plan: Essential",
    );
    expect(individual?.subscriptionDetails).toEqual([
      'View subscription: https://platform.qianwenai.com/home/analytics/token-plan/individual',
    ]);
  });

  it('uses the acceptance status labels for Individual plans while preserving JSON states', () => {
    const rows: TokenPlanListRow[] = [
      { ...makeIndividualRow('lite', 2500), status: 'unavailable' },
      { ...makeIndividualRow('essential', 5000), status: 'subscribed' },
      { ...makeIndividualRow('standard', 10000), status: 'upgrade' },
      { ...makeIndividualRow('pro', 40000), status: 'upgrade' },
    ];
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'active',
            currentPlan: 'essential',
            currentBillingCycle: 'monthly',
            rows,
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['Lite', 'not_subscribable'],
      ['Essential', 'current_plan'],
      ['Standard', 'upgrade_on_web'],
      ['Pro', 'upgrade_on_web'],
    ]);
    expect(vm.data.sections[0]?.rows).toEqual(rows);
    expect(vm.sections[0]?.diagnostics).toEqual([]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderTextTokenPlanList(vm);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('not_subscribable');
      expect(output).toContain('current_plan');
      expect(output).toContain('upgrade_on_web');
    } finally {
      log.mockRestore();
    }
  });

  it('does not report a service outage or reinterpret eligibility when browsing another billing cycle', () => {
    const rows: TokenPlanListRow[] = ['lite', 'essential', 'standard', 'pro'].map((specCode) => ({
      ...makeIndividualRow(specCode, 2500),
      status: 'unavailable',
    }));
    const vm = buildTokenPlanListViewModel(
      makeResult({
        billingCycle: 'yearly',
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'active',
            currentPlan: 'essential',
            currentBillingCycle: 'monthly',
            rows,
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.subscription).toContain('Current plan: Essential (monthly)');
    expect(vm.sections[0]?.rows.map((row) => row.status)).toEqual([
      'not_subscribable',
      'not_subscribable',
      'not_subscribable',
      'not_subscribable',
    ]);
    expect(vm.sections[0]?.diagnostics).toEqual([]);
    expect(vm.data.sections[0]?.rows).toEqual(rows);
  });

  it('renders the team subscription as an edition-level state', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        edition: 'team',
        sections: [
          makeSection('team', {
            subscriptionStatus: 'active',
            subscriptionUrl: 'https://platform.qianwenai.com/home/analytics/token-plan/team',
            rows: [
              {
                type: 'token_plan_team',
                specCode: 'standard',
                seatType: 'standard',
                name: 'Standard Seat',
                price: '150',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '25000',
                status: 'subscribed',
              },
              {
                type: 'token_plan_team',
                specCode: 'pro',
                seatType: 'pro',
                name: 'Pro Seat',
                price: '550',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '100000',
                status: 'subscribed',
              },
              {
                type: 'token_plan_team',
                specCode: 'max',
                seatType: 'max',
                name: 'Max Seat',
                price: '1398',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '250000',
                status: 'subscribed',
              },
            ],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.subscription).toBe("You're already subscribed to a Team Token Plan.");
    expect(vm.sections[0]?.columns.map((column) => column.header)).not.toContain('STATUS');
    expect(vm.sections[0]?.rows.every((row) => !Object.hasOwn(row, 'status'))).toBe(true);
    expect(vm.data.sections[0]?.rows.every((row) => !Object.hasOwn(row, 'status'))).toBe(true);
    expect(vm.data.sections[0]?.rows[0]?.type).toBe('token_plan_team');
    expect(vm.sections[0]?.columns.slice(0, 2)).toEqual([
      { key: 'type', header: 'TOKENPLAN TYPE' },
      { key: 'seatType', header: 'SEAT TYPE' },
    ]);
    expect(vm.sections[0]?.rows.map((row) => [row.type, row.seatType, row.name])).toEqual([
      ['token_plan_team', 'standard', 'Standard Seat'],
      ['token_plan_team', 'pro', 'Pro Seat'],
      ['token_plan_team', 'max', 'Max Seat'],
    ]);
    expect(vm.data.sections[0]?.rows.map((row) => [row.seatType, row.name])).toEqual([
      ['standard', 'Standard Seat'],
      ['pro', 'Pro Seat'],
      ['max', 'Max Seat'],
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderTextTokenPlanList(vm);
      const output = log.mock.calls.flat().join('\n');
      expect(output).not.toContain('TYPE  token_plan_team');
      expect(output).toMatch(/TOKENPLAN TYPE\s+SEAT TYPE\s+NAME/);
      expect(output).toMatch(/token_plan_team\s+standard\s+Standard Seat/);
      expect(output).toMatch(/token_plan_team\s+pro\s+Pro Seat/);
      expect(output).toMatch(/token_plan_team\s+max\s+Max Seat/);
      expect(output).not.toContain('STATUS');
      expect(output).toContain('Pro Seat');
      expect(output).toContain('Max Seat');
    } finally {
      log.mockRestore();
    }
  });

  it('renders "Subscription status: unknown" only for a genuine unknown state', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', { subscriptionStatus: 'unknown' }),
          makeSection('team', { subscriptionStatus: 'not_subscribed' }),
        ],
      }),
    );
    const individual = vm.sections.find((section) => section.edition === 'individual');
    expect(individual?.subscription).toBe('Subscription status: unknown');
  });

  it('emits no subscription copy when the user is not authenticated', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        authenticated: false,
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'not_subscribed',
            rows: [makeIndividualRow('lite', 2500)],
          }),
          makeSection('team', {
            subscriptionStatus: 'not_subscribed',
            rows: [
              {
                type: 'token_plan_team',
                specCode: 'standard',
                seatType: 'standard',
                name: 'Standard Seat',
                price: '150',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '25000',
                status: 'purchasable',
              },
            ],
          }),
        ],
      }),
    );
    expect(vm.sections[0]?.subscription).toBeNull();
    expect(vm.sections[0]?.columns[0]).toEqual({ key: 'type', header: 'TOKENPLAN TYPE' });
    expect(vm.sections[0]?.columns.some((column) => column.key === 'seatType')).toBe(false);
    expect(vm.sections[0]?.rows[0]?.type).toBe('token_plan_individual_lite');
    expect(vm.sections[0]?.rows[0]?.status).toBe('purchasable');
    expect(vm.sections[1]?.columns.slice(0, 2)).toEqual([
      { key: 'type', header: 'TOKENPLAN TYPE' },
      { key: 'seatType', header: 'SEAT TYPE' },
    ]);
    expect(vm.sections[1]?.rows[0]).toMatchObject({
      type: 'token_plan_team',
      seatType: 'standard',
    });
    expect(vm.note).toContain('You can view Token Plan prices without logging in.');
    expect(vm.note).toContain(
      'Log in to also view your subscription status and account-specific availability.',
    );
    expect(vm.note).toContain(
      'Availability shown here is for reference. Your eligibility will be verified again before purchase.',
    );
    expect(vm.note).not.toContain('Credits limits');
    expect(vm.note).toContain('    --billing-cycle <cycle> \\');
    expect(vm.note).toContain('    --channel <channel> \\');
    expect(vm.note).toContain('    (--auto-renew | --no-auto-renew) \\\n    [options]');
    expect(vm.note).toContain(
      "Run 'qianwen subscription tokenplan purchase --help' for available values and options.",
    );
    expect(vm.sections.find((section) => section.edition === 'individual')?.columns).toContainEqual(
      {
        key: 'weekly',
        header: 'WEEKLY CREDITS',
      },
    );
    expect(vm.sections.find((section) => section.edition === 'individual')?.rows[0]?.weekly).toBe(
      '2,500 Credits',
    );
    expect(vm.sections.find((section) => section.edition === 'team')?.columns).toContainEqual({
      key: 'monthly',
      header: 'MONTHLY CREDITS',
    });
    expect(vm.sections.find((section) => section.edition === 'team')?.rows[0]?.monthly).toBe(
      '25,000 Credits/seat',
    );
  });

  it('shows only the seven-day column when every personal tier reports a limit', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [
              makeIndividualRow('lite', 2500),
              makeIndividualRow('standard', 5000),
              makeIndividualRow('pro', 10000),
            ],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.columns.map((column) => column.header)).toContain('WEEKLY CREDITS');
    expect(vm.sections[0]?.columns.map((column) => column.header)).not.toContain('5-HOUR CREDITS');
  });

  it('omits the seven-day column instead of rendering unknown when quota data is incomplete', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [makeIndividualRow('lite', 2500), makeIndividualRow('standard')],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.columns.map((column) => column.header)).not.toContain('WEEKLY CREDITS');
    for (const row of vm.sections[0]?.rows ?? []) {
      expect(row).not.toHaveProperty('weekly');
      expect(row).not.toHaveProperty('fiveHour');
    }
  });

  it('shows the MONTHLY CREDITS column when personal tiers report monthly but no weekly', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [
              makeIndividualRow('lite', undefined, '11500'),
              makeIndividualRow('essential', undefined, '25500'),
              makeIndividualRow('standard', undefined, '45000'),
              makeIndividualRow('pro', undefined, '180000'),
            ],
          }),
        ],
      }),
    );

    const headers = vm.sections[0]?.columns.map((column) => column.header) ?? [];
    expect(headers).toContain('MONTHLY CREDITS');
    expect(headers).not.toContain('WEEKLY CREDITS');
    // Individual monthly credits carry no per-seat suffix.
    expect(vm.sections[0]?.rows.map((row) => row.monthly)).toEqual([
      '11,500 Credits',
      '25,500 Credits',
      '45,000 Credits',
      '180,000 Credits',
    ]);
    expect(vm.sections[0]?.diagnostics).toEqual([]);
  });

  it('prefers the WEEKLY CREDITS column when both weekly and monthly are present', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [
              makeIndividualRow('lite', 2500, '11500'),
              makeIndividualRow('standard', 5000, '45000'),
            ],
          }),
        ],
      }),
    );

    const headers = vm.sections[0]?.columns.map((column) => column.header) ?? [];
    expect(headers).toContain('WEEKLY CREDITS');
    expect(headers).not.toContain('MONTHLY CREDITS');
    expect(vm.sections[0]?.rows.map((row) => row.weekly)).toEqual([
      '2,500 Credits',
      '5,000 Credits',
    ]);
  });

  it('flags a personal row that reports neither a weekly nor a monthly limit', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [makeIndividualRow('lite', undefined, '11500'), makeIndividualRow('standard')],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([
      'Standard credit limit is temporarily unavailable. Try again later.',
    ]);
  });

  it('does not surface a generic network error when visible catalog data is complete', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [
              makeIndividualRow('lite', 2500),
              makeIndividualRow('standard', 10000),
              makeIndividualRow('pro', 40000),
            ],
            diagnostics: [
              {
                api: 'internal/api/path',
                errorCode: 'NETWORK_ERROR',
                errorMessage: 'The service could not be reached. Check your network connection.',
              },
            ],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([]);
    expect(vm.data.sections[0]?.diagnostics).toEqual([
      {
        api: 'internal/api/path',
        errorCode: 'NETWORK_ERROR',
        errorMessage: 'The service could not be reached. Check your network connection.',
      },
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderTextTokenPlanList(vm);
      expect(log).not.toHaveBeenCalledWith(
        'The service could not be reached. Check your network connection.',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('uses a row-level degradation message for unavailable catalog fields', () => {
    const row = makeIndividualRow('pro', 10000);
    row.inventory = null;
    row.status = 'unknown';
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [row],
            diagnostics: [
              {
                api: 'CheckInventory/pro',
                errorCode: 'NETWORK_ERROR',
                errorMessage: 'The service could not be reached. Check your network connection.',
              },
            ],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([
      'Pro availability is temporarily unavailable. Try again later.',
    ]);
    expect(vm.sections[0]?.diagnostics.join(' ')).not.toContain('network');
    expect(vm.sections[0]?.rows[0]?.status).toBe('unknown');
    expect(vm.data.sections[0]?.rows[0]?.status).toBe('unknown');
  });

  it('adds a retry hint when a catalog is empty', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [makeSection('individual')],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([
      'Individual Token Plan catalog is temporarily unavailable. Try again later.',
    ]);
  });
});

describe('tokenPlanListFailureFor', () => {
  it('preserves protocol failures as configuration-class exit 4', () => {
    const error = tokenPlanListFailureFor(new Set(['PROTOCOL_ERROR']));
    expect(error.code).toBe('PROTOCOL_ERROR');
    expect(error.exitCode).toBe(4);
  });
});
