/** Unit tests for YunqiService (ListForums / ListExhibitors / subscriptions). */
import { describe, it, expect } from 'vitest';
import { YunqiService } from '../../src/services/yunqi-service.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';
import type { ListExhibitorsOptions, ListForumsOptions } from '../../src/types/yunqi.js';

interface MockSetup {
  svc: YunqiService;
  captured: { params?: Record<string, unknown> };
}

function makeYunqiService(data: unknown, action = 'ListForums'): MockSetup {
  return makeYunqiServiceRaw({ Code: 200, Message: 'success', Data: data }, action);
}

function makeYunqiServiceRaw(envelope: unknown, action = 'ListForums'): MockSetup {
  const captured: { params?: Record<string, unknown> } = {};
  const api = makeMockApiClient({
    flat: (opts: CallFlatApiOptions) => {
      expect(opts.product).toBe('MaasPortal');
      expect(opts.action).toBe(action);
      captured.params = opts.params ?? {};
      return Promise.resolve(envelope);
    },
  });
  return { svc: new YunqiService(api), captured };
}

describe('YunqiService.listForums', () => {
  it('sends Page/PageSize defaults when no options are given', async () => {
    const { svc, captured } = makeYunqiService(emptyData());
    await svc.listForums();
    expect(captured.params).toEqual({ Page: 1, PageSize: 20 });
  });

  it('sends custom page/pageSize', async () => {
    const { svc, captured } = makeYunqiService(emptyData());
    await svc.listForums({ page: 3, pageSize: 50 });
    expect(captured.params).toEqual({ Page: 3, PageSize: 50 });
  });

  const filterWireKeys: Array<[keyof ListForumsOptions, string]> = [
    ['industry', 'Industry'],
    ['interest', 'Interest'],
    ['location', 'Location'],
    ['forumId', 'ForumId'],
    ['keyword', 'Keyword'],
    ['forumName', 'ForumName'],
    ['memberName', 'MemberName'],
    ['themeName', 'ThemeName'],
    ['topicName', 'TopicName'],
    ['guestName', 'GuestName'],
    ['companyName', 'CompanyName'],
  ];

  it.each(filterWireKeys)('maps filter %s to wire param %s', async (camelKey, wireKey) => {
    const { svc, captured } = makeYunqiService(emptyData());
    await svc.listForums({ [camelKey]: 'filter-value' } as ListForumsOptions);
    expect(captured.params).toEqual({ Page: 1, PageSize: 20, [wireKey]: 'filter-value' });
  });

  it('sends combined filters together with pagination', async () => {
    const { svc, captured } = makeYunqiService(emptyData());
    await svc.listForums({ industry: 'AI', forumId: 'F-9' });
    expect(captured.params).toEqual({
      Page: 1,
      PageSize: 20,
      Industry: 'AI',
      ForumId: 'F-9',
    });
  });

  it('omits empty and undefined filters', async () => {
    const { svc, captured } = makeYunqiService(emptyData());
    await svc.listForums({ forumName: '', keyword: undefined, page: 2 });
    expect(captured.params).toEqual({ Page: 2, PageSize: 20 });
  });

  it('parses the Data envelope with nested topics and guests', async () => {
    const { svc } = makeYunqiService({
      Total: 3,
      Page: 2,
      PageSize: 20,
      Items: [
        {
          ForumId: 'F-1',
          DisplayName: '云栖大会',
          Theme: '云计算与 AI',
          Description: '主论坛',
          StartTime: '2026-09-17T10:00:00',
          EndTime: '2026-09-17T12:00:00',
          Location: '杭州',
          IndustryList: ['AI', 'Cloud'],
          InterestList: ['大模型'],
          TechnicalLevel: 'advanced',
          TopicList: [
            {
              DurationMinutes: '30',
              TopicTitle: '主题演讲',
              Description: '开场',
              Guests: [{ GuestName: '张三', GuestTitle: 'CEO', GuestCompany: '示例公司' }],
            },
          ],
          LiveAddress: 'https://live.example.com/f1',
          Subscribable: 'true',
        },
      ],
    });
    const result = await svc.listForums({ page: 2, pageSize: 20 });
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(3);
    expect(result.forums).toHaveLength(1);
    const forum = result.forums[0];
    expect(forum).toMatchObject({
      id: 'F-1',
      name: '云栖大会',
      theme: '云计算与 AI',
      description: '主论坛',
      location: '杭州',
      industryList: ['AI', 'Cloud'],
      interestList: ['大模型'],
      technicalLevel: 'advanced',
      liveAddress: 'https://live.example.com/f1',
      subscribable: true,
    });
    expect(forum.topicList).toEqual([
      {
        durationMinutes: '30',
        topicTitle: '主题演讲',
        description: '开场',
        guests: [{ guestName: '张三', guestTitle: 'CEO', guestCompany: '示例公司' }],
      },
    ]);
  });

  it('ignores removed En name fields in the response', async () => {
    const { svc } = makeYunqiService({
      Items: [
        {
          ForumId: 'F-1',
          DisplayName: '云栖大会',
          DisplayNameEn: 'Apsara Conference',
          TopicList: [
            {
              TopicTitle: '主题演讲',
              TopicTitleEn: 'Keynote',
              Guests: [{ GuestName: '张三', GuestNameEn: 'Zhang San' }],
            },
          ],
        },
      ],
    });
    const result = await svc.listForums();
    expect(result.forums[0]).not.toHaveProperty('displayNameEn');
    expect(result.forums[0].topicList?.[0]).not.toHaveProperty('topicTitleEn');
    expect(result.forums[0].topicList?.[0].guests?.[0]).not.toHaveProperty('guestNameEn');
  });

  it('parses Subscribable from both the string and the JSON boolean form', async () => {
    const { svc } = makeYunqiService({
      Items: [
        { ForumId: 'F-1', Subscribable: 'true' },
        { ForumId: 'F-2', Subscribable: 'false' },
        { ForumId: 'F-3', Subscribable: true },
        { ForumId: 'F-4', Subscribable: false },
        { ForumId: 'F-5' },
      ],
    });
    const result = await svc.listForums();
    expect(result.forums[0].subscribable).toBe(true);
    expect(result.forums[1].subscribable).toBe(false);
    expect(result.forums[2].subscribable).toBe(true);
    expect(result.forums[3].subscribable).toBe(false);
    expect(result.forums[4].subscribable).toBe(false);
  });

  it('保留 DurationMinutes 为 0 的取值', async () => {
    const { svc } = makeYunqiService({
      Items: [{ ForumId: 'F-1', TopicList: [{ DurationMinutes: 0, TopicTitle: '开场' }] }],
    });
    const result = await svc.listForums();
    expect(result.forums[0].topicList?.[0].durationMinutes).toBe('0');
  });

  it('透传 Items[].ExtJson 原串', async () => {
    const { svc } = makeYunqiService({
      Items: [{ ForumId: 'F-1', ExtJson: '{"badge":"gold"}' }],
    });
    const result = await svc.listForums();
    expect(result.forums[0].extJson).toBe('{"badge":"gold"}');
  });

  it('ExtJson 缺省时为 undefined', async () => {
    const { svc } = makeYunqiService({ Items: [{ ForumId: 'F-1' }] });
    const result = await svc.listForums();
    expect(result.forums[0].extJson).toBeUndefined();
  });
});

