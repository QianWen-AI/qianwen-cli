import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { TableProps } from '../../src/ui/Table.js';
import type { ForumSummary } from '../../src/types/yunqi.js';

// Table is captured rather than rendered — see tests/ui/YunqiForumList.test.tsx.
const { captured } = vi.hoisted(() => ({ captured: [] as TableProps[] }));

vi.mock('../../src/ui/Table.js', () => ({
  Table: (props: TableProps) => {
    captured.push(props);
    return null;
  },
}));

import { YunqiForumSummaryListInk } from '../../src/ui/YunqiForumSummaryList.js';
import { buildForumSummaryListViewModel } from '../../src/view-models/yunqi/forum-summaries.js';

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
  { key: 'summary', header: 'Summary' },
];

const summaries: ForumSummary[] = [
  { forumId: 'MID1', summary: 'MSUM1' },
  { forumId: 'MID2', summary: 'MSUM2' },
];

function renderList(items: ForumSummary[] = summaries) {
  const vm = buildForumSummaryListViewModel(items);
  const { lastFrame } = render(<YunqiForumSummaryListInk vm={vm} />);
  return stripAnsi(lastFrame() ?? '');
}

function tableProps(): TableProps {
  expect(captured, 'Table was not rendered').toHaveLength(1);
  return captured[0];
}

describe('<YunqiForumSummaryListInk />', () => {
  it('columns 与预期表头逐一对应且顺序一致', () => {
    renderList();
    expect(tableProps().columns).toEqual(EXPECTED_COLUMNS);
  });

  it('data 的键集合与 columns 的 key 集合完全一致', () => {
    renderList();
    const { columns, data } = tableProps();
    expect(data).toHaveLength(2);
    for (const row of data) {
      expect(Object.keys(row).sort()).toEqual(columns.map((c) => c.key).sort());
    }
  });

  it('每行摘要按顺序映射', () => {
    renderList();
    expect(tableProps().data).toEqual([
      { forumId: 'MID1', summary: 'MSUM1' },
      { forumId: 'MID2', summary: 'MSUM2' },
    ]);
  });

  it('渲染 Section 标题与条数 footer', () => {
    const out = renderList();
    expect(out).toContain('Forum Summaries');
    expect(out).toContain('2 summaries');
  });

  it('paddingLeft 为 0', () => {
    renderList();
    expect(tableProps().paddingLeft).toBe(0);
  });
});
