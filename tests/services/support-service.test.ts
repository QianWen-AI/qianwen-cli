/**
 * Tests for SupportService — read + write operations against the Workorder
 * flat-parameter API. The service performs heavy field normalization for
 * mixed-casing payloads; tests focus on the public observable shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SupportService,
  mapTicketStatus,
  deriveSchemaText,
} from '../../src/services/support-service.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';

// Mock the config layer so getCategoryTree() can pick a deterministic strategy
// for each scenario (default = embedded snapshot, 'cli-api' = legacy gateway,
// http(s) URL = CDN fetch). Other service methods are unaffected.
const mockConfig = {
  'output.format': 'auto',
  'api.endpoint': 'https://api.test.qianwen.com',
  'auth.endpoint': 'https://auth.test.qianwen.com',
  'cache.ttl': '0',
  'support.categorySource': '',
};

vi.mock('../../src/config/manager.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveConfig: vi.fn(() => ({ ...mockConfig })),
  };
});

beforeEach(() => {
  mockConfig['support.categorySource'] = '';
});

// ────────────────────────────────────────────────────────────────────
// mapTicketStatus
// ────────────────────────────────────────────────────────────────────

describe('mapTicketStatus', () => {
  it('maps known canonical codes to display strings', () => {
    expect(mapTicketStatus('wait_assign')).toBe('Pending assignment');
    expect(mapTicketStatus('dealing')).toBe('Processing');
    expect(mapTicketStatus('confirmed')).toBe('Closed');
    expect(mapTicketStatus('robot_processing')).toBe('Processing');
  });

  it('returns Unknown for empty input', () => {
    expect(mapTicketStatus('')).toBe('Unknown');
  });

  it('title-cases unknown statuses with underscores → spaces', () => {
    expect(mapTicketStatus('weird_state_here')).toBe('Weird state here');
  });
});

// ────────────────────────────────────────────────────────────────────
// deriveSchemaText (iter-77: system message Schema-derived content)
// ────────────────────────────────────────────────────────────────────

describe('deriveSchemaText', () => {
  it('collects title and desc from each property x-component-props', () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        turnToAritificial: {
          'x-component-props': {
            title: 'We have assigned an engineer to you',
            desc: 'Our engineer will reply as soon as possible.',
          },
        },
      },
    });
    const text = deriveSchemaText(schema);
    expect(text).toContain('We have assigned an engineer to you');
    expect(text).toContain('Our engineer will reply as soon as possible.');
  });

  it('returns empty string for absent, empty, or unparseable schema', () => {
    expect(deriveSchemaText(undefined)).toBe('');
    expect(deriveSchemaText('')).toBe('');
    expect(deriveSchemaText('not json')).toBe('');
    expect(deriveSchemaText('{}')).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────
// listTickets
// ────────────────────────────────────────────────────────────────────

describe('SupportService.listTickets', () => {
  it('issues Workorder/ListTickets with serialised Params and clamps page bounds', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.product).toBe('Workorder');
        expect(opts.action).toBe('ListTickets');
        expect(opts.params).toMatchObject({
          Params: JSON.stringify({ CustomerLimit: false }),
          Page: 1,
          PageSize: 10,
          IndependentSiteTag: 'qianwenai',
        });
        return {
          Data: {
            Total: 2,
            DataInfo: [
              {
                vid: 'tk-1',
                title: 'Issue 1',
                statTicketBiz: 'dealing',
                createTime: 1717200000000,
              },
              {
                vid: 'tk-2',
                title: 'Issue 2',
                statTicketBiz: 'confirmed',
                createTime: 1717286400000,
              },
            ],
          },
        };
      },
    });
    const out = await new SupportService(api).listTickets({});
    expect(out.total).toBe(2);
    expect(out.page).toBe(1);
    expect(out.pageSize).toBe(10);
    expect(out.tickets).toEqual([
      { id: 'tk-1', title: 'Issue 1', status: 'dealing', createdAt: 1717200000000 },
      { id: 'tk-2', title: 'Issue 2', status: 'confirmed', createdAt: 1717286400000 },
    ]);
  });

  it('clamps page<1 to 1 and pageSize beyond 10 to 10', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.params).toMatchObject({ Page: 1, PageSize: 10 });
        return {};
      },
    });
    const out = await new SupportService(api).listTickets({ page: 0, pageSize: 999 });
    expect(out.page).toBe(1);
    expect(out.pageSize).toBe(10);
  });

  it('honors a custom siteTag', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.params).toMatchObject({ IndependentSiteTag: 'custom-site' });
        return {};
      },
    });
    await new SupportService(api).listTickets({ siteTag: 'custom-site' });
  });

  it('returns empty defaults for null upstream response', async () => {
    const api = makeMockApiClient({ flat: async () => null });
    const out = await new SupportService(api).listTickets({});
    expect(out.tickets).toEqual([]);
    expect(out.total).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// getTicket
// ────────────────────────────────────────────────────────────────────

describe('SupportService.getTicket', () => {
  it('parses Values payload (PascalCase Values, status.value)', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.params).toEqual({ TicketId: 'tk-1', Region: '7' });
        return {
          Data: {
            Values: {
              vid: 'tk-1',
              title: 'My title',
              status: { value: 'dealing' },
              gmt_create: 1717200000000,
              category: 'Billing',
              description: 'Body text',
            },
          },
        };
      },
    });
    const out = await new SupportService(api).getTicket('tk-1');
    expect(out).toEqual({
      id: 'tk-1',
      title: 'My title',
      status: 'dealing',
      createdAt: 1717200000000,
      category: 'Billing',
      description: 'Body text',
    });
  });

  it('falls back to status.label when status.value is missing', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: {
          values: { status: { label: 'Pending confirmation' } },
        },
      }),
    });
    const out = await new SupportService(api).getTicket('tk-2');
    expect(out.status).toBe('Pending confirmation');
  });

  it('falls back through category → ProductName → ProcessStage.label', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: {
          Values: { vid: 'tk-3', ProcessStage: { label: 'Stage X' } },
        },
      }),
    });
    const out = await new SupportService(api).getTicket('tk-3');
    expect(out.category).toBe('Stage X');
  });

  it('throws NOT_FOUND when Values is missing entirely', async () => {
    // iter-72 (BUG-2): an unidentifiable ticket payload is a not-found error,
    // not a blank placeholder shell.
    const api = makeMockApiClient({ flat: async () => ({ Data: {} }) });
    await expect(new SupportService(api).getTicket('tk-4')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// listMessages
// ────────────────────────────────────────────────────────────────────

describe('SupportService.listMessages', () => {
  it('normalises numeric roles, falls back through user-name fields, marks truncated when at page limit', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      UserInfo: { Role: i === 0 ? 1 : i === 1 ? 2 : 3, UserName: `user-${i}` },
      DataInfo: { Content: `msg ${i}` },
      CreateTime: 1717200000000 + i,
    }));
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.params).toEqual({ TicketId: 'tk-1', PageLimit: 100 });
        return { Data: { DataList: items } };
      },
    });
    const out = await new SupportService(api).listMessages('tk-1');
    expect(out.messages).toHaveLength(100);
    expect(out.truncated).toBe(true);
    expect(out.messages[0]?.role).toBe('system');
    expect(out.messages[1]?.role).toBe('agent');
    expect(out.messages[2]?.role).toBe('customer');
    expect(out.messages[0]?.nickName).toBe('user-0');
    expect(out.messages[0]?.content).toBe('msg 0');
  });

  it('uses camelCase dataList when DataList is missing and string role pass-through', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: {
          dataList: [
            {
              userInfo: { role: 'admin', displayName: 'Boss' },
              dataInfo: { content: 'hello' },
              gmtCreate: 1717286400000,
            },
          ],
        },
      }),
    });
    const out = await new SupportService(api).listMessages('tk-2');
    expect(out.messages).toEqual([
      { role: 'admin', nickName: 'Boss', content: 'hello', createdAt: 1717286400000 },
    ]);
    expect(out.truncated).toBe(false);
  });

  it('coerces unknown numeric role to its string form', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: { DataList: [{ UserInfo: { Role: 9 }, DataInfo: { Content: 'x' } }] },
      }),
    });
    const out = await new SupportService(api).listMessages('tk-3');
    expect(out.messages[0]?.role).toBe('9');
  });

  it('returns empty list when DataList is missing', async () => {
    const api = makeMockApiClient({ flat: async () => ({ Data: {} }) });
    const out = await new SupportService(api).listMessages('tk-4');
    expect(out.messages).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// getTicketDetail (parallel composition)
// ────────────────────────────────────────────────────────────────────

describe('SupportService.getTicketDetail', () => {
  it('fans detail+messages out concurrently and returns a single object', async () => {
    const callOrder: string[] = [];
    const api = makeMockApiClient({
      flat: async (opts) => {
        callOrder.push(opts.action);
        if (opts.action === 'GetTicket') {
          return { Data: { Values: { vid: 'tk-1', title: 'T' } } };
        }
        if (opts.action === 'ListEnhancedMessage') {
          return { Data: { DataList: [] } };
        }
        return null;
      },
    });
    const out = await new SupportService(api).getTicketDetail('tk-1');
    expect(out.detail.id).toBe('tk-1');
    expect(out.messages.messages).toEqual([]);
    expect(callOrder.sort()).toEqual(['GetTicket', 'ListEnhancedMessage']);
  });
});

// ────────────────────────────────────────────────────────────────────
// getCategoryTree
// ────────────────────────────────────────────────────────────────────

describe('SupportService.getCategoryTree', () => {
  it('returns the embedded local snapshot when support.categorySource is empty (default)', async () => {
    const flat = vi.fn(async () => ({}));
    const api = makeMockApiClient({ flat });
    const out = await new SupportService(api).getCategoryTree();

    // No network call: the legacy gateway must not be touched.
    expect(flat).not.toHaveBeenCalled();

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: '__app_group_0', name: '模型' });
    expect(out[0]?.children?.[0]).toEqual({ id: '582262', name: '账单计费' });
    expect(out[1]?.children?.find((c) => c.id === 'qianwen')).toEqual({
      id: 'qianwen',
      name: '千问',
      helpUrl: 'https://www.qianwen.com',
    });
  });

  it('serialises productCodes and recursively normalises children when source = cli-api', async () => {
    mockConfig['support.categorySource'] = 'cli-api';
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('GetCategoryTreeByProductCodes');
        expect(opts.params).toEqual({
          ProductCodes: JSON.stringify(['bailian']),
        });
        return {
          Data: [
            {
              id: 'c-1',
              name: 'Root',
              children: [
                { Id: 'c-2', Name: 'Child', subCategoryList: [{ id: 'c-3', name: 'GC' }] },
              ],
            },
          ],
        };
      },
    });
    const out = await new SupportService(api).getCategoryTree();
    expect(out).toEqual([
      {
        id: 'c-1',
        name: 'Root',
        children: [
          {
            id: 'c-2',
            name: 'Child',
            children: [{ id: 'c-3', name: 'GC' }],
          },
        ],
      },
    ]);
  });

  it('reads from Data.List when Data is an object (cli-api)', async () => {
    mockConfig['support.categorySource'] = 'cli-api';
    const api = makeMockApiClient({
      flat: async () => ({ Data: { List: [{ id: 'c-x', name: 'X' }] } }),
    });
    const out = await new SupportService(api).getCategoryTree();
    expect(out).toEqual([{ id: 'c-x', name: 'X' }]);
  });

  it('returns empty array when Data is missing (cli-api)', async () => {
    mockConfig['support.categorySource'] = 'cli-api';
    const api = makeMockApiClient({ flat: async () => null });
    const out = await new SupportService(api).getCategoryTree();
    expect(out).toEqual([]);
  });

  it('fetches and normalises CDN payload when source is an http(s) URL', async () => {
    mockConfig['support.categorySource'] = 'https://cdn.test.qianwen.com/category-tree.json';
    const flat = vi.fn(async () => ({}));
    const api = makeMockApiClient({ flat });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        list: [
          {
            value: 'g-0',
            label: 'Group 0',
            children: [
              { value: 'c-1', label: 'Cat 1', helpUrl: 'https://help/1' },
              { value: 'c-2', label: 'Cat 2', helpUrl: '' },
            ],
          },
        ],
      }),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const out = await new SupportService(api).getCategoryTree();
      expect(fetchMock).toHaveBeenCalledWith('https://cdn.test.qianwen.com/category-tree.json');
      expect(flat).not.toHaveBeenCalled();
      expect(out).toEqual([
        {
          id: 'g-0',
          name: 'Group 0',
          children: [
            { id: 'c-1', name: 'Cat 1', helpUrl: 'https://help/1' },
            { id: 'c-2', name: 'Cat 2' },
          ],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws CliError when CDN fetch fails', async () => {
    mockConfig['support.categorySource'] = 'https://cdn.test.qianwen.com/category-tree.json';
    const api = makeMockApiClient({ flat: async () => ({}) });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(new SupportService(api).getCategoryTree()).rejects.toMatchObject({
        code: 'SUPPORT_CATEGORY_SOURCE_FETCH_FAILED',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// suggestCategory
// ────────────────────────────────────────────────────────────────────

describe('SupportService.suggestCategory', () => {
  it('limits to 5 suggestions and normalises field casing', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      categoryId: i,
      categoryName: `Cat ${i}`,
      categoryPath: `/p/${i}`,
      score: 0.9 - i * 0.1,
    }));
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('SuggestCategoryNew');
        expect(opts.params).toMatchObject({
          Channel: 'ticket_pc_v2',
          Content: 'help me',
          AnswerView: 5,
          SceneCategoryMode: 'KNOWLEDGE',
        });
        return { Data: items };
      },
    });
    const out = await new SupportService(api).suggestCategory('help me');
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({
      categoryId: '0',
      categoryName: 'Cat 0',
      categoryPath: '/p/0',
      score: 0.9,
    });
  });

  it('reads from Data.Suggestions when present', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: {
          Suggestions: [{ CategoryId: 'A', CategoryName: 'Alpha', Path: '/A', Score: 1 }],
        },
      }),
    });
    const out = await new SupportService(api).suggestCategory('foo');
    expect(out).toEqual([{ categoryId: 'A', categoryName: 'Alpha', categoryPath: '/A', score: 1 }]);
  });

  it('reads from Data.suggestCategoryDtos (live API field)', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: {
          suggestCategoryDtos: [
            { categoryId: 'B', categoryName: 'Beta', categoryPath: '/B', score: 0.8 },
          ],
        },
      }),
    });
    const out = await new SupportService(api).suggestCategory('foo');
    expect(out).toEqual([
      { categoryId: 'B', categoryName: 'Beta', categoryPath: '/B', score: 0.8 },
    ]);
  });

  it('reads from top-level suggestCategoryDtos when gateway unwraps Data', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        traceId: 't-1',
        suggestCategoryDtos: [
          { categoryId: 'C', categoryName: 'Gamma', categoryPath: '/C', score: 0.7 },
        ],
      }),
    });
    const out = await new SupportService(api).suggestCategory('foo');
    expect(out).toEqual([
      { categoryId: 'C', categoryName: 'Gamma', categoryPath: '/C', score: 0.7 },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// createTicket / createMessage / cancelTicket
// ────────────────────────────────────────────────────────────────────

describe('SupportService write operations', () => {
  it('createTicket forwards canonical params and reads vid from Data.vid', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('CreateTicketNew');
        expect(opts.params).toMatchObject({
          CategoryId: 'c-1',
          Severity: '1',
          Description: 'desc',
          ServiceLinkVersion: 'V2',
          DirectLabor: 'true',
          IfServiceQuota: 'true',
          IndependentSiteTag: 'qianwenai',
        });
        return { Data: { vid: 'tk-new' } };
      },
    });
    const out = await new SupportService(api).createTicket({
      categoryId: 'c-1',
      description: 'desc',
    });
    expect(out).toEqual({ vid: 'tk-new' });
  });

  it('createTicket reads string Data as vid', async () => {
    const api = makeMockApiClient({ flat: async () => ({ Data: 'tk-string' }) });
    const out = await new SupportService(api).createTicket({
      categoryId: 'c-1',
      description: 'd',
    });
    expect(out.vid).toBe('tk-string');
  });

  it('createMessage forwards TicketId+Content and resolves to undefined', async () => {
    const captured: CallFlatApiOptions[] = [];
    const api = makeMockApiClient({
      flat: async (opts) => {
        captured.push(opts);
        return null;
      },
    });
    await new SupportService(api).createMessage('tk-1', 'reply');
    expect(captured[0]?.action).toBe('CreateMessage');
    expect(captured[0]?.params).toEqual({ TicketId: 'tk-1', Content: 'reply' });
  });

  it('cancelTicket dispatches the right action', async () => {
    const actions: string[] = [];
    const api = makeMockApiClient({
      flat: async (opts) => {
        actions.push(opts.action);
        return null;
      },
    });
    const svc = new SupportService(api);
    await svc.cancelTicket('tk-1');
    expect(actions).toEqual(['CancelTicket']);
  });
});

// ────────────────────────────────────────────────────────────────────
// getAssessmentCard — tag coercion (rate render crash regression)
// ────────────────────────────────────────────────────────────────────

describe('SupportService.getAssessmentCard', () => {
  function cardResponse(goodSource: unknown, badSource: unknown) {
    return {
      Data: {
        DataInfo: {
          Editable: 1,
          Props: [
            {
              name: 'overall',
              value: {
                schema: {
                  properties: {
                    overall: {
                      'x-component-props': {
                        goodDataSource: goodSource,
                        badDataSource: badSource,
                        isStar: false,
                      },
                    },
                  },
                },
              },
            },
          ],
          Values: { schemaId: 1, biz_type: 'qianwenai', cardBizId: 'cb-1', dialogId: 9 },
        },
      },
    };
  }

  it('coerces object-shaped tags to strings so the Ink tag picker never sees objects', async () => {
    const api = makeMockApiClient({
      flat: async () =>
        cardResponse(
          ['服务态度好', { label: '解决方案有效' }, { value: '处理速度快' }, 42, null],
          [{ text: '响应慢' }, '方案无效'],
        ),
    });
    const card = await new SupportService(api).getAssessmentCard('tk-1');
    expect(card.goodTags).toEqual(['服务态度好', '解决方案有效', '处理速度快']);
    expect(card.badTags).toEqual(['响应慢', '方案无效']);
    // Every tag must be a plain string — objects here crash <Text> at render.
    for (const t of [...card.goodTags, ...card.badTags]) {
      expect(typeof t).toBe('string');
    }
  });

  it('falls back to default Chinese tags when the schema yields no usable strings', async () => {
    const api = makeMockApiClient({ flat: async () => cardResponse([{ unknownKey: 'x' }], []) });
    const card = await new SupportService(api).getAssessmentCard('tk-1');
    expect(card.goodTags.length).toBeGreaterThan(0);
    expect(card.badTags.length).toBeGreaterThan(0);
    expect(card.goodTags.every((t) => typeof t === 'string')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// identifyRiskWord — multi-shape response detection
// ────────────────────────────────────────────────────────────────────

describe('SupportService.identifyRiskWord', () => {
  it('returns hasRisk=true when Data is an array of words', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Data: ['badword'] }),
    });
    const out = await new SupportService(api).identifyRiskWord('tk-1', 'foo');
    expect(out).toEqual({ hasRisk: true, words: ['badword'] });
  });

  it('returns hasRisk=false when Data is empty array', async () => {
    const api = makeMockApiClient({ flat: async () => ({ Data: [] }) });
    const out = await new SupportService(api).identifyRiskWord('tk-1', 'foo');
    expect(out).toEqual({ hasRisk: false, words: [] });
  });

  it('returns hasRisk from boolean Data', async () => {
    const api = makeMockApiClient({ flat: async () => ({ Data: true }) });
    expect(await new SupportService(api).identifyRiskWord('tk-1', 'x')).toEqual({ hasRisk: true });
  });

  it('reads hasRisk + words from Data object', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Data: { hasRisk: true, words: ['w1', 'w2'] } }),
    });
    expect(await new SupportService(api).identifyRiskWord('tk-1', 'x')).toEqual({
      hasRisk: true,
      words: ['w1', 'w2'],
    });
  });

  it('infers hasRisk from words.length when hasRisk is missing', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Data: { Words: ['w'] } }),
    });
    expect(await new SupportService(api).identifyRiskWord('tk-1', 'x')).toEqual({
      hasRisk: true,
      words: ['w'],
    });
  });

  it('returns hasRisk=false when Data is null/empty', async () => {
    const api = makeMockApiClient({ flat: async () => ({}) });
    expect(await new SupportService(api).identifyRiskWord('tk-1', 'x')).toEqual({ hasRisk: false });
  });
});

// ────────────────────────────────────────────────────────────────────
// Error propagation
// ────────────────────────────────────────────────────────────────────

describe('SupportService error propagation', () => {
  it('lets API errors surface from listTickets', async () => {
    const api = makeMockApiClient({
      flat: vi.fn(async () => {
        throw new Error('upstream-down');
      }),
    });
    await expect(new SupportService(api).listTickets({})).rejects.toThrow('upstream-down');
  });
});