describe('YunqiService.listExhibitors', () => {
  it('sends Page/PageSize defaults when no options are given', async () => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors();
    expect(captured.params).toEqual({ Page: 1, PageSize: 20 });
  });

  it('sends custom page/pageSize', async () => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors({ page: 2, pageSize: 50 });
    expect(captured.params).toEqual({ Page: 2, PageSize: 50 });
  });

  const exhibitorFilterWireKeys: Array<[keyof ListExhibitorsOptions, string]> = [
    ['keyword', 'Keyword'],
    ['companyName', 'CompanyName'],
    ['hallName', 'HallName'],
    ['zoneName', 'ZoneName'],
    ['boothName', 'BoothName'],
    ['exhibitName', 'ExhibitName'],
  ];

  it.each(exhibitorFilterWireKeys)('maps filter %s to wire param %s', async (camelKey, wireKey) => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors({ [camelKey]: 'filter-value' } as ListExhibitorsOptions);
    expect(captured.params).toEqual({ Page: 1, PageSize: 20, [wireKey]: 'filter-value' });
  });

  it('sends combined string filters together with pagination', async () => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors({ companyName: '阿里云', hallName: '3B' });
    expect(captured.params).toEqual({
      Page: 1,
      PageSize: 20,
      CompanyName: '阿里云',
      HallName: '3B',
    });
  });

  it('omits empty and undefined string filters', async () => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors({ boothName: '', keyword: undefined, page: 3 });
    expect(captured.params).toEqual({ Page: 3, PageSize: 20 });
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('sends Enabled=%s when provided', async (_label, enabled) => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors({ enabled });
    expect(captured.params).toEqual({ Page: 1, PageSize: 20, Enabled: enabled });
  });

  it('omits Enabled when not provided', async () => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors({});
    expect(captured.params).toEqual({ Page: 1, PageSize: 20 });
  });

  it('sends Enabled together with other exhibitor filters', async () => {
    const { svc, captured } = makeYunqiService(emptyData(), 'ListExhibitors');
    await svc.listExhibitors({ enabled: true, hallName: '算力馆', page: 2 });
    expect(captured.params).toEqual({
      Page: 2,
      PageSize: 20,
      HallName: '算力馆',
      Enabled: true,
    });
  });

  it('parses the Data envelope with per-exhibit hall, zone and booth', async () => {
    const { svc } = makeYunqiService(
      {
        Total: 2,
        Page: 1,
        PageSize: 20,
        Items: [
          {
            Exhibits: [
              {
                ExhibitId: 'X-1',
                ExhibitCode: 'C-100',
                Name: '通义千问',
                Description: '主推大模型',
                Hall: { Code: 'H1', Name: '1号馆' },
                Zone: { Code: 'Z1', Name: '云智能展区' },
                Booth: { Code: 'B12', Name: 'A12' },
              },
              {
                ExhibitId: 'X-2',
                ExhibitCode: 'C-101',
                Name: '百炼平台',
                Hall: null,
                Zone: undefined,
                Booth: null,
              },
            ],
          },
          { Exhibits: [] },
        ],
      },
      'ListExhibitors',
    );
    const result = await svc.listExhibitors();
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(2);
    expect(result.exhibitors).toHaveLength(2);
    expect(result.exhibitors[0].exhibits).toEqual([
      {
        exhibitId: 'X-1',
        exhibitCode: 'C-100',
        name: '通义千问',
        description: '主推大模型',
        hall: { code: 'H1', name: '1号馆' },
        zone: { code: 'Z1', name: '云智能展区' },
        booth: { code: 'B12', name: 'A12' },
      },
      {
        exhibitId: 'X-2',
        exhibitCode: 'C-101',
        name: '百炼平台',
        hall: undefined,
        zone: undefined,
        booth: undefined,
      },
    ]);
    expect(result.exhibitors[1].exhibits).toEqual([]);
  });

  it('不再解析已移除的条目级 ExhibitorId/ExhibitorCode/Name/Description/Hall/Zone', async () => {
    const { svc } = makeYunqiService(
      {
        Items: [
          {
            ExhibitorId: 'E-1',
            ExhibitorCode: 'C-100',
            Name: '示例科技',
            Description: '主推大模型',
            Hall: { Code: 'H1', Name: '1号馆' },
            Zone: { Code: 'Z1', Name: '云智能展区' },
            Exhibits: [{ ExhibitId: 'X-1' }],
          },
        ],
      },
      'ListExhibitors',
    );
    const result = await svc.listExhibitors();
    // `in`, not toEqual — toEqual ignores undefined-valued keys and would pass either way.
    for (const key of ['exhibitorId', 'exhibitorCode', 'name', 'description', 'hall', 'zone']) {
      expect(key in result.exhibitors[0], `${key} should no longer be normalized`).toBe(false);
    }
    expect(result.exhibitors[0].exhibits?.[0].exhibitId).toBe('X-1');
  });

  it('Exhibits 缺省或非数组时为 undefined，含 null 元素时不抛异常', async () => {
    const { svc } = makeYunqiService(
      { Items: [{ ExtJson: '{}' }, { Exhibits: 'nope' }, { Exhibits: [null] }] },
      'ListExhibitors',
    );
    const result = await svc.listExhibitors();
    expect(result.exhibitors[0].exhibits).toBeUndefined();
    expect(result.exhibitors[1].exhibits).toBeUndefined();
    expect(result.exhibitors[2].exhibits).toEqual([{}]);
  });

  it('保留取值为 "0" 的 ExhibitCode 与 Hall.Code', async () => {
    const { svc } = makeYunqiService(
      { Items: [{ Exhibits: [{ ExhibitCode: '0', Hall: { Code: '0' } }] }] },
      'ListExhibitors',
    );
    const result = await svc.listExhibitors();
    expect(result.exhibitors[0].exhibits?.[0].exhibitCode).toBe('0');
    expect(result.exhibitors[0].exhibits?.[0].hall?.code).toBe('0');
  });

  it('Hall/Zone 已无 Description：网关仍下发时也不得出现在归一化结果中', async () => {
    const { svc } = makeYunqiService(
      {
        Items: [
          {
            Exhibits: [
              {
                Description: '展品简介',
                Hall: { Code: 'H1', Name: '1号馆', Description: '主馆' },
                Zone: { Code: 'Z1', Name: '云智能展区', Description: 'A 区' },
              },
            ],
          },
        ],
      },
      'ListExhibitors',
    );
    const result = await svc.listExhibitors();
    const first = result.exhibitors[0].exhibits?.[0];
    expect(first?.description).toBe('展品简介');
    expect(first?.hall).toEqual({ code: 'H1', name: '1号馆' });
    expect(first?.zone).toEqual({ code: 'Z1', name: '云智能展区' });
  });

  it('透传 Items[].ExtJson 原串，缺省时为 undefined', async () => {
    const { svc } = makeYunqiService(
      { Items: [{ ExtJson: '{"booth":"B12"}' }, {}] },
      'ListExhibitors',
    );
    const result = await svc.listExhibitors();
    expect(result.exhibitors[0].extJson).toBe('{"booth":"B12"}');
    expect(result.exhibitors[1].extJson).toBeUndefined();
  });

  it('returns an empty result for empty data', async () => {
    const { svc } = makeYunqiService(emptyData(), 'ListExhibitors');
    const result = await svc.listExhibitors();
    expect(result).toEqual({ exhibitors: [], page: 1, pageSize: 20, total: 0 });
  });
});

