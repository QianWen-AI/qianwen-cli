import { describe, expect, it } from 'vitest';
import { buildTokenPlanStatusViewModel } from '../../../src/view-models/subscription/tokenplan-status.js';
import {
  buildTokenPlanStatusDetails,
  tokenPlanDisplayDate,
} from '../../../src/view-models/subscription/tokenplan-details.js';
import { formatSubscriptionStatusJson } from '../../../src/view-models/subscription/shared.js';
import {
  teamWithSeatDetails,
  tokenPlanStatusWithDetails,
  tokenPlanStatusWithoutSubscriptions,
} from '../../helpers/tokenplan-status.js';
import type {
  TokenPlanEditionStatus,
  TokenPlanStatusResult,
} from '../../../src/types/tokenplan-subscription.js';

function individual(): TokenPlanEditionStatus {
  return {
    edition: 'individual',
    commodityCode: 'sfm_tokenplansolo_public_cn',
    status: 'active',
    type: 'token_plan_individual_lite',
    name: 'Lite',
    specCode: 'lite',
    period: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
      remainingDays: 10,
    },
    remainingDays: 10,
    autoRenew: { enabled: true, period: 1, periodUnit: 'Month' },
    seatSummary: null,
    completeness: 'complete',
    diagnostics: [],
    monthlyCredits: { total: 1000, used: null, remaining: null, usedPct: 50, resetTime: null },
  };
}
function result(edition?: TokenPlanEditionStatus): TokenPlanStatusResult {
  return {
    ...(edition ? { [edition.edition]: edition } : {}),
    product: 'Token Plan',
    period: null,
    autoRenew: null,
    renewable: null,
    seatSummary: null,
    diagnostics: [],
  };
}

