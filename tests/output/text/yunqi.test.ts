/**
 * Text-renderer tests for the yunqi command group.
 *
 * The four list renderers build a header array and a row array separately and
 * `formatTextTable` zips them by index, padding absent cells with ''. A header
 * added without the matching row field (or the reverse) therefore produces a
 * silently misaligned table rather than an error, so these tests pin the two
 * arrays together by asserting order and equal display width.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  renderTextForumList,
  renderTextExhibitorList,
  renderTextSubscriptionList,
  renderTextForumSummaryList,
  renderTextForumSubscribe,
} from '../../../src/output/text/yunqi.js';
import { buildForumListViewModel } from '../../../src/view-models/yunqi/forum-list.js';
import { buildExhibitorListViewModel } from '../../../src/view-models/yunqi/exhibitor-list.js';
import { buildForumSubscriptionListViewModel } from '../../../src/view-models/yunqi/subscriptions.js';
import { buildForumSummaryListViewModel } from '../../../src/view-models/yunqi/forum-summaries.js';
import { buildForumSubscribeViewModel } from '../../../src/view-models/yunqi/forum-subscribe.js';
import { visibleWidth } from '../../../src/ui/textWrap.js';
import type { Forum, Exhibitor, ForumSummary } from '../../../src/types/yunqi.js';

function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  // formatTextTable emits the whole table in one console.log, so split again to
  // give callers one entry per physical line.
  return chunks.join('\n').split('\n');
}

/** Assert every needle occurs in `line`, in the given order. */
function expectInOrder(line: string, needles: string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const at = line.indexOf(needle, cursor + 1);
    expect(at, `${JSON.stringify(needle)} not found after offset ${cursor}`).toBeGreaterThan(
      cursor,
    );
    cursor = at;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderTextForumList', () => {
  const FORUM_HEADERS = [
    'ID',
    'Name',
    'Theme',
    'Start',
    'End',
    'Location',
    'Industry',
    'Interest',
    'Live Address',
    'Topics',
    'Subscribable',
    'Description',
  ];

  // Distinctive short sentinels: no truncation, and none is a substring of
  // another, so the order assertion cannot pass by accident.
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

  const CELLS = [
    'ID1',
    'NAME1',
    'THEME1',
    'ST1',
    'ET1',
    'LOC1',
    'IND1',
    'INT1',
    'LIVE1',
    '5',
    'yes',
    'DESC1',
  ];

  function render(overrides: Partial<Forum> = {}) {
    const vm = buildForumListViewModel({
      forums: [{ ...forum, ...overrides }],
      page: 2,
      pageSize: 20,
      total: 87,
    });
    return captureStdout(() => renderTextForumList(vm));
  }

  it('表头与数据行按同一顺序排列', () => {
    const [headerLine, dataLine] = render();
    expectInOrder(headerLine, FORUM_HEADERS);
    expectInOrder(dataLine, CELLS);
  });

  it('表头行与数据行显示宽度相等（列数错位时该断言失败）', () => {
    const [headerLine, dataLine] = render();
    expect(visibleWidth(dataLine)).toBe(visibleWidth(headerLine));
  });

  it('footer 汇报总数与页码', () => {
    const lines = render();
    expect(lines[lines.length - 1]).toBe('  87 forums · Page 2/5');
  });

  it('pageSize 为 0 时页码回退为 1', () => {
    const vm = buildForumListViewModel({ forums: [forum], page: 1, pageSize: 0, total: 87 });
    const lines = captureStdout(() => renderTextForumList(vm));
    expect(lines[lines.length - 1]).toBe('  87 forums · Page 1/1');
  });

  it('不可订阅论坛与零议题在表中可见', () => {
    const [, dataLine] = render({ subscribable: false, topicList: [] });
    expect(dataLine).toContain('no');
    expectInOrder(dataLine, ['LIVE1', '0', 'no', 'DESC1']);
  });

  it('整段 description 在表内被截断为省略号', () => {
    const [, dataLine] = render({ description: '云'.repeat(200) });
    expect(dataLine).toContain('…');
    expect(visibleWidth(dataLine)).toBeLessThan(400);
  });
});

