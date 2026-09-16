/**
 * Integration coverage for the yunqi request path.
 *
 * The command-layer tests stub the service factory and the service tests stub
 * `callFlatApi`, so nothing verified the two seams between them: that
 * `createServices()` actually registers `yunqiService` (it was missing from the
 * mock container's slot list, which is how that gap stayed hidden), and that a
 * real ApiClient turns a `listForums` call into the correct Type A gateway
 * envelope. This drives the real container against a stubbed fetch.
 *
 * The endpoint is overridden to the mock domain via QIANWEN_API_ENDPOINT, which
 * request-adapter honours outside production builds. GATEWAY_URL is a
 * module-level constant, so the variable has to be set before any import that
 * pulls in the adapter — hence vi.hoisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetch, type MockFetch } from '../helpers/http-mock.js';

const MOCK_HOST = 'api.test.qianwenai.com';
const MOCK_ENDPOINT = `https://${MOCK_HOST}`;

vi.hoisted(() => {
  process.env.QIANWEN_API_ENDPOINT = 'https://api.test.qianwenai.com';
});

const credentialState: { value: { access_token: string } | null } = {
  value: { access_token: 'fake-bearer-token-1234567890ABCDEF' },
};

vi.mock('../../src/auth/credentials.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCredentials: vi.fn(() => credentialState.value),
  };
});

import { createServices } from '../../src/services/index.js';

/** Wrap a MaasPortal business envelope in the outer Type A gateway envelope. */
function gatewayReply(business: unknown) {
  return { code: '200', data: business };
}

let active: MockFetch | null = null;

beforeEach(() => {
  credentialState.value = { access_token: 'fake-bearer-token-1234567890ABCDEF' };
});

afterEach(() => {
  active?.restore();
  active = null;
});

function requestBody(): Record<string, unknown> {
  expect(active?.calls, 'no request was made').toHaveLength(1);
  const body = active?.calls[0]?.body;
  expect(body, 'request had no body').toBeDefined();
  return JSON.parse(body as string) as Record<string, unknown>;
}

describe('yunqi 集成：容器注册与网关信封', () => {
  it('createServices 注册了 yunqiService', () => {
    expect(createServices().yunqiService).toBeDefined();
  });

  it('listForums 发出 Type A 信封，携带 MaasPortal/ListForums 与 cn-beijing', async () => {
    active = mockFetch({
      [MOCK_HOST]: gatewayReply({
        Code: 200,
        Message: 'success',
        Data: { Total: 1, Page: 2, PageSize: 20, Items: [] },
      }),
    });

    await createServices().yunqiService.listForums({ page: 2, pageSize: 20 });

    expect(active.calls[0]?.method).toBe('POST');
    expect(active.calls[0]?.url).toBe(`${MOCK_ENDPOINT}/data/v2/api.json`);

    const body = requestBody();
    expect(body.product).toBe('MaasPortal');
    expect(body.action).toBe('ListForums');
    expect(body.region).toBe('cn-beijing');
    // flattenParams stringifies scalars on the wire.
    expect(body.params).toMatchObject({ Page: '2', PageSize: '20' });
  });

  it('附带 Bearer 认证头', async () => {
    active = mockFetch({
      [MOCK_HOST]: gatewayReply({ Code: 200, Data: { Items: [] } }),
    });
    await createServices().yunqiService.listForums();
    expect(active.calls[0]?.headers?.Authorization).toBe(
      'Bearer fake-bearer-token-1234567890ABCDEF',
    );
  });

  it('完整解析并归一化响应，Subscribable 的 JSON 布尔形态也生效', async () => {
    active = mockFetch({
      [MOCK_HOST]: gatewayReply({
        Code: 200,
        Message: 'success',
        Data: {
          Total: 2,
          Page: 1,
          PageSize: 20,
          Items: [
            { ForumId: 'F-1', DisplayName: '主论坛', Subscribable: true, ExtJson: '{"a":1}' },
            { ForumId: 'F-2', DisplayName: '分论坛', Subscribable: 'false' },
          ],
        },
      }),
    });

    const result = await createServices().yunqiService.listForums();

    expect(result.total).toBe(2);
    expect(result.forums[0]).toMatchObject({
      id: 'F-1',
      name: '主论坛',
      subscribable: true,
      extJson: '{"a":1}',
    });
    expect(result.forums[1].subscribable).toBe(false);
  });

  it('展商的 Enabled 以 JSON 布尔形态上线', async () => {
    active = mockFetch({
      [MOCK_HOST]: gatewayReply({ Code: 200, Data: { Items: [] } }),
    });
    await createServices().yunqiService.listExhibitors({ enabled: true, hallName: '算力馆' });
    expect(requestBody().params).toMatchObject({ Enabled: 'true', HallName: '算力馆' });
  });

  it('展商条目的嵌套 Exhibits 经真实容器完整归一化', async () => {
    active = mockFetch({
      [MOCK_HOST]: gatewayReply({
        Code: 200,
        Data: {
          Total: 1,
          Page: 1,
          PageSize: 20,
          Items: [
            {
              Exhibits: [
                {
                  ExhibitId: 'X-1',
                  ExhibitCode: 'C-1',
                  Name: '通义千问',
                  Hall: { Code: 'H1', Name: '算力馆' },
                  Zone: { Code: 'Z1', Name: '云智能展区' },
                  Booth: { Code: 'B12', Name: 'A12' },
                },
                { ExhibitId: 'X-2' },
              ],
              ExtJson: '{"k":"v"}',
            },
          ],
        },
      }),
    });

    const result = await createServices().yunqiService.listExhibitors();

    expect(result.total).toBe(1);
    expect(result.exhibitors[0].extJson).toBe('{"k":"v"}');
    expect(result.exhibitors[0].exhibits).toHaveLength(2);
    expect(result.exhibitors[0].exhibits?.[0]).toMatchObject({
      exhibitId: 'X-1',
      name: '通义千问',
      hall: { code: 'H1', name: '算力馆' },
      booth: { code: 'B12', name: 'A12' },
    });
  });

  it('业务 Code 非 200 时透出后端 code 与 message', async () => {
    active = mockFetch({
      [MOCK_HOST]: gatewayReply({
        Code: 403,
        Message: 'The event has not started yet. Stay tuned.',
        RequestId: 'req-1',
      }),
    });

    await expect(createServices().yunqiService.listForums()).rejects.toMatchObject({
      code: '403',
      message: 'The event has not started yet. Stay tuned.',
    });
  });

  it('网关外层 code 非 200 时按网关错误处理', async () => {
    active = mockFetch({
      [MOCK_HOST]: { body: { code: '500', message: 'gateway boom' }, init: { status: 200 } },
    });
    await expect(createServices().yunqiService.listForums()).rejects.toBeDefined();
  });

  it('订阅与摘要走各自的 action', async () => {
    active = mockFetch({
      [MOCK_HOST]: gatewayReply({ Code: 200, Data: { Items: [], UnviewedCount: 0 } }),
    });
    const { yunqiService } = createServices();
    await yunqiService.listMyForumSubscriptions();
    expect(requestBody().action).toBe('ListMyForumSubscriptions');

    active.restore();
    active = mockFetch({ [MOCK_HOST]: gatewayReply({ Code: 200, Data: [] }) });
    await yunqiService.listForumSummaries('F-9');
    const body = requestBody();
    expect(body.action).toBe('ListForumSummaries');
    expect(body.params).toMatchObject({ ForumId: 'F-9' });
  });
});
