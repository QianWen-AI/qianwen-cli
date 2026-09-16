import { describe, it, expect } from 'vitest';
import { buildForumSubscriptionListViewModel } from '../../../src/view-models/yunqi/subscriptions.js';
import type { ForumSubscription, ForumSubscriptionListResult } from '../../../src/types/yunqi.js';

const make = (
  overrides: Partial<ForumSubscriptionListResult> = {},
): ForumSubscriptionListResult => ({
  subscriptions: [],
  notStartedCount: 0,
  inProgressCount: 0,
  summaryPreparingCount: 0,
  summaryReadyCount: 0,
  unviewedCount: 0,
  ...overrides,
});

const sub = (overrides: Partial<ForumSubscription> = {}): ForumSubscription => ({
  forumId: 'F-1001',
  forumName: '云栖大会主论坛',
  forumStartTime: '2026-09-10 09:00',
  forumEndTime: '2026-09-10 12:00',
  status: 'not_started',
  statusText: '会议未开始',
  viewed: false,
  ...overrides,
});

describe('buildForumSubscriptionListViewModel', () => {
  it('maps each subscription into a row preserving the server StatusText verbatim', () => {
    const vm = buildForumSubscriptionListViewModel(make({ subscriptions: [sub()] }));
    expect(vm.rows[0]).toEqual({
      forumId: 'F-1001',
      forumName: '云栖大会主论坛',
      startTime: '2026-09-10 09:00',
      endTime: '2026-09-10 12:00',
      statusText: '会议未开始',
      unread: '●',
    });
  });

  it('marks unviewed subscriptions and dashes viewed ones', () => {
    const vm = buildForumSubscriptionListViewModel(
      make({ subscriptions: [sub({ viewed: false }), sub({ viewed: true })] }),
    );
    expect(vm.rows[0].unread).toBe('●');
    expect(vm.rows[1].unread).toBe('-');
  });

  it('后端实际的 20 字符时间戳不被截断', () => {
    const vm = buildForumSubscriptionListViewModel(
      make({
        subscriptions: [
          sub({ forumStartTime: '2026-09-08T05:30:00Z', forumEndTime: '2026-09-08T12:30:00Z' }),
        ],
      }),
    );
    expect(vm.rows[0].startTime).toBe('2026-09-08T05:30:00Z');
    expect(vm.rows[0].endTime).toBe('2026-09-08T12:30:00Z');
  });

  it('substitutes a dash for empty string fields', () => {
    const vm = buildForumSubscriptionListViewModel(
      make({
        subscriptions: [
          sub({ forumId: '', forumName: '', forumStartTime: '', forumEndTime: '', statusText: '' }),
        ],
      }),
    );
    expect(vm.rows[0]).toEqual({
      forumId: '-',
      forumName: '-',
      startTime: '-',
      endTime: '-',
      statusText: '-',
      unread: '●',
    });
  });

  it('derives total from the subscriptions array rather than the counts', () => {
    const vm = buildForumSubscriptionListViewModel(
      make({ subscriptions: [sub(), sub({ forumId: 'F-1002' })], notStartedCount: 99 }),
    );
    expect(vm.total).toBe(2);
  });

  it('joins all five count buckets into countsSummary', () => {
    const vm = buildForumSubscriptionListViewModel(
      make({ summaryReadyCount: 2, unviewedCount: 1 }),
    );
    expect(vm.countsSummary).toBe(
      'Not started 0 · In progress 0 · Summary preparing 0 · Summary ready 2 · Unviewed 1',
    );
  });

  it('returns no rows and a zeroed countsSummary for an empty result', () => {
    const vm = buildForumSubscriptionListViewModel(make());
    expect(vm.rows).toEqual([]);
    expect(vm.total).toBe(0);
    expect(vm.countsSummary).toBe(
      'Not started 0 · In progress 0 · Summary preparing 0 · Summary ready 0 · Unviewed 0',
    );
  });
});
