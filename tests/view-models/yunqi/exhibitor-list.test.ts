import { describe, it, expect } from 'vitest';
import { buildExhibitorListViewModel } from '../../../src/view-models/yunqi/exhibitor-list.js';
import { visibleWidth } from '../../../src/ui/textWrap.js';
import type { Exhibit, Exhibitor, ExhibitorListResult } from '../../../src/types/yunqi.js';

/** Sum of the per-column budgets declared in exhibitor-list.ts. */
const TOTAL_WIDTH_BUDGET = 16 + 16 + 36 + 24 + 24 + 24 + 32;

const exhibit = (overrides: Partial<Exhibit> = {}): Exhibit => ({
  exhibitId: 'X-1-027',
  exhibitCode: 'C-1-027',
  name: '100天快速交付',
  ...overrides,
});

const exhibitor = (exhibits?: Exhibit[]): Exhibitor => ({ exhibits });

const result = (exhibitors: Exhibitor[]): ExhibitorListResult => ({
  exhibitors,
  page: 1,
  pageSize: 20,
  total: 634,
});

describe('buildExhibitorListViewModel', () => {
  it('映射每一行并透传分页信息', () => {
    const vm = buildExhibitorListViewModel(result([exhibitor([exhibit()])]));
    expect(vm.rows[0]).toMatchObject({ id: 'X-1-027', code: 'C-1-027' });
    expect(vm.total).toBe(634);
  });

  it('展位缺失 ID 与 Code 时退化为短横', () => {
    const vm = buildExhibitorListViewModel(
      result([
        exhibitor([
          exhibit({ exhibitId: undefined, exhibitCode: undefined, name: '随机展位8F2A' }),
        ]),
      ]),
    );
    expect(vm.rows[0]).toMatchObject({ id: '-', code: '-', name: '随机展位8F2A' });
  });

  it('一个参展商的多个展位摊平成多行', () => {
    const vm = buildExhibitorListViewModel(
      result([
        exhibitor([
          exhibit({ exhibitId: 'X1', name: '展品一' }),
          exhibit({ exhibitId: 'X2', name: '展品二' }),
          exhibit({ exhibitId: 'X3', name: '展品三' }),
        ]),
      ]),
    );
    expect(vm.rows.map((row) => row.id)).toEqual(['X1', 'X2', 'X3']);
  });

  it('多个参展商的行按接口顺序拼接，不重新排序', () => {
    const vm = buildExhibitorListViewModel(
      result([
        exhibitor([exhibit({ exhibitId: 'B2' }), exhibit({ exhibitId: 'B1' })]),
        exhibitor([exhibit({ exhibitId: 'A9' })]),
      ]),
    );
    expect(vm.rows.map((row) => row.id)).toEqual(['B2', 'B1', 'A9']);
  });

  it('exhibits 为空数组或缺省时贡献零行且不抛异常', () => {
    expect(buildExhibitorListViewModel(result([exhibitor([])])).rows).toEqual([]);
    expect(buildExhibitorListViewModel(result([exhibitor(undefined)])).rows).toEqual([]);
    expect(buildExhibitorListViewModel(result([{}])).rows).toEqual([]);
  });

  it.each([
    { label: '只有 name', hall: { name: '算力馆' }, expected: '算力馆' },
    { label: '只有 code', hall: { code: 'H1' }, expected: 'H1' },
    { label: 'name 与 code 都有', hall: { name: '算力馆', code: 'H1' }, expected: '算力馆' },
    { label: '空对象', hall: {}, expected: '-' },
    { label: '缺省', hall: undefined, expected: '-' },
  ])('Hall $label 时渲染为 $expected', ({ hall, expected }) => {
    const vm = buildExhibitorListViewModel(result([exhibitor([exhibit({ hall })])]));
    expect(vm.rows[0].hall).toBe(expected);
  });

  it('Zone 与 Booth 同样优先取 name 并回退到 code', () => {
    const vm = buildExhibitorListViewModel(
      result([
        exhibitor([
          exhibit({
            zone: { code: 'Z1', name: '云智能展区' },
            booth: { code: 'B12' },
          }),
        ]),
      ]),
    );
    expect(vm.rows[0]).toMatchObject({ zone: '云智能展区', booth: 'B12' });
  });

  it('Hall/Zone/Booth 的名称过长时被截断', () => {
    const vm = buildExhibitorListViewModel(
      result([
        exhibitor([
          exhibit({
            hall: { name: 'A'.repeat(60) },
            zone: { name: '云'.repeat(40) },
            booth: { name: 'B'.repeat(60) },
          }),
        ]),
      ]),
    );
    expect(visibleWidth(vm.rows[0].hall)).toBeLessThanOrEqual(24);
    expect(visibleWidth(vm.rows[0].zone)).toBeLessThanOrEqual(24);
    expect(visibleWidth(vm.rows[0].booth)).toBeLessThanOrEqual(24);
  });

  it('每个字段都超长时整行显示宽度仍受预算约束', () => {
    const vm = buildExhibitorListViewModel(
      result([
        exhibitor([
          exhibit({
            exhibitId: '9'.repeat(60),
            exhibitCode: '8'.repeat(60),
            name: 'A'.repeat(200),
            description: 'C'.repeat(600),
            hall: { name: 'D'.repeat(100) },
            zone: { name: 'F'.repeat(100) },
            booth: { name: 'H'.repeat(100) },
          }),
        ]),
      ]),
    );
    const rowWidth = Object.values(vm.rows[0]).reduce((sum, cell) => sum + visibleWidth(cell), 0);
    expect(rowWidth).toBeLessThanOrEqual(TOTAL_WIDTH_BUDGET);
  });

  it('行字段声明顺序与渲染顺序一致', () => {
    const vm = buildExhibitorListViewModel(result([exhibitor([exhibit()])]));
    expect(Object.keys(vm.rows[0])).toEqual([
      'id',
      'code',
      'name',
      'hall',
      'zone',
      'booth',
      'description',
    ]);
  });

  it('空列表产生零行', () => {
    const vm = buildExhibitorListViewModel(result([]));
    expect(vm.rows).toEqual([]);
  });
});
