import { describe, it, expect } from 'vitest';
import { buildForumSummaryListViewModel } from '../../../src/view-models/yunqi/forum-summaries.js';
import type { ForumSummary } from '../../../src/types/yunqi.js';

const make = (overrides: Partial<ForumSummary> = {}): ForumSummary => ({
  forumId: 'F-1001',
  summary: '主论坛摘要',
  ...overrides,
});

describe('buildForumSummaryListViewModel', () => {
  it('maps each summary into a row', () => {
    const vm = buildForumSummaryListViewModel([make()]);
    expect(vm.rows[0]).toEqual({ forumId: 'F-1001', summary: '主论坛摘要' });
    expect(vm.total).toBe(1);
  });

  it('substitutes a dash for empty fields', () => {
    const vm = buildForumSummaryListViewModel([make({ forumId: '', summary: '' })]);
    expect(vm.rows[0]).toEqual({ forumId: '-', summary: '-' });
  });

  it('derives total from the array length', () => {
    const vm = buildForumSummaryListViewModel([make(), make({ forumId: 'F-1002' })]);
    expect(vm.total).toBe(2);
  });

  it('returns no rows for an empty list', () => {
    const vm = buildForumSummaryListViewModel([]);
    expect(vm.rows).toEqual([]);
    expect(vm.total).toBe(0);
  });
});