describe('YunqiService.listMyForumSubscriptions', () => {
  const ACTION = 'ListMyForumSubscriptions';

  function subscriptionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      NotStartedCount: 1,
      InProgressCount: 0,
      SummaryPreparingCount: 0,
      SummaryReadyCount: 1,
      UnviewedCount: 1,
      Items: [
        {
          ForumId: 'F-1001',
          ForumName: '云栖大会主论坛',
          ForumStartTime: '2026-09-10 09:00',
          ForumEndTime: '2026-09-10 12:00',
          Status: 'not_started',
          StatusText: '会议未开始',
          Viewed: false,
        },
        {
          ForumId: 'F-1002',
          ForumName: 'AI 基础设施论坛',
          ForumStartTime: '2026-09-01 09:00',
          ForumEndTime: '2026-09-01 12:00',
          Status: 'summary_ready',
          StatusText: '摘要准备完成',
          Viewed: true,
        },
      ],
      ...overrides,
    };
  }

  function emptyResult(): Record<string, unknown> {
    return {
      subscriptions: [],
      notStartedCount: 0,
      inProgressCount: 0,
      summaryPreparingCount: 0,
      summaryReadyCount: 0,
      unviewedCount: 0,
    };
  }

  it('解析 Items 中每一项的全部字段', async () => {
    const { svc } = makeYunqiService(subscriptionData(), ACTION);
    const result = await svc.listMyForumSubscriptions();
    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscriptions[0]).toEqual({
      forumId: 'F-1001',
      forumName: '云栖大会主论坛',
      forumStartTime: '2026-09-10 09:00',
      forumEndTime: '2026-09-10 12:00',
      status: 'not_started',
      statusText: '会议未开始',
      viewed: false,
    });
    expect(result.subscriptions[1].statusText).toBe('摘要准备完成');
  });

  it('ForumName 缺失时归一化为空字符串', async () => {
    const { svc } = makeYunqiService({ Items: [{ ForumId: 'F-1' }] }, ACTION);
    const result = await svc.listMyForumSubscriptions();
    expect(result.subscriptions[0].forumName).toBe('');
  });

  it('透传服务端返回的 5 个聚合计数', async () => {
    const { svc } = makeYunqiService(subscriptionData(), ACTION);
    const result = await svc.listMyForumSubscriptions();
    expect(result).toMatchObject({
      notStartedCount: 1,
      inProgressCount: 0,
      summaryPreparingCount: 0,
      summaryReadyCount: 1,
      unviewedCount: 1,
    });
  });

  it('不带任何业务参数请求', async () => {
    const { svc, captured } = makeYunqiService({ Items: [] }, ACTION);
    await svc.listMyForumSubscriptions();
    expect(captured.params).toEqual({});
  });

  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
    [undefined, false],
  ] as const)('Viewed=%s 归一化为布尔 %s', async (wire, expected) => {
    const { svc } = makeYunqiService({ Items: [{ ForumId: 'F-1', Viewed: wire }] }, ACTION);
    const result = await svc.listMyForumSubscriptions();
    expect(result.subscriptions[0].viewed).toBe(expected);
    expect(typeof result.subscriptions[0].viewed).toBe('boolean');
  });

  it('计数字段为字符串数字时归一化为 number', async () => {
    const { svc } = makeYunqiService(
      { NotStartedCount: '3', UnviewedCount: '1', Items: [] },
      ACTION,
    );
    const result = await svc.listMyForumSubscriptions();
    expect(result.notStartedCount).toBe(3);
    expect(typeof result.notStartedCount).toBe('number');
    expect(result.unviewedCount).toBe(1);
    expect(result.inProgressCount).toBe(0);
    expect(result.summaryPreparingCount).toBe(0);
    expect(result.summaryReadyCount).toBe(0);
  });

  it('透传 Items[].ExtJson 与 Data 顶层 ExtJson', async () => {
    const { svc } = makeYunqiService(
      {
        ExtJson: '{"trace":"abc"}',
        Items: [{ ForumId: 'F-1', ExtJson: '{"seat":"A1"}' }, { ForumId: 'F-2' }],
      },
      ACTION,
    );
    const result = await svc.listMyForumSubscriptions();
    expect(result.extJson).toBe('{"trace":"abc"}');
    expect(result.subscriptions[0].extJson).toBe('{"seat":"A1"}');
    expect(result.subscriptions[1].extJson).toBeUndefined();
  });

  it('ExtJson 缺省时顶层与条目均为 undefined', async () => {
    const { svc } = makeYunqiService({ Items: [{ ForumId: 'F-1' }] }, ACTION);
    const result = await svc.listMyForumSubscriptions();
    expect(result.extJson).toBeUndefined();
    expect(result.subscriptions[0].extJson).toBeUndefined();
  });

  it('Items 为空数组或缺失时返回空列表', async () => {
    const { svc: withEmptyItems } = makeYunqiService(subscriptionData({ Items: [] }), ACTION);
    const emptyItems = await withEmptyItems.listMyForumSubscriptions();
    expect(emptyItems.subscriptions).toEqual([]);

    const { svc: withoutItems } = makeYunqiService(subscriptionData({ Items: undefined }), ACTION);
    const missingItems = await withoutItems.listMyForumSubscriptions();
    expect(missingItems.subscriptions).toEqual([]);
  });

  it('Data 缺失时返回全零结果', async () => {
    const { svc } = makeYunqiService(undefined, ACTION);
    expect(await svc.listMyForumSubscriptions()).toEqual(emptyResult());
  });

  it('不再兼容旧版扁平数组与 JSON 字符串 Data', async () => {
    const { svc: arraySvc } = makeYunqiService(
      [
        {
          ForumId: 'F-1',
          ForumStartTime: '2026-09-01 09:00',
          ForumEndTime: '2026-09-01 12:00',
        },
      ],
      ACTION,
    );
    expect(await arraySvc.listMyForumSubscriptions()).toEqual(emptyResult());

    const { svc: stringSvc } = makeYunqiService('[{"ForumId":"F-1"}]', ACTION);
    expect(await stringSvc.listMyForumSubscriptions()).toEqual(emptyResult());
  });
});

