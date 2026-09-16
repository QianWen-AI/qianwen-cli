import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { TableProps } from '../../src/ui/Table.js';
import type { Forum } from '../../src/types/yunqi.js';

/**
 * `Table` is captured rather than rendered. ink-testing-library hardcodes its
 * stdout to 100 columns and `render()` takes no options, so the 238-column
 * forum table always wraps and per-line assertions are not possible. Capturing
 * the props targets the contract that actually drifts — `columns[].key` against
 * the keys of each `data` row — and `Table` itself is covered by
 * tests/ui/Table.test.tsx and Table.render.test.tsx.
 */
const { captured } = vi.hoisted(() => ({ captured: [] as TableProps[] }));

vi.mock('../../src/ui/Table.js', () => ({
  Table: (props: TableProps) => {
    captured.push(props);
    return null;
  },
}));

import { YunqiForumListInk } from '../../src/ui/YunqiForumList.js';
import { buildForumListViewModel } from '../../src/view-models/yunqi/forum-list.js';

// Section reads process.stdout.columns to size its border.
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
  { key: 'id', header: 'ID' },
  { key: 'name', header: 'Name' },
  { key: 'theme', header: 'Theme' },
  { key: 'startTime', header: 'Start' },
  { key: 'endTime', header: 'End' },
  { key: 'location', header: 'Location' },
  { key: 'industry', header: 'Industry' },
  { key: 'interest', header: 'Interest' },
  { key: 'liveAddress', header: 'Live Address' },
  { key: 'topics', header: 'Topics' },
  { key: 'subscribable', header: 'Subscribable' },
  { key: 'description', header: 'Description' },
];

const forum: Forum = {
  id: 'ID1',
  name: 'NAME1',
  theme: 'THEME1',
  startTime: 'ST1',
  endTime: 'ET1',
  location: 'LOC1',
  industryList: ['IND1'],
  interestList: ['INT1'],
  liveAddress: 'LIVE1',
  topicList: [{}, {}, {}, {}, {}],
  subscribable: true,
  description: 'DESC1',
};

function renderList(
  overrides: Partial<Forum> = {},
  listOverrides: Partial<Parameters<typeof buildForumListViewModel>[0]> = {},
) {
  const vm = buildForumListViewModel({
    forums: [{ ...forum, ...overrides }],
    page: 2,
    pageSize: 20,
    total: 87,
    ...listOverrides,
  });
  const { lastFrame } = render(<YunqiForumListInk vm={vm} />);
  return stripAnsi(lastFrame() ?? '');
}

function tableProps(): TableProps {
  expect(captured, 'Table was not rendered').toHaveLength(1);
  return captured[0];
}

describe('<YunqiForumListInk />', () => {
  it('columns 与预期表头逐一对应且顺序一致', () => {
    renderList();
    expect(tableProps().columns).toEqual(EXPECTED_COLUMNS);
  });

  it('data 的键集合与 columns 的 key 集合完全一致', () => {
    // 双向防线：column key 改了而 data 没跟（渲染出空列），或 data 残留旧键
    renderList();
    const { columns, data } = tableProps();
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0]).sort()).toEqual(columns.map((c) => c.key).sort());
  });

  it('每个 column key 在数据行里都取得到值', () => {
    renderList();
    const { columns, data } = tableProps();
    for (const col of columns) {
      expect(data[0][col.key], `column '${col.key}' has no data field`).toBeDefined();
    }
  });

  it('单元格值取自 view-model', () => {
    renderList();
    expect(tableProps().data[0]).toEqual({
      id: 'ID1',
      name: 'NAME1',
      theme: 'THEME1',
      startTime: 'ST1',
      endTime: 'ET1',
      location: 'LOC1',
      industry: 'IND1',
      interest: 'INT1',
      liveAddress: 'LIVE1',
      topics: '5',
      subscribable: 'yes',
      description: 'DESC1',
    });
  });

  it('不可订阅且零议题时映射为 no 与 0', () => {
    renderList({ subscribable: false, topicList: [] });
    expect(tableProps().data[0]).toMatchObject({ topics: '0', subscribable: 'no' });
  });

  it('多行按顺序映射', () => {
    renderList({}, { forums: [forum, { ...forum, id: 'ID2' }] });
    expect(tableProps().data.map((r) => r.id)).toEqual(['ID1', 'ID2']);
  });

  it('渲染 Section 标题与分页 footer', () => {
    const out = renderList();
    expect(out).toContain('Forums');
    expect(out).toContain('87 forums · Page 2 of 5');
  });

  it('pageSize 为 0 时页数回退为 1', () => {
    expect(renderList({}, { page: 1, pageSize: 0 })).toContain('87 forums · Page 1 of 1');
  });

  it('paddingLeft 为 0', () => {
    renderList();
    expect(tableProps().paddingLeft).toBe(0);
  });
});
