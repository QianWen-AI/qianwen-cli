/**
 * Tests for WorkspaceService — list workspaces and workspace limit number,
 * both via the envelope protocol gateway.
 *
 * The list-side response no longer carries the quota; the per-account limit
 * is fetched from a dedicated endpoint and folded into the result. Tests use
 * a small `routeMock` helper to dispatch envelope calls by API identifier.
 */
import { describe, it, expect } from 'vitest';
import { WorkspaceService } from '../../src/services/workspace-service.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';

const LIST_API = 'zeldaEasy.bailian-dash-workspace.space.listWorkspaces4Agent';
const LIMIT_API = 'zeldaEasy.bailian-dash-workspace.space.getWorkspaceLimitNumber';

interface Routes {
  list?: unknown;
  limit?: unknown;
}

/** Build an ApiClient mock whose envelope handler dispatches by `api` field. */
function routeMock(routes: Routes) {
  return makeMockApiClient({
    envelope: async (opts) => {
      if (opts.api === LIST_API) return routes.list;
      if (opts.api === LIMIT_API) return routes.limit;
      throw new Error(`Unexpected api: ${opts.api}`);
    },
  });
}

describe('WorkspaceService.list', () => {
  it('calls the envelope listWorkspaces4Agent API and normalises items', async () => {
    let listOpts: { api: string; data?: unknown } | undefined;
    const api = makeMockApiClient({
      envelope: async (opts) => {
        if (opts.api === LIST_API) {
          listOpts = opts;
          return {
            totalCount: 2,
            data: [
              {
                id: 'ws-1',
                name: 'Production',
                region: 'cn-hangzhou',
                createdAt: '2026-04-01',
                isDefault: true,
              },
              {
                workspaceId: 'ws-2',
                agentName: 'Staging',
                workspaceRegion: 'cn-shanghai',
                createTime: '2026-04-15',
                defaultAgent: false,
              },
            ],
          };
        }
        if (opts.api === LIMIT_API) return { max: 50 };
        throw new Error(`Unexpected api: ${opts.api}`);
      },
    });
    const svc = new WorkspaceService(api);

    const out = await svc.list();
    expect(listOpts?.data).toEqual({ pageNo: 1, pageSize: 200 });
    expect(out.total).toBe(2);
    expect(out.limit).toBe(50);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toEqual({
      id: 'ws-1',
      name: 'Production',
      region: 'cn-hangzhou',
      createdAt: '2026-04-01',
      isDefault: true,
      tenantId: 0,
    });
    expect(out.items[1]).toEqual({
      id: 'ws-2',
      name: 'Staging',
      region: 'cn-shanghai',
      createdAt: '2026-04-15',
      isDefault: false,
      tenantId: 0,
    });
  });

  it('falls back through data → items, totalCount → total → items.length', async () => {
    const api = routeMock({
      list: { items: [{ id: 'ws-only' }], total: 1 },
      limit: null,
    });
    const out = await new WorkspaceService(api).list();
    expect(out.total).toBe(1);
    expect(out.items[0]?.id).toBe('ws-only');
    expect(out.limit).toBe(0);
  });

  it('returns empty defaults when both upstreams return null', async () => {
    const api = routeMock({ list: null, limit: null });
    const out = await new WorkspaceService(api).list();
    expect(out).toEqual({ items: [], total: 0, limit: 0 });
  });

  it('handles non-string nullable fields with empty defaults', async () => {
    const api = routeMock({ list: { data: [{}] }, limit: null });
    const out = await new WorkspaceService(api).list();
    expect(out.items[0]).toEqual({
      id: '',
      name: '',
      region: '',
      createdAt: '',
      isDefault: false,
      tenantId: 0,
    });
  });

  it('queries both list and limit endpoints in parallel', async () => {
    const api = routeMock({
      list: { data: [{ id: 'ws-1' }], totalCount: 1 },
      limit: { max: 25 },
    });
    const out = await new WorkspaceService(api).list();
    expect(out.limit).toBe(25);
    expect(out.total).toBe(1);
    // Both endpoints must have been hit.
    const calledApis = api.callEnvelopeApi.mock.calls.map((c) => (c[0] as { api: string }).api);
    expect(calledApis).toEqual(expect.arrayContaining([LIST_API, LIMIT_API]));
    expect(calledApis).toHaveLength(2);
  });

  it('reads quota.result as a fallback for max when folding into list.limit', async () => {
    const api = routeMock({
      list: { data: [], totalCount: 0 },
      limit: { result: 12 },
    });
    const out = await new WorkspaceService(api).list();
    expect(out.limit).toBe(12);
  });

  it('treats a bare-number quota response as the list.limit', async () => {
    const api = routeMock({
      list: { data: [], totalCount: 0 },
      limit: 7,
    });
    const out = await new WorkspaceService(api).list();
    expect(out.limit).toBe(7);
  });

  it('propagates errors from the gateway', async () => {
    const api = makeMockApiClient({
      envelope: async () => {
        throw new Error('NETWORK_TIMEOUT: failed');
      },
    });
    await expect(new WorkspaceService(api).list()).rejects.toThrow(/NETWORK_TIMEOUT/);
  });
});

describe('WorkspaceService.limit', () => {
  it('reads { current, max } from a structured response, preferring data.current', async () => {
    const api = routeMock({
      list: { data: [{ id: 'ws-1' }], totalCount: 3 },
      limit: { current: 7, max: 100 },
    });
    const out = await new WorkspaceService(api).limit();
    expect(out).toEqual({ current: 7, max: 100 });
  });

  it('derives current from list total when quota lacks current field', async () => {
    const api = routeMock({
      list: { data: [{ id: 'ws-1' }, { id: 'ws-2' }], totalCount: 2 },
      limit: { max: 50 },
    });
    const out = await new WorkspaceService(api).limit();
    expect(out).toEqual({ current: 2, max: 50 });
  });

  it('treats a bare number response as the max, current from list total', async () => {
    const api = routeMock({
      list: { data: [{ id: 'ws-1' }], totalCount: 1 },
      limit: 42,
    });
    const out = await new WorkspaceService(api).limit();
    expect(out).toEqual({ current: 1, max: 42 });
  });

  it('falls back to max → result for the upper bound', async () => {
    const api = routeMock({
      list: { data: [], totalCount: 0 },
      limit: { result: 25 },
    });
    const out = await new WorkspaceService(api).limit();
    expect(out).toEqual({ current: 0, max: 25 });
  });

  it('returns zeroed defaults when raw is null', async () => {
    const api = routeMock({ list: null, limit: null });
    const out = await new WorkspaceService(api).limit();
    expect(out).toEqual({ current: 0, max: 0 });
  });

  it('returns 0 max when bare-number response is non-finite', async () => {
    const api = routeMock({ list: { data: [], totalCount: 0 }, limit: Number.NaN });
    const out = await new WorkspaceService(api).limit();
    expect(out).toEqual({ current: 0, max: 0 });
  });
});
