/**
 * Tests for ModelsService.
 *
 * Strategy:
 *   - Stub FreetierService at the interface boundary (mapping + quotas + memo).
 *   - Mock ApiClient.callFlatApi to return pre-built ApiModelGroup payloads.
 *   - Use minimal ApiModelItem fixtures (cast via unknown — never `as any`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelsService } from '../../src/services/models-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import { setReplMode } from '../../src/utils/runtime-mode.js';
import type { FreetierService } from '../../src/services/freetier-service.js';
import type { ModelAdapter } from '../../src/services/models-service.js';
import type {
  ApiModelGroup,
  ApiModelItem,
  ApiModelsListResponse,
} from '../../src/types/api-models.js';
import type { FreeTierQuota, ModelDetail } from '../../src/types/model.js';

// ────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────

function makeApiItem(overrides: Partial<ApiModelItem> = {}): ApiModelItem {
  return {
    Model: 'qwen-plus',
    Name: 'Qwen Plus',
    Description: 'desc',
    ShortDescription: 'short',
    Category: 'Standard',
    Language: 'en-US',
    DataId: 'data-1',
    GroupModel: 'Qwen-Plus',
    VersionTag: 'MAJOR',
    ActivationStatus: 1,
    Scope: 'PUBLIC',
    OpenSource: false,
    FreeTierOnly: false,
    NeedApply: false,
    AliyunRecommend: false,
    LatestOnlineAt: '2026-01-01T00:00:00Z',
    Capabilities: [],
    InferenceMetadata: {
      RequestModality: ['Text'],
      ResponseModality: ['Text'],
    } as unknown as ApiModelItem['InferenceMetadata'],
    ModelInfo: {
      ContextWindow: 32768,
      MaxInputTokens: 30000,
      MaxOutputTokens: 8000,
    } as unknown as ApiModelItem['ModelInfo'],
    ContextWindow: 32768,
    MaxInputTokens: 30000,
    MaxOutputTokens: 8000,
    QpmInfo: { Qpm: 60 } as unknown as ApiModelItem['QpmInfo'],
    Permissions: {} as unknown as ApiModelItem['Permissions'],
    Features: [],
    InferenceProvider: 'bailian',
    Provider: 'qwen',
    SampleCodeV2: {} as unknown as ApiModelItem['SampleCodeV2'],
    ApplyType: 0,
    ...overrides,
  };
}

function makeApiGroup(items: ApiModelItem[]): ApiModelGroup {
  return {
    Group: true,
    Name: 'Group-A',
    DataId: 'g-1',
    Providers: ['qwen'],
    LatestOnlineAt: '2026-01-01T00:00:00Z',
    InstanceLatestOnlineAt: '2026-01-01T00:00:00Z',
    ActivationStatus: 1,
    UpdateAt: '2026-01-01T00:00:00Z',
    Supports: {} as unknown as ApiModelGroup['Supports'],
    Language: 'en-US',
    Permissions: {} as unknown as ApiModelGroup['Permissions'],
    Features: [],
    Items: items,
    ApplyType: 0,
  };
}

function makeListResponse(items: ApiModelItem[]): ApiModelsListResponse['data'] {
  return { Data: [makeApiGroup(items)] } as unknown as ApiModelsListResponse['data'];
}

interface StubFreetier extends Pick<
  FreetierService,
  | 'fetchModelMapping'
  | 'fetchFreeTierQuotas'
  | 'fetchQuotasForModels'
  | 'peekCachedQuota'
  | 'rememberQuota'
> {
  fetchModelMapping: ReturnType<typeof vi.fn>;
  fetchFreeTierQuotas: ReturnType<typeof vi.fn>;
  fetchQuotasForModels: ReturnType<typeof vi.fn>;
  peekCachedQuota: ReturnType<typeof vi.fn>;
  rememberQuota: ReturnType<typeof vi.fn>;
}

function makeStubFreetier(opts?: {
  mapping?: Record<string, string>;
  quotas?: Map<string, FreeTierQuota>;
  peek?: (code: string) => FreeTierQuota | null | undefined;
}): StubFreetier {
  const memo = new Map<string, FreeTierQuota | null>();
  return {
    fetchModelMapping: vi.fn(async () => opts?.mapping ?? {}),
    fetchFreeTierQuotas: vi.fn(async () => opts?.quotas ?? new Map<string, FreeTierQuota>()),
    fetchQuotasForModels: vi.fn(async (models) => models),
    peekCachedQuota: vi.fn((code: string) => {
      if (opts?.peek) return opts.peek(code);
      return memo.has(code) ? (memo.get(code) ?? null) : undefined;
    }),
    rememberQuota: vi.fn((code: string, q: FreeTierQuota | null) => {
      memo.set(code, q);
    }),
  };
}

const noopAdapter: ModelAdapter = {
  toModelList: () => [],
  toModelDetail: () => ({}) as unknown as ModelDetail,
};

// ────────────────────────────────────────────────────────────────────
// listModels
// ────────────────────────────────────────────────────────────────────

describe('ModelsService.listModels', () => {
  beforeEach(() => {
    // ModelsService delegates to runtime-mode.isReplMode for getModel. Tests
    // here that don't touch getModel are unaffected by the singleton state.
    void setReplMode;
  });

  it('caches raw models with key models:raw_list and TTL=10min', async () => {
    const api = makeMockApiClient({
      flat: async () => makeListResponse([makeApiItem()]),
    });
    const cache = makeMockCachedFetcher();
    const ft = makeStubFreetier();
    const svc = new ModelsService(api, noopAdapter, ft as unknown as FreetierService, cache);

    await svc.listModels();
    expect(cache.getOrFetch).toHaveBeenCalled();
    const [key, ttl] = cache.getOrFetch.mock.calls[0];
    expect(key).toBe('models:raw_list');
    expect(ttl).toBe(10 * 60 * 1000);
    expect(api.callFlatApi).toHaveBeenCalledTimes(1);
    const flatCall = api.callFlatApi.mock.calls[0][0];
    expect(flatCall).toMatchObject({
      product: 'AliyunDeliveryService',
      action: 'ListModelSeries',
      params: { Language: 'zh-CN' },
    });
  });

  it('marks models with mapping entries as standard free-tier and others as null', async () => {
    const items = [
      makeApiItem({ Model: 'qwen-plus' }),
      makeApiItem({ Model: 'qwen-no-ft' }),
      makeApiItem({ Model: 'qwen-only', FreeTierOnly: true }),
    ];
    const api = makeMockApiClient({ flat: async () => makeListResponse(items) });
    const ft = makeStubFreetier({ mapping: { 'qwen-plus': 'tpl-A' } });
    const svc = new ModelsService(
      api,
      noopAdapter,
      ft as unknown as FreetierService,
      makeMockCachedFetcher(),
    );

    const out = await svc.listModels();
    expect(out.total).toBe(3);
    const byId = new Map(out.models.map((m) => [m.id, m]));
    expect(byId.get('qwen-plus')?.free_tier.mode).toBe('standard');
    expect(byId.get('qwen-no-ft')?.free_tier.mode).toBeNull();
    expect(byId.get('qwen-only')?.free_tier.mode).toBe('only');
  });

  it('throws when the API returns an empty payload', async () => {
    const api = makeMockApiClient({
      flat: async () => ({}) as unknown as ApiModelsListResponse['data'],
    });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );
    await expect(svc.listModels()).rejects.toThrow('Models API returned empty payload');
  });

  it('filters by input modality (comma-separated AND match)', async () => {
    const items = [
      makeApiItem({
        Model: 'text-only',
        InferenceMetadata: {
          RequestModality: ['Text'],
          ResponseModality: ['Text'],
        } as unknown as ApiModelItem['InferenceMetadata'],
      }),
      makeApiItem({
        Model: 'multimodal',
        InferenceMetadata: {
          RequestModality: ['Text', 'Image'],
          ResponseModality: ['Text'],
        } as unknown as ApiModelItem['InferenceMetadata'],
      }),
    ];
    const api = makeMockApiClient({ flat: async () => makeListResponse(items) });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );

    const out = await svc.listModels({ input: 'text,image' });
    expect(out.total).toBe(1);
    expect(out.models[0]?.id).toBe('multimodal');
  });

  it('filters by output modality', async () => {
    const items = [
      makeApiItem({
        Model: 'text-out',
        InferenceMetadata: {
          RequestModality: ['Text'],
          ResponseModality: ['Text'],
        } as unknown as ApiModelItem['InferenceMetadata'],
      }),
      makeApiItem({
        Model: 'image-out',
        InferenceMetadata: {
          RequestModality: ['Text'],
          ResponseModality: ['Image'],
        } as unknown as ApiModelItem['InferenceMetadata'],
      }),
    ];
    const api = makeMockApiClient({ flat: async () => makeListResponse(items) });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );

    const out = await svc.listModels({ output: 'image' });
    expect(out.models.map((m) => m.id)).toEqual(['image-out']);
  });
});

// ────────────────────────────────────────────────────────────────────
// searchModels
// ────────────────────────────────────────────────────────────────────

describe('ModelsService.searchModels', () => {
  it('matches by id, description, tag, feature, capability (case-insensitive)', async () => {
    const items = [
      makeApiItem({
        Model: 'qwen-plus',
        Description: 'Flagship LLM with reasoning',
        Tags: ['flagship'],
      }),
      makeApiItem({
        Model: 'qwen-vl-max',
        Description: 'Vision Language',
        Capabilities: ['Multimodal-VL'],
      }),
      makeApiItem({
        Model: 'qwen-other',
        Description: 'Boring',
        Features: ['boring'],
      }),
    ];
    const api = makeMockApiClient({ flat: async () => makeListResponse(items) });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );

    const byId = await svc.searchModels('plus');
    expect(byId.models.map((m) => m.id)).toEqual(['qwen-plus']);

    const byDesc = await svc.searchModels('vision');
    expect(byDesc.models.map((m) => m.id)).toEqual(['qwen-vl-max']);

    const byCap = await svc.searchModels('multimodal-vl');
    expect(byCap.models.map((m) => m.id)).toEqual(['qwen-vl-max']);

    const byFeature = await svc.searchModels('boring');
    expect(byFeature.models.map((m) => m.id)).toEqual(['qwen-other']);
  });

  it('returns empty when no model matches', async () => {
    const api = makeMockApiClient({
      flat: async () => makeListResponse([makeApiItem({ Model: 'qwen-plus' })]),
    });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );
    const out = await svc.searchModels('zzz-no-match');
    expect(out.total).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// getModel (REPL path uses cache)
// ────────────────────────────────────────────────────────────────────

describe('ModelsService.getModel', () => {
  beforeEach(() => {
    setReplMode(); // make subsequent tests use the cache path
  });

  it('returns ModelDetail from cache in REPL mode without issuing a Query call', async () => {
    const items = [makeApiItem({ Model: 'qwen-plus' })];
    const api = makeMockApiClient({ flat: async () => makeListResponse(items) });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );
    const detail = await svc.getModel('qwen-plus');
    expect(detail.id).toBe('qwen-plus');
    expect(api.callFlatApi).toHaveBeenCalledTimes(1); // single ListModelSeries call (no Query path)
  });

  it('throws when the requested model is not in the cached list (REPL mode)', async () => {
    const api = makeMockApiClient({
      flat: async () => makeListResponse([makeApiItem({ Model: 'qwen-plus' })]),
    });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );
    await expect(svc.getModel('non-existent')).rejects.toThrow("Model 'non-existent' not found");
  });

  it('uses memoized quota on second hit and skips fetchFreeTierQuotas', async () => {
    const ft = makeStubFreetier({ mapping: { 'qwen-plus': 'tpl-A' } });
    const quota: FreeTierQuota = {
      remaining: 10,
      total: 100,
      unit: 'tokens',
      used_pct: 90,
      status: 'valid',
      resetDate: null,
    };
    ft.fetchFreeTierQuotas.mockResolvedValueOnce(new Map([['tpl-A', quota]]));
    const api = makeMockApiClient({
      flat: async () => makeListResponse([makeApiItem({ Model: 'qwen-plus' })]),
    });
    const svc = new ModelsService(
      api,
      noopAdapter,
      ft as unknown as FreetierService,
      makeMockCachedFetcher(),
    );

    await svc.getModel('qwen-plus'); // first time → fetches
    await svc.getModel('qwen-plus'); // second time → peek hit
    expect(ft.fetchFreeTierQuotas).toHaveBeenCalledTimes(1);
    expect(ft.peekCachedQuota).toHaveBeenCalled();
    expect(ft.rememberQuota).toHaveBeenCalledWith('tpl-A', quota);
  });
});

// ────────────────────────────────────────────────────────────────────
// getModels (batched)
// ────────────────────────────────────────────────────────────────────

describe('ModelsService.getModels', () => {
  it('returns empty for empty input', async () => {
    const api = makeMockApiClient();
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );
    expect(await svc.getModels([])).toEqual([]);
    expect(api.callFlatApi).not.toHaveBeenCalled();
  });

  it('returns nulls for ids not in the cached list', async () => {
    const items = [makeApiItem({ Model: 'qwen-plus' })];
    const api = makeMockApiClient({ flat: async () => makeListResponse(items) });
    const svc = new ModelsService(
      api,
      noopAdapter,
      makeStubFreetier() as unknown as FreetierService,
      makeMockCachedFetcher(),
    );
    const out = await svc.getModels(['qwen-plus', 'no-such']);
    expect(out[0]?.id).toBe('qwen-plus');
    expect(out[1]).toBeNull();
  });

  it('batches a single fetchFreeTierQuotas call for the union of unmemoized template codes', async () => {
    const ft = makeStubFreetier({ mapping: { a: 'tpl-A', b: 'tpl-B', c: 'tpl-A' } });
    ft.fetchFreeTierQuotas.mockResolvedValueOnce(
      new Map<string, FreeTierQuota>([
        [
          'tpl-A',
          {
            remaining: 1,
            total: 2,
            unit: 'tokens',
            used_pct: 50,
            status: 'valid',
            resetDate: null,
          },
        ],
      ]),
    );
    const items = [
      makeApiItem({ Model: 'a' }),
      makeApiItem({ Model: 'b' }),
      makeApiItem({ Model: 'c' }),
    ];
    const api = makeMockApiClient({ flat: async () => makeListResponse(items) });
    const svc = new ModelsService(
      api,
      noopAdapter,
      ft as unknown as FreetierService,
      makeMockCachedFetcher(),
    );

    await svc.getModels(['a', 'b', 'c']);
    expect(ft.fetchFreeTierQuotas).toHaveBeenCalledTimes(1);
    const codesArg = ft.fetchFreeTierQuotas.mock.calls[0][0] as string[];
    expect(new Set(codesArg)).toEqual(new Set(['tpl-A', 'tpl-B']));
  });
});

// ────────────────────────────────────────────────────────────────────
// fetchQuotasForModels — pure delegation
// ────────────────────────────────────────────────────────────────────

describe('ModelsService.fetchQuotasForModels', () => {
  it('delegates to FreetierService.fetchQuotasForModels', async () => {
    const ft = makeStubFreetier();
    const sentinel = [{ id: 'qwen-plus' }] as unknown as Parameters<
      FreetierService['fetchQuotasForModels']
    >[0];
    ft.fetchQuotasForModels.mockResolvedValueOnce(sentinel);
    const svc = new ModelsService(
      makeMockApiClient(),
      noopAdapter,
      ft as unknown as FreetierService,
      makeMockCachedFetcher(),
    );

    const out = await svc.fetchQuotasForModels(sentinel);
    expect(out).toBe(sentinel);
    expect(ft.fetchQuotasForModels).toHaveBeenCalledWith(sentinel);
  });
});