describe('YunqiService.listForumSummaries', () => {
  const ACTION = 'ListForumSummaries';

  it('传入 forumId 时发送 ForumId 参数', async () => {
    const { svc, captured } = makeYunqiService([], ACTION);
    await svc.listForumSummaries('F-1');
    expect(captured.params).toEqual({ ForumId: 'F-1' });
  });

  it.each([undefined, ''])('forumId 为 %s 时不带任何业务参数', async (forumId) => {
    const { svc, captured } = makeYunqiService([], ACTION);
    await svc.listForumSummaries(forumId);
    expect(captured.params).toEqual({});
  });

  it('Data 为数组时逐项归一化', async () => {
    const { svc } = makeYunqiService(
      [
        { ForumId: 'F-1', Summary: '主论坛摘要', ExtJson: '{"a":1}' },
        { ForumId: 'F-2', Summary: '分论坛摘要' },
      ],
      ACTION,
    );
    const result = await svc.listForumSummaries();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ forumId: 'F-1', summary: '主论坛摘要', extJson: '{"a":1}' });
    expect(result[1].extJson).toBeUndefined();
  });

  it('ForumId/Summary 缺失时归一化为空字符串', async () => {
    const { svc } = makeYunqiService([{}], ACTION);
    const result = await svc.listForumSummaries();
    expect(result[0]).toEqual({ forumId: '', summary: '', extJson: undefined });
  });

  it('Data 为 { Items: [...] } 对象形态时同样归一化', async () => {
    const { svc } = makeYunqiService(
      { Items: [{ ForumId: 'F-1', Summary: '主论坛摘要', ExtJson: '{"a":1}' }] },
      ACTION,
    );
    const result = await svc.listForumSummaries();
    expect(result).toEqual([{ forumId: 'F-1', summary: '主论坛摘要', extJson: '{"a":1}' }]);
  });

  it('Data 为 { Items: [] } 时返回空列表', async () => {
    const { svc } = makeYunqiService({ Items: [] }, ACTION);
    expect(await svc.listForumSummaries()).toEqual([]);
  });

  it.each([undefined, '[{"ForumId":"F-1"}]'])(
    'Data 缺失或为不可识别形态（%s）时返回空列表',
    async (data) => {
      const { svc } = makeYunqiService(data, ACTION);
      expect(await svc.listForumSummaries()).toEqual([]);
    },
  );
});