describe('renderTextExhibitorList', () => {
  const HEADERS = ['ID', 'Code', 'Name', 'Hall', 'Zone', 'Booth', 'Description'];

  const exhibitor: Exhibitor = {
    exhibits: [
      {
        exhibitId: 'EID1',
        exhibitCode: 'CODE1',
        name: 'ENAME1',
        description: 'EDESC1',
        hall: { name: 'HALL1' },
        zone: { name: 'ZONE1' },
        booth: { name: 'BOOTH1' },
      },
    ],
  };

  it('表头与数据行按同一顺序排列', () => {
    const vm = buildExhibitorListViewModel({
      exhibitors: [exhibitor],
      page: 1,
      pageSize: 20,
      total: 634,
    });
    const [headerLine, dataLine] = captureStdout(() => renderTextExhibitorList(vm));
    expectInOrder(headerLine, HEADERS);
    expectInOrder(dataLine, ['EID1', 'CODE1', 'ENAME1', 'HALL1', 'ZONE1', 'BOOTH1', 'EDESC1']);
    expect(visibleWidth(dataLine)).toBe(visibleWidth(headerLine));
  });

  it('多展位摊平后的每一行仍与表头等宽且列序一致', () => {
    const vm = buildExhibitorListViewModel({
      exhibitors: [
        {
          exhibits: [
            {
              exhibitId: 'X1',
              exhibitCode: 'C1',
              name: '通义千问',
              hall: { name: '算力馆' },
              zone: { name: '云智能展区' },
              booth: { name: 'A12' },
              description: '大模型服务'.repeat(20),
            },
            {
              exhibitId: 'X2',
              exhibitCode: 'C2',
              name: '百炼平台',
              hall: { name: '3号馆' },
              zone: { name: '开发者展区' },
              booth: { name: 'B07' },
              description: '模型开发平台',
            },
          ],
        },
      ],
      page: 1,
      pageSize: 20,
      total: 634,
    });
    // header + 2 exhibit rows + footer
    const [headerLine, row1, row2] = captureStdout(() => renderTextExhibitorList(vm));
    expectInOrder(row1, ['X1', 'C1', '通义千问', '算力馆', '云智能展区', 'A12']);
    expectInOrder(row2, ['X2', 'C2', '百炼平台', '3号馆', '开发者展区', 'B07']);
    for (const line of [row1, row2]) {
      expect(visibleWidth(line)).toBe(visibleWidth(headerLine));
    }
  });

  it('footer 汇报总数与页码', () => {
    const vm = buildExhibitorListViewModel({
      exhibitors: [exhibitor],
      page: 1,
      pageSize: 20,
      total: 634,
    });
    const lines = captureStdout(() => renderTextExhibitorList(vm));
    expect(lines[lines.length - 1]).toBe('  634 exhibitors · Page 1/32');
  });
});

describe('renderTextSubscriptionList', () => {
  const HEADERS = ['Forum ID', 'Name', 'Start', 'End', 'Status', 'Unread'];

  const rows = [
    {
      forumId: 'SID1',
      forumName: 'SNAME1',
      forumStartTime: 'SST1',
      forumEndTime: 'SET1',
      status: 'summary_ready',
      statusText: 'SSTATUS1',
      viewed: false,
    },
  ];

  function render() {
    const vm = buildForumSubscriptionListViewModel({
      subscriptions: rows,
      notStartedCount: 0,
      inProgressCount: 1,
      summaryPreparingCount: 0,
      summaryReadyCount: 2,
      unviewedCount: 3,
    });
    return captureStdout(() => renderTextSubscriptionList(vm));
  }

  it('表头与数据行按同一顺序排列', () => {
    const [headerLine, dataLine] = render();
    expectInOrder(headerLine, HEADERS);
    expectInOrder(dataLine, ['SID1', 'SNAME1', 'SST1', 'SET1', 'SSTATUS1', '●']);
    expect(visibleWidth(dataLine)).toBe(visibleWidth(headerLine));
  });

  it('列名是 Unread 而非 Viewed，与实心点语义一致', () => {
    const [headerLine, dataLine] = render();
    expect(headerLine).not.toContain('Viewed');
    expect(headerLine).toContain('Unread');
    expect(dataLine).toContain('●');
  });

  it('footer 使用英文计数摘要', () => {
    const lines = render();
    expect(lines[lines.length - 1]).toBe(
      '  1 subscriptions · Not started 0 · In progress 1 · Summary preparing 0 · ' +
        'Summary ready 2 · Unviewed 3',
    );
  });
});

describe('renderTextForumSummaryList', () => {
  const summaries: ForumSummary[] = [
    { forumId: 'MID1', summary: 'MSUM1' },
    { forumId: 'MID2', summary: 'MSUM2' },
  ];

  it('表头与数据行按同一顺序排列', () => {
    const vm = buildForumSummaryListViewModel(summaries);
    const [headerLine, firstRow, secondRow] = captureStdout(() => renderTextForumSummaryList(vm));
    expectInOrder(headerLine, ['Forum ID', 'Summary']);
    expectInOrder(firstRow, ['MID1', 'MSUM1']);
    expectInOrder(secondRow, ['MID2', 'MSUM2']);
    expect(visibleWidth(firstRow)).toBe(visibleWidth(headerLine));
  });

  it('footer 只汇报条数', () => {
    const vm = buildForumSummaryListViewModel(summaries);
    const lines = captureStdout(() => renderTextForumSummaryList(vm));
    expect(lines[lines.length - 1]).toBe('  2 summaries');
  });
});

describe('renderTextForumSubscribe', () => {
  it.each([
    ['subscribe', true, 'Successfully subscribed to forum.'],
    ['subscribe', false, 'Failed to subscribe to forum.'],
    ['unsubscribe', true, 'Successfully unsubscribed from forum.'],
    ['unsubscribe', false, 'Failed to unsubscribe from forum.'],
  ] as const)('%s / success=%s 输出对应文案', (action, success, expected) => {
    const vm = buildForumSubscribeViewModel({ success }, action);
    const lines = captureStdout(() => renderTextForumSubscribe(vm));
    expect(lines).toEqual([expected]);
  });
});
