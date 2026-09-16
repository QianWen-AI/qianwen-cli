import { describe, it, expect } from 'vitest';
import { buildForumListViewModel } from '../../../src/view-models/yunqi/forum-list.js';
import { visibleWidth } from '../../../src/ui/textWrap.js';
import type { Forum, ForumListResult } from '../../../src/types/yunqi.js';

/** Sum of the per-column budgets declared in forum-list.ts. */
const TOTAL_WIDTH_BUDGET = 12 + 36 + 18 + 20 + 20 + 18 + 20 + 20 + 24 + 6 + 12 + 32;

const forum = (overrides: Partial<Forum> = {}): Forum => ({
  id: '194',
  name: 'AI驱动的服务进化',
  ...overrides,
});

const result = (forums: Forum[]): ForumListResult => ({
  forums,
  page: 2,
  pageSize: 20,
  total: 87,
});

describe('buildForumListViewModel', () => {
  it('映射每一行并透传分页信息', () => {
    const vm = buildForumListViewModel(result([forum()]));
    expect(vm.rows[0]).toMatchObject({ id: '194', name: 'AI驱动的服务进化' });
    expect(vm.page).toBe(2);
    expect(vm.pageSize).toBe(20);
    expect(vm.total).toBe(87);
  });

  it('缺失字段渲染为短横', () => {
    const vm = buildForumListViewModel(result([forum({ id: '', name: '' })]));
    expect(vm.rows[0]).toEqual({
      id: '-',
      name: '-',
      theme: '-',
      description: '-',
      startTime: '-',
      endTime: '-',
      location: '-',
      industry: '-',
      interest: '-',
      liveAddress: '-',
      topics: '-',
      subscribable: 'no',
    });
  });

  it('拼接 industryList / interestList，空数组退化为短横', () => {
    const vm = buildForumListViewModel(
      result([forum({ industryList: ['互联网', '汽车'], interestList: [] })]),
    );
    expect(vm.rows[0].industry).toBe('互联网, 汽车');
    expect(vm.rows[0].interest).toBe('-');
  });

  it('topicList 存在时渲染议题数，空数组为 0，缺省为短横', () => {
    const withTopics = buildForumListViewModel(
      result([forum({ topicList: [{ topicTitle: 'a' }, { topicTitle: 'b' }] })]),
    );
    expect(withTopics.rows[0].topics).toBe('2');

    const empty = buildForumListViewModel(result([forum({ topicList: [] })]));
    expect(empty.rows[0].topics).toBe('0');

    const absent = buildForumListViewModel(result([forum()]));
    expect(absent.rows[0].topics).toBe('-');
  });

  it('subscribable 渲染为 yes/no，供用户在 subscribe 前判断', () => {
    const vm = buildForumListViewModel(
      result([forum({ subscribable: true }), forum({ subscribable: false }), forum()]),
    );
    expect(vm.rows[0].subscribable).toBe('yes');
    expect(vm.rows[1].subscribable).toBe('no');
    expect(vm.rows[2].subscribable).toBe('no');
  });

  it('整段 description 被截断到列预算内', () => {
    const vm = buildForumListViewModel(result([forum({ description: '云'.repeat(300) })]));
    expect(visibleWidth(vm.rows[0].description)).toBeLessThanOrEqual(32);
    expect(vm.rows[0].description.endsWith('…')).toBe(true);
  });

  it('带秒与 Z 后缀的时间戳不被截断', () => {
    // 同后端的 ListMyForumSubscriptions 返回 20 字符格式，预算过窄会切成 …05:3…
    const vm = buildForumListViewModel(
      result([forum({ startTime: '2026-09-22T13:30:00Z', endTime: '2026-09-22T17:30:00Z' })]),
    );
    expect(vm.rows[0].startTime).toBe('2026-09-22T13:30:00Z');
    expect(vm.rows[0].endTime).toBe('2026-09-22T17:30:00Z');
  });

  it('每个字段都超长时整行显示宽度仍受预算约束', () => {
    // 回归防线：Description 是整段文案，未截断前 text 模式单行达到 1000 列
    const vm = buildForumListViewModel(
      result([
        forum({
          id: '9'.repeat(60),
          name: 'A'.repeat(200),
          theme: 'B'.repeat(200),
          description: 'C'.repeat(600),
          startTime: 'D'.repeat(100),
          endTime: 'E'.repeat(100),
          location: 'F'.repeat(200),
          industryList: ['x'.repeat(120)],
          interestList: ['y'.repeat(120)],
          liveAddress: `https://live.test.qianwenai.com/${'z'.repeat(200)}`,
        }),
      ]),
    );
    const rowWidth = Object.values(vm.rows[0]).reduce((sum, cell) => sum + visibleWidth(cell), 0);
    expect(rowWidth).toBeLessThanOrEqual(TOTAL_WIDTH_BUDGET);
  });

  it('空列表产生零行', () => {
    const vm = buildForumListViewModel(result([]));
    expect(vm.rows).toEqual([]);
  });
});