describe('MaasPortal 业务错误信封（Code != 200）', () => {
  const invokers: Array<[string, (svc: YunqiService) => Promise<unknown>]> = [
    ['ListForums', (svc) => svc.listForums()],
    ['ListExhibitors', (svc) => svc.listExhibitors()],
    ['ListMyForumSubscriptions', (svc) => svc.listMyForumSubscriptions()],
    ['ListForumSummaries', (svc) => svc.listForumSummaries()],
    ['SubscribeForum', (svc) => svc.subscribeForum('F-1')],
    ['UnsubscribeForum', (svc) => svc.unsubscribeForum('F-1')],
  ];

  it.each(invokers)(
    '%s：业务 Code 与 Message 分别透出到 error.code / error.message',
    async (action, invoke) => {
      const { svc } = makeYunqiServiceRaw(
        { Message: 'The event has not started yet. Stay tuned.', Code: 403 },
        action,
      );
      await expect(invoke(svc)).rejects.toMatchObject({
        code: '403',
        message: 'The event has not started yet. Stay tuned.',
      });
    },
  );

  it.each(invokers)('%s：Code 为字符串形态时同样判定为失败', async (action, invoke) => {
    const { svc } = makeYunqiServiceRaw({ Code: '500', Message: 'server boom' }, action);
    await expect(invoke(svc)).rejects.toMatchObject({ code: '500', message: 'server boom' });
  });

  it.each(invokers)('%s：缺失 Code 时判定为失败', async (action, invoke) => {
    const { svc } = makeYunqiServiceRaw({ Data: null }, action);
    await expect(invoke(svc)).rejects.toMatchObject({
      code: 'UNKNOWN',
      message: `MaasPortal ${action} failed with code UNKNOWN`,
    });
  });

  it.each(invokers)('%s：Message 为空时使用兜底文案', async (action, invoke) => {
    const { svc } = makeYunqiServiceRaw({ Code: 400, Message: '' }, action);
    await expect(invoke(svc)).rejects.toMatchObject({
      code: '400',
      message: `MaasPortal ${action} failed with code 400`,
    });
  });

  it.each(invokers)('%s：信封为空时抛 EMPTY_RESPONSE', async (action, invoke) => {
    const { svc } = makeYunqiServiceRaw(null, action);
    await expect(invoke(svc)).rejects.toMatchObject({
      code: 'EMPTY_RESPONSE',
      message: `${action} returned an empty response`,
    });
  });

  it('抛出 CliError 且 exit code 为 1', async () => {
    const { svc } = makeYunqiServiceRaw({ Code: 403, Message: 'no permission' }, 'ListForums');
    await expect(svc.listForums()).rejects.toBeInstanceOf(CliError);
    await expect(svc.listForums()).rejects.toMatchObject({ exitCode: EXIT_CODES.GENERAL_ERROR });
  });

  it('detail 带上 action 与 RequestId 供 verbose 模式排查', async () => {
    const { svc } = makeYunqiServiceRaw(
      { Code: 403, Message: 'no permission', RequestId: 'req-abc' },
      'ListForums',
    );
    await expect(svc.listForums()).rejects.toMatchObject({
      detail: 'ListForums business code 403\n  RequestId: req-abc',
    });
  });
});