describe('S02 dedicated display and additive JSON compatibility', () => {
  it('orders team credit summaries and legacy rows as Standard, Pro, Max without changing JSON', () => {
    const source = tokenPlanStatusWithDetails();
    const group = source.team!.seatSummary!.groups[0]!;
    source.team!.seatSummary!.groups = ['max', 'standard', 'pro'].map((specType) => ({
      ...group,
      specType,
    }));
    source.seatSummary = source.team!.seatSummary;
    const summary = source.team!.seatSummaries![0]!;
    source.team!.seatSummaries = (['max', 'standard', 'pro'] as const).map((seatType) => ({
      ...summary,
      seatType,
    }));
    const before = structuredClone(source);
    const vm = buildTokenPlanStatusViewModel(source, 'tui');
    expect(
      vm.detailTables
        ?.find((table) => table.title === 'TEAM CREDIT SUMMARY')
        ?.rows.map((row) => row[0]),
    ).toEqual(['standard', 'pro', 'max']);
    expect(vm.seatLines?.map((row) => row.specType)).toEqual(['Standard', 'Pro', 'Max']);
    expect(vm.table?.rows.map((row) => row.specType)).toEqual(['Standard', 'Pro', 'Max']);
    expect(buildTokenPlanStatusViewModel(source, 'json').team).toEqual(before.team);
    expect(source).toEqual(before);
  });
  it('hides unsubscribed credit and historical seat displays without changing JSON data', () => {
    const source = tokenPlanStatusWithoutSubscriptions();
    const before = structuredClone(source);
    const vm = buildTokenPlanStatusViewModel(source, 'tui');
    expect(vm.detailTables).toEqual([]);
    for (const section of vm.editionSections) {
      expect(section.detailTables).toEqual([]);
      expect(section.seatLines).toBeUndefined();
      expect(section.seatDetails).toBeUndefined();
      expect(section.fields.some((field) => field.label === 'Subscription')).toBe(true);
    }
    expect(vm.team?.seatDetails?.historicalCount).toBe(8);
    expect(source).toEqual(before);
    const json = buildTokenPlanStatusViewModel(source, 'json');
    expect(json).not.toHaveProperty('purchaseHints');
    expect(json.individual).toEqual(source.individual);
    expect(json.team).toEqual(source.team);
  });

  it.each([
    { individual: 'not_subscribed', team: 'not_subscribed', expected: ['individual', 'team'] },
    { individual: 'not_subscribed', team: 'active', expected: ['individual'] },
    { individual: 'active', team: 'not_subscribed', expected: ['team'] },
    { individual: 'not_subscribed', team: 'unknown', expected: ['individual'] },
    { individual: 'unknown', team: 'not_subscribed', expected: ['team'] },
    { individual: 'not_subscribed', team: undefined, expected: ['individual'] },
    { individual: undefined, team: 'not_subscribed', expected: ['team'] },
    { individual: 'active', team: 'active', expected: [] },
    { individual: 'unknown', team: 'unknown', expected: [] },
  ] as const)('guides only unsubscribed editions for $individual / $team', (states) => {
    const source = tokenPlanStatusWithoutSubscriptions();
    for (const edition of ['individual', 'team'] as const) {
      if (states[edition] === undefined) Reflect.deleteProperty(source, edition);
      else source[edition]!.status = states[edition];
    }
    const before = structuredClone(source);
    for (const format of ['tui', 'text', 'json'] as const) {
      const vm = buildTokenPlanStatusViewModel(source, format);
      const hintedSections = vm.editionSections.filter((section) => section.purchaseHint);
      const hintedEditions = hintedSections.map((section) => section.edition);
      expect(hintedEditions).toEqual(format === 'json' ? [] : states.expected);
      for (const section of hintedSections) {
        const hint = section.purchaseHint!;
        expect(hint).toContain(section.edition === 'individual' ? 'an Individual' : 'a Team');
        expect(hint).toContain(
          section.edition === 'individual' ? '<individual-token-plan-type>' : 'token_plan_team',
        );
        expect(hint).toContain('--billing-cycle <cycle> --');
        expect(hint).toContain('--no-auto-renew');
        if (section.edition === 'team') expect(hint).toContain('--standard-seat-count <n>');
        expect(hint).not.toContain('<token-plan-type>');
        expect(hint).not.toContain('\\\n');
      }
      expect(vm).not.toHaveProperty('purchaseHints');
      expect(vm.individual).toEqual(source.individual);
      expect(vm.team).toEqual(source.team);
    }
    expect(source).toEqual(before);
  });

  it('groups credit details by edition and directs per-seat details to the seats command', () => {
    const source = tokenPlanStatusWithDetails();
    const before = structuredClone(source);
    const vm = buildTokenPlanStatusViewModel(source, 'tui');
    expect(vm.editionSections[0]!.detailTables?.map((table) => table.title)).toEqual([
      'INDIVIDUAL CREDIT WINDOWS',
      'PERSONAL HARNESS ALLOWANCES',
    ]);
    expect(vm.editionSections[0]!.seatDetails).toBeUndefined();
    expect(vm.editionSections[0]!.seatLines).toBeUndefined();
    expect(vm.editionSections[1]!.detailTables?.map((table) => table.title)).toEqual([
      'TEAM CREDIT SUMMARY',
    ]);
    expect(vm.editionSections[1]!.seatDetails).toBeUndefined();
    expect(vm.editionSections[1]!.seatLines).toBeUndefined();
    expect(
      vm.editionSections.every((section) =>
        section.fields.every((field) => field.label !== 'Name'),
      ),
    ).toBe(true);
    expect(vm.editionSections[1]!.detailTables?.[0]?.note).toBe(
      'The total credits is the sum of the credits of all seats of the same seat type.\nOnly active seats are shown.\nRun qianwen subscription tokenplan seats for per-seat member and quota details.',
    );
    expect(vm.individual).toEqual(source.individual);
    expect(vm.team).toEqual(source.team);
    expect(source).toEqual(before);
  });
  it('preserves every legacy JSON field and omission while adding strict renewal and credit windows', () => {
    const legacy = individual();
    const additions: Partial<TokenPlanEditionStatus> = {
      subscriptionId: 'fixture',
      endAt: '2027-01-01T00:00:00.000Z',
      confirmedAutoRenew: null,
      tiers: [
        {
          tier: 'lite',
          windowType: 'weekly',
          totalCredits: '100',
          remainingCredits: null,
          usedPct: 25,
          remainingPct: 75,
          resetAt: null,
        },
      ],
    };
    const enhanced = { ...legacy, ...additions };
    const before = structuredClone(enhanced);
    const vm = buildTokenPlanStatusViewModel(result(enhanced), 'json');
    const projected = { ...vm.individual };
    for (const key of Object.keys(additions)) Reflect.deleteProperty(projected, key);
    expect(formatSubscriptionStatusJson(projected)).toEqual(formatSubscriptionStatusJson(legacy));
    expect(enhanced).toEqual(before);
    expect(vm.individual?.autoRenew?.enabled).toBe(true);
    expect(vm.editionSections[0]!.fields.find((field) => field.label === 'Auto-Renew')?.value).toBe(
      'unknown',
    );
    expect(formatSubscriptionStatusJson(vm.individual)).not.toHaveProperty(
      'monthlyCredits.remaining',
    );
  });

  it('hides the start time in sections and fallback headers while preserving JSON period.start', () => {
    const data = individual();
    const vm = buildTokenPlanStatusViewModel(result(data), 'text');
    expect(vm.editionSections[0]!.fields.some((field) => field.value.includes('2026-01-01'))).toBe(
      false,
    );
    expect(vm.individual?.period?.start).toBe('2026-01-01T00:00:00.000Z');
    const fallback = buildTokenPlanStatusViewModel({ ...result(), period: data.period }, 'text');
    expect(fallback.header?.period).toContain('2027-01-01');
    expect(fallback.header?.period).not.toContain('2026-01-01');
  });

  it('distinguishes issued zero, empty, pending and failed Harness displays', () => {
    const active = { ...individual(), subscriptionId: 'fixture' };
    const harness = (data: TokenPlanStatusResult) =>
      buildTokenPlanStatusDetails(data).find(
        (table) => table.title === 'PERSONAL HARNESS ALLOWANCES',
      )!;
    expect(harness(result({ ...active, harnessAllowances: [] })).emptyMessage).toBe(
      'No granted Harness allowances found for this account.',
    );
    expect(harness(result(active)).emptyMessage).toContain('unavailable');
    const pending = result({ ...active, harnessAllowances: [], harnessHasResourcePack: true });
    expect(harness(pending).emptyMessage).toBe(
      'Harness benefits are being issued. Please check back later.',
    );
    const failed = {
      ...result({ ...active, harnessHasResourcePack: true }),
      diagnostics: [
        {
          api: 'HarnessAllowances',
          errorCode: 'TOKENPLAN_HARNESS_PENDING',
          errorMessage: 'fixture',
        },
      ],
    };
    expect(harness(failed).emptyMessage).toContain('unavailable');
    expect(
      harness(
        result({
          ...active,
          harnessHasResourcePack: true,
          harnessAllowances: [
            {
              toolId: 'tool',
              toolName: 'Tool',
              totalQuota: '0',
              remainingQuota: '0',
              quotaUnit: 'Credits',
              startAt: null,
              endAt: null,
            },
          ],
        }),
      ).rows,
    ).toEqual([['Tool', '0', '0', 'Credits', '0%']]);
  });

  it.each([true, false])('keeps the Harness catalog flag %s out of status JSON', (flag) => {
    const original = { ...individual(), subscriptionId: 'fixture', harnessAllowances: [] };
    const value = { ...original, harnessHasResourcePack: flag };
    const before = structuredClone(value);
    expect(formatSubscriptionStatusJson(value)).toEqual(formatSubscriptionStatusJson(original));
    expect(value).toEqual(before);
  });

  it.each([
    ['100', '90', '90%'],
    ['100', '100', '100%'],
    ['100', '0', '0%'],
    ['3', '1', '33.3%'],
    ['0.3', '0.2', '66.7%'],
    ['2000', '1234', '61.7%'],
    ['2000', '23', '1.1%'],
    ['0.000000000003', '0.000000000001', '33.3%'],
    ['9007199254740993', '3002399751580331', '33.3%'],
    ['1000000000000000000000000', '10500000000000000000000', '1.1%'],
    ['1000000000000000000000000', '20500000000000000000000', '2%'],
    ['0', '0', '0%'],
    ['0', '1', '0%'],
    ['10', '11', '100%'],
    ['100', '100.000000000001', '100%'],
    [null, '0', '—'],
    ['100', null, '—'],
    ['-1', '0', '—'],
    ['100', '-1', '—'],
    ['', '0', '—'],
    ['100', 'invalid', '—'],
    ['NaN', '0', '—'],
    ['100', 'Infinity', '—'],
  ])(
    'uses the Harness frontend ratio and preserves unknown values for %s total and %s remaining',
    (totalQuota, remainingQuota, expected) => {
      const source = tokenPlanStatusWithDetails();
      const tool = source.individual!.harnessAllowances![0]!;
      tool.totalQuota = totalQuota;
      tool.remainingQuota = remainingQuota;
      const before = structuredClone(source);
      const jsonBefore = formatSubscriptionStatusJson(source.individual);
      const table = buildTokenPlanStatusDetails(source).find(
        (entry) => entry.title === 'PERSONAL HARNESS ALLOWANCES',
      )!;
      expect(table.headers).toEqual([
        'TOOL',
        'TOTAL QUOTA',
        'REMAINING QUOTA',
        'UNIT',
        'REMAINING (%)',
      ]);
      expect(table.rows[0]![4]).toBe(expected);
      expect(table.rows.every((row) => row.length === table.headers.length)).toBe(true);
      expect(source).toEqual(before);
      expect(formatSubscriptionStatusJson(source.individual)).toEqual(jsonBefore);
    },
  );

  it.each(['totalQuota', 'remainingQuota'])(
    'keeps a missing Harness %s unknown without changing the quota columns',
    (field) => {
      const source = tokenPlanStatusWithDetails();
      Reflect.deleteProperty(source.individual!.harnessAllowances![0]!, field);
      const table = buildTokenPlanStatusDetails(source).find(
        (entry) => entry.title === 'PERSONAL HARNESS ALLOWANCES',
      )!;
      expect(table.rows[0]).toEqual([
        '图像生成 MCP',
        field === 'totalQuota' ? '—' : '100',
        field === 'remainingQuota' ? '—' : '90',
        '次',
        '—',
      ]);
    },
  );

  it('renders only personal usage and remaining ratios even when Credits amounts are available', () => {
    const data = {
      ...individual(),
      tiers: [
        {
          tier: 'lite',
          windowType: 'weekly' as const,
          totalCredits: '100',
          remainingCredits: '75',
          usedPct: 25,
          remainingPct: 75,
          resetAt: null,
        },
      ],
    };
    const table = buildTokenPlanStatusDetails(result(data))[0]!;
    expect(table.headers).toContain('USED (%)');
    expect(table.headers).not.toContain('TOTAL CREDITS');
    expect(table.headers).not.toContain('REMAINING CREDITS');
    expect(table.rows[0]).toEqual(['lite', 'weekly', '25%', '75%', '—']);
    expect(
      buildTokenPlanStatusViewModel(result(data), 'text').editionSections[0]!.fields.some(
        (field) => field.label === 'Monthly Credits',
      ),
    ).toBe(false);
  });

  it.each(['individual', 'team'] as const)(
    'hides remaining Credits when all %s rows have null or missing values without changing JSON',
    (edition) => {
      const source = tokenPlanStatusWithDetails();
      if (edition === 'individual') {
        const row = source.individual!.tiers![0]!;
        source.individual!.tiers = [{ ...row, remainingCredits: null }, { ...row }];
      } else {
        const row = source.team!.seatSummaries![0]!;
        source.team!.seatSummaries = [{ ...row, remainingCredits: null }, { ...row }];
      }
      const rows =
        edition === 'individual' ? source.individual!.tiers! : source.team!.seatSummaries!;
      Reflect.deleteProperty(rows[1]!, 'remainingCredits');
      const before = structuredClone(source);
      const jsonBefore = formatSubscriptionStatusJson(source[edition]);
      const table = buildTokenPlanStatusDetails(source).find(
        (entry) => entry.edition === edition && entry.title.includes('CREDIT'),
      )!;
      expect(table.headers).not.toContain('REMAINING CREDITS');
      expect(table.rows.every((row) => row.length === table.headers.length)).toBe(true);
      expect(source).toEqual(before);
      expect(formatSubscriptionStatusJson(source[edition])).toEqual(jsonBefore);
    },
  );

  it.each(['individual', 'team'] as const)(
    'hides personal Credits quantities while retaining actual zero and unknown team Credits in mixed %s rows',
    (edition) => {
      const source = tokenPlanStatusWithDetails();
      const values = ['0', null, null];
      if (edition === 'individual') {
        const row = source.individual!.tiers![0]!;
        source.individual!.tiers = values.map((remainingCredits) => ({
          ...row,
          remainingCredits,
        }));
      } else {
        const row = source.team!.seatSummaries![0]!;
        source.team!.seatSummaries = values.map((remainingCredits) => ({
          ...row,
          remainingCredits,
        }));
      }
      const rows =
        edition === 'individual' ? source.individual!.tiers! : source.team!.seatSummaries!;
      Reflect.deleteProperty(rows[2]!, 'remainingCredits');
      const before = structuredClone(source);
      const jsonBefore = formatSubscriptionStatusJson(source[edition]);
      const table = buildTokenPlanStatusDetails(source).find(
        (entry) => entry.edition === edition && entry.title.includes('CREDIT'),
      )!;
      const index = table.headers.indexOf('REMAINING CREDITS');
      if (edition === 'individual') {
        expect(index).toBe(-1);
        expect(table.headers).not.toContain('TOTAL CREDITS');
        expect(table.rows.map((row) => row.slice(2, 4))).toEqual([
          ['0%', '100%'],
          ['0%', '100%'],
          ['0%', '100%'],
        ]);
      } else {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(table.rows.map((row) => row[index])).toEqual(['0', '—', '—']);
      }
      expect(table.rows.every((row) => row.length === table.headers.length)).toBe(true);
      expect(source).toEqual(before);
      expect(formatSubscriptionStatusJson(source[edition])).toEqual(jsonBefore);
    },
  );

  it.each([null, undefined, '', 'fixture-team-subscription'])(
    'shows only a known Team subscription ID %s without substituting a seat ID or changing JSON',
    (subscriptionId) => {
      const source = tokenPlanStatusWithDetails();
      if (subscriptionId === undefined) Reflect.deleteProperty(source.team!, 'subscriptionId');
      else source.team!.subscriptionId = subscriptionId;
      const before = structuredClone(source);
      for (const format of ['text', 'tui', 'json'] as const) {
        const vm = buildTokenPlanStatusViewModel(source, format);
        const teamSection = vm.editionSections.find((section) => section.edition === 'team')!;
        const individualSection = vm.editionSections.find(
          (section) => section.edition === 'individual',
        )!;
        const field = teamSection.fields.find((field) => field.label === 'Subscription ID');
        if (subscriptionId) expect(field?.value).toBe(subscriptionId);
        else expect(field).toBeUndefined();
        expect(
          individualSection.fields.find((field) => field.label === 'Subscription ID')?.value,
        ).toBe('fixture-personal');
        expect(vm.team?.subscriptionId).toBe(subscriptionId);
        expect(vm.individual?.subscriptionId).toBe('fixture-personal');
        expect(formatSubscriptionStatusJson(vm.team)).toEqual(
          formatSubscriptionStatusJson(source.team),
        );
      }
      expect(source).toEqual(before);
    },
  );

  it('cleans human fields and tolerates invalid dates without mutating legacy JSON', () => {
    const team = {
      ...teamWithSeatDetails(),
      name: '\u001b[31mTeam\u001b[0m\nInjected',
      commodityCode: '\u001b[31mCommodity\u001b[0m\nInjected',
      endAt: 'invalid',
    };
    const vm = buildTokenPlanStatusViewModel(result(team), 'text');
    expect(JSON.stringify(vm.editionSections)).not.toContain('\\u001b');
    expect(vm.editionSections[0]!.fields.find((field) => field.label === 'Name')).toBeUndefined();
    expect(vm.editionSections[0]!.fields.find((field) => field.label === 'Commodity')?.value).toBe(
      'CommodityInjected',
    );
    expect(vm.editionSections[0]!.fields.find((field) => field.label === 'End At')?.value).toBe(
      '—',
    );
    expect(vm.team?.name).toBe(team.name);
    expect(tokenPlanDisplayDate('invalid')).toBe('—');
  });
});
