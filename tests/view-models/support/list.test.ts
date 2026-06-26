import { describe, it, expect } from 'vitest';
import { buildSupportListViewModel } from '../../../src/view-models/support/list.js';
import type { SupportTicket } from '../../../src/types/support.js';

describe('buildSupportListViewModel', () => {
  it('maps tickets to formatted rows with status mapping and time formatting', () => {
    const ts = new Date(2026, 0, 15, 10, 30).getTime();
    const tickets: SupportTicket[] = [
      { id: 't-1', title: 'Cannot log in', status: 'wait_assign', createdAt: ts },
      { id: 't-2', title: 'Slow API', status: 'dealing', createdAt: ts + 60_000 },
    ];
    const vm = buildSupportListViewModel(tickets, 1, 10, 2);
    expect(vm.available).toBe(true);
    expect(vm.isEmpty).toBe(false);
    expect(vm.rows).toHaveLength(2);
    expect(vm.rows[0]).toEqual({
      id: 't-1',
      title: 'Cannot log in',
      status: 'Pending assignment',
      createdAt: '2026-01-15 10:30',
    });
    expect(vm.rows[1].status).toBe('Processing');
    expect(vm.rows[1].createdAt).toBe('2026-01-15 10:31');
    // tickets alias mirrors rows
    expect(vm.tickets).toBe(vm.rows);
  });

  it('returns isEmpty=true with totalPages=0 when total is zero', () => {
    const vm = buildSupportListViewModel([], 1, 10, 0);
    expect(vm.isEmpty).toBe(true);
    expect(vm.rows).toEqual([]);
    expect(vm.totalPages).toBe(0);
    expect(vm.emptyMessage).toMatch(/No support tickets yet/);
    // emptyMessage embeds formatCmd output ("support create" or "<cli> support create")
    expect(vm.emptyMessage).toMatch(/support create/);
  });

  it('returns isEmpty=true with computed totalPages when ticket array empty but total>0', () => {
    // Edge: paged-past-last-page (current page has no items but total exists)
    const vm = buildSupportListViewModel([], 5, 10, 25);
    expect(vm.isEmpty).toBe(true);
    expect(vm.totalPages).toBe(3);
  });

  it('truncates long titles with ellipsis at default maxWidth=36', () => {
    const longTitle = 'A'.repeat(60);
    const vm = buildSupportListViewModel(
      [{ id: 't', title: longTitle, status: 'dealing', createdAt: 0 }],
      1,
      10,
      1,
    );
    expect(vm.rows[0].title.endsWith('\u2026')).toBe(true);
    expect(vm.rows[0].title.length).toBeLessThanOrEqual(36);
  });

  it('replaces empty title with em-dash', () => {
    const vm = buildSupportListViewModel(
      [{ id: 't', title: '', status: 'dealing', createdAt: 1_700_000_000_000 }],
      1,
      10,
      1,
    );
    expect(vm.rows[0].title).toBe('—');
  });

  it('falls back to capitalised raw status when not in mapping', () => {
    const vm = buildSupportListViewModel(
      [{ id: 't', title: 'x', status: 'unknown_state', createdAt: 1_700_000_000_000 }],
      1,
      10,
      1,
    );
    expect(vm.rows[0].status).toBe('Unknown state');
  });

  it('emits "Unknown" status for empty raw status', () => {
    const vm = buildSupportListViewModel(
      [{ id: 't', title: 'x', status: '', createdAt: 1_700_000_000_000 }],
      1,
      10,
      1,
    );
    expect(vm.rows[0].status).toBe('Unknown');
  });

  it('emits em-dash for invalid timestamps', () => {
    const vm = buildSupportListViewModel(
      [
        { id: 'a', title: 'x', status: 'dealing', createdAt: -1 },
        { id: 'b', title: 'y', status: 'dealing', createdAt: Number.NaN },
      ],
      1,
      10,
      2,
    );
    expect(vm.rows[0].createdAt).toBe('—');
    expect(vm.rows[1].createdAt).toBe('—');
  });

  it('computes totalPages as ceil(total/pageSize) and falls back to 1 when pageSize=0', () => {
    const vm1 = buildSupportListViewModel(
      [{ id: 't', title: 'x', status: 'dealing', createdAt: 0 }],
      1,
      10,
      25,
    );
    expect(vm1.totalPages).toBe(3);

    const vm2 = buildSupportListViewModel(
      [{ id: 't', title: 'x', status: 'dealing', createdAt: 0 }],
      1,
      0,
      25,
    );
    expect(vm2.totalPages).toBe(1);
  });
});
