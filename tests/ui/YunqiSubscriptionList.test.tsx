import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { TableProps } from '../../src/ui/Table.js';
import type { ForumSubscriptionListResult } from '../../src/types/yunqi.js';

// Table is captured rather than rendered — see tests/ui/YunqiForumList.test.tsx.
const { captured } = vi.hoisted(() => ({ captured: [] as TableProps[] }));

vi.mock('../../src/ui/Table.js', () => ({
  Table: (props: TableProps) => {
    captured.push(props);
    return null;
  },
}));

import { YunqiSubscriptionListInk } from '../../src/ui/YunqiSubscriptionList.js';
import { buildForumSubscriptionListViewModel } from '../../src/view-models/yunqi/subscriptions.js';

const ORIGINAL_COLUMNS = process.stdout.columns;
beforeEach(() => {
  captured.length = 0;
  Object.defineProperty(process.stdout, 'columns', { value: 400, configurable: true });
});
afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', {
    value: ORIGINAL_COLUMNS,
    configurable: true,
  });
});

const EXPECTED_COLUMNS = [
  { key: 'forumId', header: 'Forum ID' },
  { key: 'forumName', header: 'Name' },
  { key: 'startTime', header: 'Start' },
  { key: 'endTime', header: 'End' },
  { key: 'statusText', header: 'Status' },
  { key: 'unread', header: 'Unread' },
];

function makeResult(
  overrides: Partial<ForumSubscriptionListResult> = {},
): ForumSubscriptionListResult {
  return {
    subscriptions: [
      {
        forumId: 'SID1',
        forumName: 'SNAME1',
        forumStartTime: '2026-09-08T05:30:00Z',
        forumEndTime: '2026-09-08T12:30:00Z',
        status: 'summary_ready',
        statusText: 'SSTATUS1',
        viewed: false,
      },
    ],
    notStartedCount: 0,
    inProgressCount: 1,
    summaryPreparingCount: 0,
    summaryReadyCount: 2,
    unviewedCount: 3,
    ...overrides,
  };
}

function renderList(result: ForumSubscriptionListResult = makeResult()) {
  const vm = buildForumSubscriptionListViewModel(result);
  const { lastFrame } = render(<YunqiSubscriptionListInk vm={vm} />);
  return stripAnsi(lastFrame() ?? '');
}

function tableProps(): TableProps {
  expect(captured, 'Table was not rendered').toHaveLength(1);
  return captured[0];
}

describe('<YunqiSubscriptionListInk />', () => {
  it('columns 与预期表头逐一对应，末列为 Unread 而非 Viewed', () => {
    renderList();
    expect(tableProps().columns).toEqual(EXPECTED_COLUMNS);
    expect(tableProps().columns.map((c) => c.header)).not.toContain('Viewed');
  });

  it('data 的键集合与 columns 的 key 集合完全一致', () => {
    renderList();
    const { columns, data } = tableProps();
    expect(Object.keys(data[0]).sort()).toEqual(columns.map((c) => c.key).sort());
  });

  it('20 字符时间戳原样透传，未被截断', () => {
    renderList();
    expect(tableProps().data[0]).toMatchObject({
      startTime: '2026-09-08T05:30:00Z',
      endTime: '2026-09-08T12:30:00Z',
    });
  });

  it('未读为实心点、已读为短横，且与列名语义一致', () => {
    renderList(
      makeResult({
        subscriptions: [
          { ...makeResult().subscriptions[0], viewed: false },
          { ...makeResult().subscriptions[0], forumId: 'SID2', viewed: true },
        ],
      }),
    );
    expect(tableProps().data.map((r) => r.unread)).toEqual(['●', '-']);
  });

  it('footer 以条数与英文计数摘要开头', () => {
    const out = renderList();
    expect(out).toContain('Subscriptions');
    // Section truncates the footer to the frame width, and ink-testing-library
    // pins that to 100 columns — the full ~103-column summary renders as
    // `Unviewe…`. The exact string is pinned by the view-model and text-renderer
    // tests, where terminal width is not a factor.
    expect(out).toContain('1 subscriptions · Not started 0 · In progress 1');
  });

  it('paddingLeft 为 0', () => {
    renderList();
    expect(tableProps().paddingLeft).toBe(0);
  });
});
