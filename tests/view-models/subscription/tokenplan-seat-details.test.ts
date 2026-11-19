import { describe, expect, it } from 'vitest';
import {
  buildTokenPlanSeatDetailsViewModel,
  formatTeamSeatAllocation,
  sortTokenPlanSeats,
} from '../../../src/view-models/subscription/tokenplan-seat-details.js';
import { buildTokenPlanStatusViewModel } from '../../../src/view-models/subscription/tokenplan-status.js';
import { buildSubscriptionStatusViewModel } from '../../../src/view-models/subscription/status.js';
import { teamWithSeatDetails } from '../../helpers/tokenplan-status.js';

describe('seat allocation and details presentation', () => {
  it('orders seat types as Standard, Pro, Max while keeping duplicate/unknown order and input intact', () => {
    const source = [
      { id: 'max', type: 'max' },
      { id: 'unknown-a', type: null },
      { id: 'standard-a', type: 'standard' },
      { id: 'pro', type: 'PRO' },
      { id: 'standard-b', type: 'standard' },
      { id: 'unknown-b', type: 'custom' },
    ];
    const before = structuredClone(source);
    expect(sortTokenPlanSeats(source, (seat) => seat.type).map((seat) => seat.id)).toEqual([
      'standard-a',
      'standard-b',
      'pro',
      'max',
      'unknown-a',
      'unknown-b',
    ]);
    expect(source).toEqual(before);
  });

  it('orders both status commands seat details without modifying the backend collection', () => {
    const team = teamWithSeatDetails();
    const standard = team.seatDetails!.items[0]!;
    const max = team.seatDetails!.items[2]!;
    team.seatDetails!.items = [
      max,
      { ...standard, instanceCode: 'pro', specType: 'pro' },
      standard,
    ];
    const before = structuredClone(team);
    for (const variant of ['subscription', 'tokenplan'] as const) {
      const vm = buildTokenPlanSeatDetailsViewModel(team.seatDetails, variant);
      expect(vm?.rows.map((row) => row[1])).toEqual(['Standard', 'Pro', 'Max']);
    }
    expect(team).toEqual(before);
  });
  it('uses current seat summary for allocation even when details contain more historical rows', () => {
    const team = teamWithSeatDetails();
    team.seatDetails!.fetchedCount = team.seatDetails!.totalCount = 4;
    team.seatDetails!.historicalCount = 1;
    const dedicated = buildTokenPlanStatusViewModel(
      {
        team,
        product: 'Token Plan',
        period: null,
        autoRenew: null,
        renewable: null,
        seatSummary: team.seatSummary,
        diagnostics: [],
      },
      'text',
    );
    const general = buildSubscriptionStatusViewModel(
      {
        team,
        isGray: false,
        plan: null,
        period: null,
        quota: null,
        autoRenew: null,
        renewable: null,
        remainingDays: null,
        seatTiers: [],
        creditPacks: [],
        recentOrders: [],
      },
      [],
    );
    expect(dedicated.editionSections[0].fields).toContainEqual({
      label: 'Seats',
      value: '3 total · 2 assigned · 1 unassigned',
    });
    expect(general.sections[0].fields).toContainEqual({
      label: 'Seats',
      value: '3 total · 2 assigned · 1 unassigned',
    });
    expect(general.seatDetails?.rows[0]).toEqual([
      'subs-standard-0123456789abcdef',
      'Standard',
      'Active',
      'Assigned',
      '20,000 / 25,000',
    ]);
    expect(general.seatDetails?.title).toBe('Seat Details');
    expect(general.seatDetails?.headers).toEqual([
      'SEAT ID',
      'TYPE',
      'STATUS',
      'ASSIGNMENT',
      'CREDITS',
    ]);
    expect(dedicated.seatDetails?.rows).toHaveLength(3);
    expect(dedicated.seatDetails?.rows[0]).toEqual([
      'subs-standard-0123456789abcdef',
      'Standard',
      'active',
      'assigned',
      '20,000 / 25,000',
      '80%',
    ]);
    expect(dedicated.seatDetails?.note).toBe('');
    expect(dedicated.seatDetails?.title).toBe('SEAT DETAILS');
    expect(dedicated.seatDetails?.headers).toEqual([
      'SEAT ID',
      'SEAT TYPE',
      'STATUS',
      'ASSIGNMENT',
      'CREDITS (REMAINING / TOTAL)',
      'REMAINING (%)',
    ]);
  });

  it.each([
    ['standard', 'Standard'],
    ['pro', 'Pro'],
    ['max', 'Max'],
    [null, 'unknown'],
  ])('uses current seat names in the dedicated details: %s', (specType, name) => {
    const details = teamWithSeatDetails().seatDetails!;
    details.items[0].specType = specType;
    const vm = buildTokenPlanSeatDetailsViewModel(details, 'tokenplan')!;
    const row = vm.rows.find((row) => row[0] === details.items[0].instanceCode)!;
    expect(row[1]).toBe(name);
    expect(row[2]).toBe('active');
    expect(row[3]).toBe('assigned');
    expect(vm.noteAfterRows).toBe(true);
    expect(vm.note).toBe('');
  });

  it.each([
    ['25000', '25000', '100%'],
    ['25000', '0', '0%'],
    ['3', '1', '33.33%'],
    ['0.3', '0.2', '66.67%'],
    ['0', '0', '—'],
    [null, '0', '—'],
    ['25000', null, '—'],
    ['25000', '25001', '—'],
  ])(
    'shows remaining percentage for %s total and %s remaining',
    (totalValue, surplusValue, pct) => {
      const details = teamWithSeatDetails().seatDetails!;
      details.items[0].totalValue = totalValue;
      details.items[0].surplusValue = surplusValue;
      const before = structuredClone(details);
      expect(buildTokenPlanSeatDetailsViewModel(details, 'tokenplan')!.rows[0][5]).toBe(pct);
      expect(buildTokenPlanSeatDetailsViewModel(details)!.rows[0]).toHaveLength(5);
      expect(details).toEqual(before);
    },
  );

  it('keeps incomplete-query notices and unknown values without a generic field notice', () => {
    const details = teamWithSeatDetails().seatDetails!;
    details.collectionCompleteness = details.completeness = 'partial';
    details.totalCount = 4;
    details.items[0].assignment = 'unknown';
    const vm = buildTokenPlanSeatDetailsViewModel(details, 'tokenplan')!;
    expect(vm.note).toContain('Seat query incomplete: 3 / 4 records retrieved.');
    expect(vm.note).not.toContain('Some seat fields are unknown.');
    expect(vm.rows[0][3]).toBe('unknown');
  });

  it.each(['missing', 'exceeds', 'duplicate', 'mismatch', 'invalid', 'unknown-spec'])(
    'keeps assignment unknown for %s summary evidence',
    (mode) => {
      const summary = teamWithSeatDetails().seatSummary!;
      if (mode === 'missing') summary.groups[0].assigned = null;
      if (mode === 'exceeds') summary.groups[0].assigned = 3;
      if (mode === 'duplicate') summary.groups[1].specType = 'standard';
      if (mode === 'mismatch') summary.total!.seats = 4;
      if (mode === 'invalid') summary.groups[0].seats = 1.5;
      if (mode === 'unknown-spec') summary.groups[0].specType = '';
      expect(formatTeamSeatAllocation(summary)).toContain('unknown assigned · unknown unassigned');
    },
  );

  it('preserves explicit zero counts but does not invent a missing total', () => {
    const summary = teamWithSeatDetails().seatSummary!;
    summary.groups = [];
    summary.total!.seats = 0;
    expect(formatTeamSeatAllocation(summary)).toBe('0 total · 0 assigned · 0 unassigned');
    summary.total = null;
    expect(formatTeamSeatAllocation(summary)).toBe(
      'unknown total · unknown assigned · unknown unassigned',
    );
  });

  it('retains unknown fields, formats exact decimals and removes terminal control characters', () => {
    const details = teamWithSeatDetails().seatDetails!;
    details.items = [
      {
        instanceCode: '\x1b[31msubs\x1b[0m\r\nforged\u202e',
        specType: null,
        status: null,
        assignment: 'unknown',
        surplusValue: null,
        totalValue: '123456789012345678.123400',
      },
    ];
    details.fetchedCount = 1;
    details.totalCount = null;
    details.collectionCompleteness = 'partial';
    details.completeness = 'partial';
    const vm = buildTokenPlanSeatDetailsViewModel(details)!;
    expect(vm.rows).toEqual([
      ['subs  forged ', 'unknown', 'unknown', 'unknown', 'unknown / 123,456,789,012,345,678.1234'],
    ]);
    expect(vm.note).toContain('Seat query incomplete: 1 / unknown records retrieved.');
    expect(vm.note).not.toContain('Some seat fields are unknown.');
  });

  it('distinguishes an unavailable query from a confirmed empty response', () => {
    const details = {
      items: [],
      fetchedCount: 0,
      totalCount: null,
      historicalCount: 0,
      collectionCompleteness: 'unknown' as const,
      diagnostics: [],
      completeness: 'unknown' as const,
    };
    expect(buildTokenPlanSeatDetailsViewModel(details)?.note).toContain('Seat query unavailable');
    expect(
      buildTokenPlanSeatDetailsViewModel({
        ...details,
        totalCount: 0,
        collectionCompleteness: 'complete',
        completeness: 'complete',
      })?.note,
    ).toContain('No current seats.');
  });

  it('does not label fully retrieved records as an incomplete query when only fields are unknown', () => {
    const details = teamWithSeatDetails().seatDetails!;
    details.items[0].assignment = 'unknown';
    details.completeness = 'partial';
    details.historicalCount = 15;
    details.fetchedCount = details.totalCount = 18;
    const vm = buildTokenPlanSeatDetailsViewModel(details)!;
    expect(vm.note).toContain('3 current seats.');
    expect(vm.note).not.toContain('Some seat fields are unknown.');
    expect(vm.note).not.toContain('historical seats hidden');
    expect(vm.note).not.toMatch(/incomplete|unavailable|Try again/);
    expect(vm.rows).toHaveLength(3);
  });

  it('does not display an empty subscription claim after collecting only the first historical page', () => {
    const details = teamWithSeatDetails().seatDetails!;
    details.items = [];
    details.historicalCount = details.fetchedCount = 100;
    details.totalCount = 101;
    details.collectionCompleteness = details.completeness = 'partial';
    const vm = buildTokenPlanSeatDetailsViewModel(details)!;
    expect(vm.note).toContain('Seat query incomplete: 100 / 101 records retrieved.');
    expect(vm.note).not.toContain('No current seats');
    expect(vm.note).not.toContain('Some seat fields');
  });
});
