/**
 * Tests for FreetierService.
 *
 * The service has three integration points exercised here:
 *   1. CDN fetch for the model→templateCode mapping (via injected
 *      CachedFetcher → fallback to global fetch).
 *   2. ApiClient.callFlatApi('BssOpenAPI-V3', 'DescribeFqInstance', ...).
 *   3. Per-instance memoization (peekCachedQuota / rememberQuota).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FreetierService } from '../../src/services/freetier-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import type { Model } from '../../src/types/model.js';
import type { FqInstanceItem, FqInstanceResponse } from '../../src/types/api-models.js';

// ────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────

function makeModel(id: string, mode: 'standard' | 'none' = 'standard'): Model {
  return {
    id,
    name: id,
    free_tier: { mode, quota: null },
  } as Model;
}

function makeFqInstance(overrides: Partial<FqInstanceItem> = {}): FqInstanceItem {
  return {
    InstanceName: 'inst-1',
    Status: 'valid',
    Uid: 1,
    InitCapacity: { BaseValue: 1_000_000, ShowUnit: 'token', ShowValue: '1M tokens' },
    CurrCapacity: { BaseValue: 800_000, ShowUnit: 'token', ShowValue: '800k tokens' },
    Template: { Code: 'tpl-A', Name: 'Template A' },
    StartTime: '2025-01-01T00:00:00Z',
    EndTime: '2026-01-01T00:00:00Z',
    CurrentCycleStartTime: '2025-06-01T00:00:00Z',
    CurrentCycleEndTime: '2025-07-01T00:00:00Z',
    ...overrides,
  };
}

function makeFqResponse(items: FqInstanceItem[]): FqInstanceResponse {
  return {
    TotalCount: items.length,
    PageSize: 500,
    RequestId: 'req-1',
    CurrentPage: 1,
    Data: items,
  };
}

// Replace globalThis.fetch for the CDN call.
type FetchFn = typeof globalThis.fetch;
const originalFetch: FetchFn = globalThis.fetch;

function mockGlobalFetch(impl: FetchFn): void {
  globalThis.fetch = impl as FetchFn;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// fetchModelMapping
// ────────────────────────────────────────────────────────────────────

describe('FreetierService.fetchModelMapping', () => {
  it('returns parsed JSON from CDN on success', async () => {
    const expected = { 'qwen-plus': 'tpl-A', 'qwen-max': 'tpl-B' };
    mockGlobalFetch(
      vi.fn(
        async () =>
          new Response(JSON.stringify(expected), {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
          }),
      ) as FetchFn,
    );

    const apiClient = makeMockApiClient();
    const cache = makeMockCachedFetcher();
    const svc = new FreetierService(apiClient, cache);

    const result = await svc.fetchModelMapping();
    expect(result).toEqual(expected);
    expect(cache.getOrFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty object when CDN returns non-2xx', async () => {
    mockGlobalFetch(
      vi.fn(
        async () => new Response('nope', { status: 502, statusText: 'Bad Gateway' }),
      ) as FetchFn,
    );

    const svc = new FreetierService(makeMockApiClient(), makeMockCachedFetcher());
    const result = await svc.fetchModelMapping();
    expect(result).toEqual({});
  });

  it('returns empty object on network failure', async () => {
    mockGlobalFetch(
      vi.fn(async () => {
        throw new Error('network down');
      }) as FetchFn,
    );

    const svc = new FreetierService(makeMockApiClient(), makeMockCachedFetcher());
    const result = await svc.fetchModelMapping();
    expect(result).toEqual({});
  });

  it('honors a cache hit and skips CDN entirely', async () => {
    const fetchSpy = vi.fn();
    mockGlobalFetch(fetchSpy as unknown as FetchFn);

    const cached = { 'qwen-plus': 'tpl-cached' };
    const cache = makeMockCachedFetcher({ hit: cached });
    const svc = new FreetierService(makeMockApiClient(), cache);

    const result = await svc.fetchModelMapping();
    expect(result).toEqual(cached);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// fetchFreeTierQuotas
// ────────────────────────────────────────────────────────────────────

describe('FreetierService.fetchFreeTierQuotas', () => {
  it('returns empty map for empty input without calling the API', async () => {
    const apiClient = makeMockApiClient();
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());
    const map = await svc.fetchFreeTierQuotas([]);
    expect(map.size).toBe(0);
    expect(apiClient.callFlatApi).not.toHaveBeenCalled();
  });

  it('issues callFlatApi with BssOpenAPI-V3/DescribeFqInstance and PageSize=500', async () => {
    const apiClient = makeMockApiClient({
      flat: async () => makeFqResponse([makeFqInstance()]),
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());
    await svc.fetchFreeTierQuotas(['tpl-A']);

    expect(apiClient.callFlatApi).toHaveBeenCalledTimes(1);
    const callArg = apiClient.callFlatApi.mock.calls[0][0];
    expect(callArg).toMatchObject({
      product: 'BssOpenAPI-V3',
      action: 'DescribeFqInstance',
      params: { templateCodes: ['tpl-A'], PageSize: 500 },
    });
  });

  it('keeps instances with Status valid|exhaust|expire', async () => {
    const apiClient = makeMockApiClient({
      flat: async () =>
        makeFqResponse([
          makeFqInstance({ Status: 'valid', Template: { Code: 'A', Name: 'A' } }),
          makeFqInstance({ Status: 'exhaust', Template: { Code: 'B', Name: 'B' } }),
          makeFqInstance({ Status: 'expire', Template: { Code: 'C', Name: 'C' } }),
          makeFqInstance({ Status: 'pending', Template: { Code: 'D', Name: 'D' } }),
        ]),
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());
    const map = await svc.fetchFreeTierQuotas(['A', 'B', 'C', 'D']);
    expect([...map.keys()].sort()).toEqual(['A', 'B', 'C']);
  });

  it('filters out instances with missing Template.Code or capacity payloads', async () => {
    const incomplete: FqInstanceItem[] = [
      makeFqInstance({
        Template: { Code: '', Name: 'Empty' },
      }),
      // Cast at the fixture boundary only — service must tolerate these.
      {
        ...makeFqInstance(),
        Template: { Code: 'X', Name: 'X' },
        InitCapacity: undefined as unknown as FqInstanceItem['InitCapacity'],
      },
      {
        ...makeFqInstance(),
        Template: { Code: 'Y', Name: 'Y' },
        CurrCapacity: undefined as unknown as FqInstanceItem['CurrCapacity'],
      },
      makeFqInstance({ Template: { Code: 'Z', Name: 'Z' } }),
    ];
    const apiClient = makeMockApiClient({
      flat: async () => makeFqResponse(incomplete),
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());
    const map = await svc.fetchFreeTierQuotas(['X', 'Y', 'Z']);
    expect([...map.keys()]).toEqual(['Z']);
  });

  it('returns empty map when API throws (no propagation)', async () => {
    const apiClient = makeMockApiClient({
      flat: async () => {
        throw new Error('upstream 5xx');
      },
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());
    const map = await svc.fetchFreeTierQuotas(['tpl-A']);
    expect(map.size).toBe(0);
  });

  it('tolerates a missing Data field (returns empty map)', async () => {
    const apiClient = makeMockApiClient({
      flat: async () => ({}) as FqInstanceResponse,
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());
    const map = await svc.fetchFreeTierQuotas(['tpl-A']);
    expect(map.size).toBe(0);
  });

  it('maps an instance into a FreeTierQuota with the expected shape', async () => {
    const apiClient = makeMockApiClient({
      flat: async () =>
        makeFqResponse([
          makeFqInstance({
            Status: 'valid',
            Template: { Code: 'tpl-A', Name: 'Template A' },
            InitCapacity: { BaseValue: 1000, ShowUnit: 'token', ShowValue: '1k' },
            CurrCapacity: { BaseValue: 250, ShowUnit: 'token', ShowValue: '250' },
            CurrentCycleEndTime: '2025-12-01T00:00:00Z',
          }),
        ]),
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());
    const map = await svc.fetchFreeTierQuotas(['tpl-A']);
    const quota = map.get('tpl-A');
    expect(quota).toBeDefined();
    expect(quota).toMatchObject({
      remaining: 250,
      total: 1000,
      status: 'valid',
      used_pct: 75,
    });
    expect(quota?.resetDate).toBe(new Date('2025-12-01T00:00:00Z').toISOString());
  });
});

// ────────────────────────────────────────────────────────────────────
// fetchQuotasForModels
// ────────────────────────────────────────────────────────────────────

describe('FreetierService.fetchQuotasForModels', () => {
  it('skips API entirely when no model has standard free-tier mode', async () => {
    const apiClient = makeMockApiClient();
    const cache = makeMockCachedFetcher();
    const svc = new FreetierService(apiClient, cache);

    const out = await svc.fetchQuotasForModels([makeModel('m1', 'none')]);
    expect(out).toHaveLength(1);
    expect(apiClient.callFlatApi).not.toHaveBeenCalled();
    expect(cache.getOrFetch).not.toHaveBeenCalled();
  });

  it('returns models unchanged when mapping has no entry for any free-tier model', async () => {
    mockGlobalFetch(
      vi.fn(
        async () => new Response(JSON.stringify({}), { status: 200, statusText: 'OK' }),
      ) as FetchFn,
    );
    const apiClient = makeMockApiClient();
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());

    const models = [makeModel('qwen-plus')];
    const out = await svc.fetchQuotasForModels(models);
    expect(out).toEqual(models);
    expect(apiClient.callFlatApi).not.toHaveBeenCalled();
  });

  it('attaches resolved quotas to matching models and leaves unmapped models intact', async () => {
    const mapping = { 'qwen-plus': 'tpl-A', 'qwen-max': 'tpl-A' };
    mockGlobalFetch(
      vi.fn(
        async () => new Response(JSON.stringify(mapping), { status: 200, statusText: 'OK' }),
      ) as FetchFn,
    );

    const apiClient = makeMockApiClient({
      flat: async () =>
        makeFqResponse([
          makeFqInstance({
            Status: 'valid',
            Template: { Code: 'tpl-A', Name: 'A' },
            InitCapacity: { BaseValue: 100, ShowUnit: 'token', ShowValue: '100' },
            CurrCapacity: { BaseValue: 75, ShowUnit: 'token', ShowValue: '75' },
          }),
        ]),
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());

    const out = await svc.fetchQuotasForModels([
      makeModel('qwen-plus'),
      makeModel('qwen-max'),
      makeModel('qwen-other'), // not in mapping
      makeModel('qwen-no-free', 'none'),
    ]);

    expect(out).toHaveLength(4);
    expect(out[0].free_tier.quota).toMatchObject({ remaining: 75, total: 100 });
    expect(out[1].free_tier.quota).toMatchObject({ remaining: 75, total: 100 });
    expect(out[2].free_tier.quota).toBeNull();
    expect(out[3].free_tier.mode).toBe('none');

    // Memoization side-effect: peekCachedQuota should now return the quota.
    expect(svc.peekCachedQuota('tpl-A')).toMatchObject({ remaining: 75 });
  });

  it('memoizes null when a templateCode resolves to no quota', async () => {
    const mapping = { 'qwen-plus': 'tpl-MISS' };
    mockGlobalFetch(
      vi.fn(
        async () => new Response(JSON.stringify(mapping), { status: 200, statusText: 'OK' }),
      ) as FetchFn,
    );
    const apiClient = makeMockApiClient({
      flat: async () => makeFqResponse([]),
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());

    await svc.fetchQuotasForModels([makeModel('qwen-plus')]);
    expect(svc.peekCachedQuota('tpl-MISS')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// peekCachedQuota / rememberQuota
// ────────────────────────────────────────────────────────────────────

describe('FreetierService memoization', () => {
  beforeEach(() => {
    // Quiet the unused fetch warning if a test happens to short-circuit.
    mockGlobalFetch(
      vi.fn(async () => new Response('{}', { status: 200, statusText: 'OK' })) as FetchFn,
    );
  });

  it('peekCachedQuota returns undefined for unknown codes', () => {
    const svc = new FreetierService(makeMockApiClient(), makeMockCachedFetcher());
    expect(svc.peekCachedQuota('never-seen')).toBeUndefined();
  });

  it('rememberQuota persists null vs quota distinction', () => {
    const svc = new FreetierService(makeMockApiClient(), makeMockCachedFetcher());
    svc.rememberQuota('tpl-A', null);
    svc.rememberQuota('tpl-B', {
      remaining: 1,
      total: 2,
      unit: 'token',
      used_pct: 50,
      status: 'valid',
      resetDate: null,
    });
    expect(svc.peekCachedQuota('tpl-A')).toBeNull();
    expect(svc.peekCachedQuota('tpl-B')).toMatchObject({ remaining: 1, total: 2 });
  });
});

// ────────────────────────────────────────────────────────────────────
// fetchFreeTierUsageList
// ────────────────────────────────────────────────────────────────────

describe('FreetierService.fetchFreeTierUsageList', () => {
  it('returns empty array when mapping is empty', async () => {
    mockGlobalFetch(
      vi.fn(async () => new Response('{}', { status: 200, statusText: 'OK' })) as FetchFn,
    );
    const apiClient = makeMockApiClient();
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());

    const out = await svc.fetchFreeTierUsageList();
    expect(out).toEqual([]);
    expect(apiClient.callFlatApi).not.toHaveBeenCalled();
  });

  it('returns one entry per mapping key, with quota for matched templates and null for unmatched', async () => {
    const mapping = { 'qwen-plus': 'tpl-A', 'qwen-fast': 'tpl-A', 'qwen-other': 'tpl-MISS' };
    mockGlobalFetch(
      vi.fn(
        async () => new Response(JSON.stringify(mapping), { status: 200, statusText: 'OK' }),
      ) as FetchFn,
    );

    const apiClient = makeMockApiClient({
      flat: async () =>
        makeFqResponse([
          makeFqInstance({
            Status: 'valid',
            Template: { Code: 'tpl-A', Name: 'A' },
            InitCapacity: { BaseValue: 200, ShowUnit: 'token', ShowValue: '200' },
            CurrCapacity: { BaseValue: 150, ShowUnit: 'token', ShowValue: '150' },
          }),
        ]),
    });
    const svc = new FreetierService(apiClient, makeMockCachedFetcher());

    const out = await svc.fetchFreeTierUsageList();
    expect(out).toHaveLength(3);

    const byId = new Map(out.map((u) => [u.model_id, u]));
    expect(byId.get('qwen-plus')?.quota).toMatchObject({ remaining: 150, total: 200 });
    expect(byId.get('qwen-fast')?.quota).toMatchObject({ remaining: 150, total: 200 });
    expect(byId.get('qwen-other')?.quota).toBeNull();
  });
});