describe('YunqiService.subscribeForum / unsubscribeForum', () => {
  it('Data 为布尔 true 时返回 true，并发送 ForumId', async () => {
    const { svc, captured } = makeYunqiServiceRaw({ Code: 200, Data: true }, 'SubscribeForum');
    expect(await svc.subscribeForum('F-1')).toBe(true);
    expect(captured.params).toEqual({ ForumId: 'F-1' });
  });

  it("Data 为字符串 'true' 时返回 true（网关按 cspec 声明类型序列化）", async () => {
    const { svc } = makeYunqiServiceRaw({ Code: 200, Data: 'true' }, 'SubscribeForum');
    expect(await svc.subscribeForum('F-1')).toBe(true);
  });

  it('Data 为 false 时返回 false，不再因信封对象恒为 truthy 而误报成功', async () => {
    const { svc } = makeYunqiServiceRaw({ Code: 200, Data: false }, 'SubscribeForum');
    expect(await svc.subscribeForum('F-1')).toBe(false);
  });

  it('unsubscribeForum 发送 ForumId 并归一化布尔结果', async () => {
    const { svc, captured } = makeYunqiServiceRaw({ Code: 200, Data: true }, 'UnsubscribeForum');
    expect(await svc.unsubscribeForum('F-9')).toBe(true);
    expect(captured.params).toEqual({ ForumId: 'F-9' });
  });
});

function emptyData(): Record<string, unknown> {
  return { Total: 0, Page: 1, PageSize: 20, Items: [] };
}
