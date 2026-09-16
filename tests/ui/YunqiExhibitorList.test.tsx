import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { TableProps } from '../../src/ui/Table.js';
import type { Exhibit, Exhibitor } from '../../src/types/yunqi.js';

// Table is captured rather than rendered — see tests/ui/YunqiForumList.test.tsx
// for why (ink-testing-library pins stdout to 100 columns).
const { captured } = vi.hoisted(() => ({ captured: [] as TableProps[] }));

vi.mock('../../src/ui/Table.js', () => ({
  Table: (props: TableProps) => {
    captured.push(props);
    return null;
  },
}));

import { YunqiExhibitorListInk } from '../../src/ui/YunqiExhibitorList.js';
import { buildExhibitorListViewModel } from '../../src/view-models/yunqi/exhibitor-list.js';

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
  { key: 'code', header: 'Code' },
  { key: 'name', header: 'Name' },
  { key: 'hall', header: 'Hall' },
  { key: 'zone', header: 'Zone' },
  { key: 'booth', header: 'Booth' },
  { key: 'description', header: 'Description' },
];

const exhibit = (overrides: Partial<Exhibit> = {}): Exhibit => ({
  exhibitId: 'EID1',
  exhibitCode: 'CODE1',
  name: 'ENAME1',
  description: 'EDESC1',
  hall: { name: 'HALL1' },
  zone: { name: 'ZONE1' },
  booth: { name: 'BOOTH1' },
  ...overrides,
});

const exhibitor = (exhibits: Exhibit[] = [exhibit()]): Exhibitor => ({ exhibits });

function renderList(exhibitors: Exhibitor[] = [exhibitor()]) {
  const vm = buildExhibitorListViewModel({ exhibitors, page: 1, pageSize: 20, total: 634 });
  const { lastFrame } = render(<YunqiExhibitorListInk vm={vm} />);
  return stripAnsi(lastFrame() ?? '');
}

function tableProps(): TableProps {
  expect(captured, 'Table was not rendered').toHaveLength(1);
  return captured[0];
}

describe('<YunqiExhibitorListInk />', () => {
  it('columns 与预期表头逐一对应且顺序一致', () => {
    renderList();
    expect(tableProps().columns).toEqual(EXPECTED_COLUMNS);
  });

  it('data 的键顺序与 columns 的 key 顺序逐项一致', () => {
    renderList();
    const { columns, data } = tableProps();
    expect(Object.keys(data[0])).toEqual(columns.map((c) => c.key));
  });

  it('单元格值取自展位的 view-model 映射', () => {
    renderList();
    expect(tableProps().data[0]).toEqual({
      id: 'EID1',
      code: 'CODE1',
      name: 'ENAME1',
      hall: 'HALL1',
      zone: 'ZONE1',
      booth: 'BOOTH1',
      description: 'EDESC1',
    });
  });

  it('一个参展商的多个展位渲染成多行', () => {
    renderList([exhibitor([exhibit({ exhibitId: 'EID1' }), exhibit({ exhibitId: 'EID2' })])]);
    expect(tableProps().data.map((row) => row.id)).toEqual(['EID1', 'EID2']);
  });

  it('展位缺失 ID 与 Code 时映射为短横', () => {
    renderList([exhibitor([exhibit({ exhibitId: undefined, exhibitCode: undefined })])]);
    expect(tableProps().data[0]).toMatchObject({ id: '-', code: '-' });
  });

  it('渲染 Section 标题与分页 footer', () => {
    const out = renderList();
    expect(out).toContain('Exhibitors');
    // total counts exhibitors, not the exhibit rows rendered from them.
    expect(out).toContain('634 exhibitors · Page 1 of 32');
  });

  it('paddingLeft 为 0', () => {
    renderList();
    expect(tableProps().paddingLeft).toBe(0);
  });
});
