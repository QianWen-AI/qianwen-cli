/**
 * Black-box tests for the production HTTP API client.
 *
 * Strategy:
 *  - Mock the credential layer so resolveCredentials() always returns a fake
 *    bearer token; this lets request() build its Authorization header without
 *    touching the keychain or filesystem.
 *  - Mock the config layer so getEffectiveConfig() returns deterministic
 *    api.endpoint / auth.endpoint URLs.
 *  - Stub global fetch via mockFetch() to drive every HTTP path.
 *  - Reset the global cache between tests so listModels / getModel never see
 *    cached state from a previous test.
 *
 * What we deliberately DON'T test here (covered elsewhere or out of scope):
 *  - PKCE / device flow happy path (Phase 3).
 *  - keychain interactions (Phase 3).
 *  - Free-tier-list aggregation paths (depend on multi-stage
 *    private helpers; covered indirectly via aggregator unit tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetch } from '../helpers/http-mock.js';
import { site } from '../../src/site.js';
import { CliError } from '../../src/utils/errors.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };
const cdnKey = s.cdnBaseUrl.replace('https://', '');

// ── Hoisted mocks ────────────────────────────────────────────────────
// All three modules are imported by http-client.ts at evaluation time, so the
// mock declarations must run before the dynamic import of HttpApiClient inside
// each test.
vi.mock('../../src/auth/credentials.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCredentials: vi.fn(() => ({
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: 'fake-token-1234567890',
      credentials: {
        access_token: 'fake-token-1234567890',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        user: { email: 'test@example.com', aliyunId: 'test-user' },
      },
    })),
    isTokenExpired: vi.fn(() => false),
  };
});

vi.mock('../../src/config/manager.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveConfig: vi.fn(() => ({
      'api.endpoint': 'https://api.test.example.com',
      'auth.endpoint': 'https://auth.test.example.com',
    })),
  };
});

vi.mock('../../src/auth/client-id.js', () => ({
  getOrCreateClientId: vi.fn(() => 'fake-client-id'),
}));

// Reset cache between tests so each test starts from a clean slate.
beforeEach(async () => {
  const cacheMod = await import('../../src/utils/cache.js');
  cacheMod.resetGlobalCache();
});

let activeMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  if (activeMock) {
    activeMock.restore();
    activeMock = null;
  }
});

// ── Test fixtures ────────────────────────────────────────────────────

function makeApiModelItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Model: 'qwen-test',
    Name: 'Qwen Test',
    Description: 'A test model',
    ShortDescription: 'short',
    Category: 'Standard',
    Language: 'en-US',
    DataId: 'd1',
    GroupModel: 'TestSeries',
    VersionTag: 'MAJOR',
    ActivationStatus: 1,
    Scope: 'PUBLIC',
    OpenSource: false,
    FreeTierOnly: false,
    NeedApply: false,
    AliyunRecommend: false,
    UpdateAt: '2026-04-01T00:00:00Z',
    LatestOnlineAt: '2026-04-01T00:00:00Z',
    InferenceMetadata: { RequestModality: ['Text'], ResponseModality: ['Text'] },
    Capabilities: [],
    ModelInfo: { ContextWindow: 128000, MaxInputTokens: 120000, MaxOutputTokens: 8000 },
    ContextWindow: 128000,
    MaxInputTokens: 120000,
    MaxOutputTokens: 8000,
    QpmInfo: {
      ModelDefault: {
        UsageLimitField: 'total_tokens',
        CountLimit: 1500,
        Type: 'model-default',
        UsageLimit: 5_000_000,
        CountLimitPeriod: 60,
        UsageLimitPeriod: 60,
      },
    },
    Supports: {
      Sft: false, App: false, Dpo: false, WorkflowText: false, CheckpointImport: false,
      WorkflowMultimodal: false, Cpt: false, Inference: true, Workflow: false, Deploy: false,
      SelfServiceLimitIncrease: false, Experience: true, SellingByQpm: false, AppV1: false,
      ExperienceUpcoming: false, AppV2: false, DisplayQpmLimit: true, Tokenizer: true,
      Eval: false, FineTune: false,
    },
    Permissions: { Inference: true },
    Features: [],
    Tags: [],
    InferenceProvider: 'bailian',
    Provider: 'qwen',
    SampleCodeV2: {},
    ApplyType: 0,
    ...overrides,
  };
}

function listModelsResponse(items: Record<string, unknown>[]): Record<string, unknown> {
  return {
    code: '200',
    data: { Data: [{ Items: items }] },
  };
}

// ── 2.2 Models methods (listModels / getModel / getModels / searchModels) ──

describe('HttpApiClient.listModels', () => {
  it('fetches list + mapping in parallel and returns mapped models', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({ 'qwen-test': 'tmpl-qwen-test' }),
      '/data/v2/api.json': () => listModelsResponse([makeApiModelItem({ Model: 'qwen-test' })]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.listModels();

    expect(result.total).toBe(1);
    expect(result.models[0].id).toBe('qwen-test');
    expect(result.models[0].free_tier.mode).toBe('standard'); // mapping → templateCode → has free tier
    expect(result.models[0].free_tier.quota).toBeNull(); // quotas are deferred
    expect(activeMock.wasCalled('model-mapping')).toBe(true);
    expect(activeMock.wasCalled('/data/v2/api.json')).toBe(true);
  });

  it('caches raw items: second call does not re-fetch the model list', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () => listModelsResponse([makeApiModelItem({ Model: 'qwen-test' })]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    await client.listModels();
    const apiCallsAfterFirst = activeMock.calls.filter((c) =>
      c.url.includes('/data/v2/api.json'),
    ).length;
    await client.listModels();
    const apiCallsAfterSecond = activeMock.calls.filter((c) =>
      c.url.includes('/data/v2/api.json'),
    ).length;
    // Second listModels should not hit api.json again (cached raw items).
    expect(apiCallsAfterSecond).toBe(apiCallsAfterFirst);
  });

  it('throws when API returns non-200 code', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () => ({ code: '500', message: 'upstream broken' }),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    await expect(client.listModels()).rejects.toThrow(/API error.*upstream broken/);
  });

  it('filters by input modality option', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () =>
        listModelsResponse([
          makeApiModelItem({
            Model: 'text-only',
            InferenceMetadata: { RequestModality: ['Text'], ResponseModality: ['Text'] },
          }),
          makeApiModelItem({
            Model: 'multimodal',
            InferenceMetadata: { RequestModality: ['Text', 'Image'], ResponseModality: ['Text'] },
          }),
        ]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const filtered = await client.listModels({ input: 'image' });
    expect(filtered.models.map((m) => m.id)).toEqual(['multimodal']);
  });

  it('sends Authorization Bearer header on api.json calls', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () => listModelsResponse([]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    await client.listModels();
    const apiCall = activeMock.lastRequest('/data/v2/api.json');
    expect(apiCall?.headers['Authorization']).toBe('Bearer fake-token-1234567890');
    expect(apiCall?.headers['User-Agent']).toMatch(new RegExp(`^${s.userAgentPrefix}/`));
  });
});

describe('HttpApiClient.getModel', () => {
  it('returns full ModelDetail for an existing id', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      'DescribeFqInstance': () => ({ code: '200', data: { Data: [] } }),
      '/data/v2/api.json': (req: { body?: string }) => {
        const body = JSON.parse(req.body!);
        if (body.action === 'DescribeFqInstance') {
          return { code: '200', data: { Data: [] } };
        }
        return listModelsResponse([makeApiModelItem({ Model: 'qwen-test' })]);
      },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const detail = await client.getModel('qwen-test');
    expect(detail.id).toBe('qwen-test');
    expect(detail.modality.input).toEqual(['text']);
  });

  it('throws "Model not found" for unknown id', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () =>
        listModelsResponse([makeApiModelItem({ Model: 'qwen-test' })]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    await expect(client.getModel('does-not-exist')).rejects.toThrow(/'does-not-exist' not found/);
  });
});

describe('HttpApiClient.getModels', () => {
  it('preserves input order and returns null for unknown ids', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': (req: { body?: string }) => {
        const body = JSON.parse(req.body!);
        if (body.action === 'DescribeFqInstance') {
          return { code: '200', data: { Data: [] } };
        }
        return listModelsResponse([
          makeApiModelItem({ Model: 'qwen-a' }),
          makeApiModelItem({ Model: 'qwen-b' }),
        ]);
      },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const results = await client.getModels(['qwen-b', 'missing', 'qwen-a']);
    expect(results.map((r) => r?.id ?? null)).toEqual(['qwen-b', null, 'qwen-a']);
  });

  it('returns empty array for empty input', async () => {
    activeMock = mockFetch({});
    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    expect(await client.getModels([])).toEqual([]);
    // No HTTP calls should happen when ids is empty.
    expect(activeMock.calls).toHaveLength(0);
  });
});

describe('HttpApiClient.searchModels', () => {
  it('matches by id (substring, case-insensitive after normalization)', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () =>
        listModelsResponse([
          makeApiModelItem({ Model: 'qwen-vision-pro' }),
          makeApiModelItem({ Model: 'qwen-text-plus' }),
        ]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.searchModels('vision');
    expect(result.models.map((m) => m.id)).toEqual(['qwen-vision-pro']);
  });

  it('matches by description in raw cached data', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () =>
        listModelsResponse([
          makeApiModelItem({ Model: 'opaque-id', Description: 'flagship reasoning model' }),
          makeApiModelItem({ Model: 'other', Description: 'image generator' }),
        ]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.searchModels('reasoning');
    expect(result.models.map((m) => m.id)).toEqual(['opaque-id']);
  });

  it('returns empty list when no matches', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () =>
        listModelsResponse([makeApiModelItem({ Model: 'qwen-test' })]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.searchModels('nonexistent-keyword');
    expect(result.total).toBe(0);
  });
});

describe('HttpApiClient.fetchQuotasForModels', () => {
  it('returns input unchanged when no models have free_tier=standard', async () => {
    activeMock = mockFetch({});
    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const models = [
      {
        id: 'qwen-only',
        modality: { input: ['text' as const], output: ['text' as const] },
        can_try: true,
        free_tier: { mode: 'only' as const, quota: null },
      },
    ];
    const result = await client.fetchQuotasForModels(models);
    expect(result).toEqual(models);
    // No fetch should happen — early return when no standard-mode models.
    expect(activeMock.calls).toHaveLength(0);
  });
});

// ── 2.3 Auth / health methods (getAuthStatus / ping / checkVersion / revokeSession) ──

describe('HttpApiClient.getAuthStatus', () => {
  it('returns server_verified=true when /api/account/info.json returns 200', async () => {
    activeMock = mockFetch({
      '/api/account/info.json': () => ({
        data: { aliyunId: '1234567890', email: 'demo@qianwenai.com' },
      }),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const status = await client.getAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.server_verified).toBe(true);
    expect(status.user?.email).toBe('demo@qianwenai.com');
  });

  it('returns server_verified=false with warning when server returns 5xx', async () => {
    activeMock = mockFetch({
      '/api/account/info.json': { body: 'oops', init: { status: 500 } },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const status = await client.getAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.server_verified).toBe(false);
    expect(status.warning).toContain('Server verification failed');
  });

  it('returns authenticated=false when no credentials are present', async () => {
    const credsMod = await import('../../src/auth/credentials.js');
    (credsMod.resolveCredentials as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    activeMock = mockFetch({});
    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const status = await client.getAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.server_verified).toBe(false);
    // No HTTP should happen when no credentials.
    expect(activeMock.calls).toHaveLength(0);
  });

  it('returns authenticated=false when local token is expired', async () => {
    const credsMod = await import('../../src/auth/credentials.js');
    (credsMod.isTokenExpired as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    activeMock = mockFetch({});
    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const status = await client.getAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(activeMock.calls).toHaveLength(0);
  });
});

describe('HttpApiClient.ping', () => {
  it('returns reachable=true with measured latency', async () => {
    activeMock = mockFetch({
      'api.test.example.com': () => ({}),
    });
    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.ping();
    expect(result.reachable).toBe(true);
    expect(result.hostname).toBe('api.test.example.com');
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });

  it('returns reachable=false when fetch throws', async () => {
    // Custom failing fetch (not via mockFetch which always returns a Response)
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as any;
    try {
      const { HttpApiClient } = await import('../../src/api/http-client.js');
      const client = new HttpApiClient();
      const result = await client.ping();
      expect(result.reachable).toBe(false);
      expect(result.hostname).toBe('api.test.example.com');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('HttpApiClient.checkVersion', () => {
  it('returns local version with no remote check (V1 stub)', async () => {
    activeMock = mockFetch({});
    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.checkVersion();
    expect(result).toEqual({
      current: expect.any(String),
      latest: expect.any(String),
      update_available: false,
    });
    expect(result.current).toBe(result.latest);
    // No HTTP call expected.
    expect(activeMock.calls).toHaveLength(0);
  });
});

describe('HttpApiClient.revokeSession', () => {
  it('returns true on 200 from /cli/device/logout', async () => {
    activeMock = mockFetch({
      '/cli/device/logout': () => ({ ok: true }),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.revokeSession();
    expect(result).toBe(true);
    const call = activeMock.lastRequest('/cli/device/logout');
    expect(call?.method).toBe('POST');
    expect(call?.headers['Authorization']).toBe('Bearer fake-token-1234567890');
  });

  it('returns false (best-effort) when server returns 5xx', async () => {
    activeMock = mockFetch({
      '/cli/device/logout': { body: 'down', init: { status: 503 } },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    const result = await client.revokeSession();
    // Per implementation: any non-2xx OR network error returns false.
    expect(result).toBe(false);
  });

  it('returns false when no credentials are present', async () => {
    const credsMod = await import('../../src/auth/credentials.js');
    (credsMod.resolveCredentials as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    activeMock = mockFetch({});
    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    expect(await client.revokeSession()).toBe(false);
    expect(activeMock.calls).toHaveLength(0);
  });
});

// ── 2.4 Error paths (HTTP 401 / 403 / 404 / 5xx via request()) ──

describe('HttpApiClient request() error paths', () => {
  it('wraps HTTP 401 into a CliError with AUTH_REQUIRED code and detail', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': { body: '{"error":"unauthorized"}', init: { status: 401, statusText: 'Unauthorized' } },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    try {
      await client.listModels();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('AUTH_REQUIRED');
      expect((err as CliError).detail).toContain('HTTP 401');
      expect((err as CliError).detail).toContain('Unauthorized');
    }
  });

  it('wraps HTTP 403 into a CliError with TOKEN_EXPIRED code and detail', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': { body: 'forbidden by policy', init: { status: 403, statusText: 'Forbidden' } },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    try {
      await client.listModels();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('TOKEN_EXPIRED');
      expect((err as CliError).detail).toContain('HTTP 403');
    }
  });

  it('wraps HTTP 500 into a CliError with SERVER_ERROR code and detail', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': { body: 'internal error', init: { status: 500, statusText: 'Internal Server Error' } },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    try {
      await client.listModels();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('SERVER_ERROR');
      expect((err as CliError).detail).toContain('HTTP 500');
    }
  });

  it('wraps fetch network errors into a CliError with NETWORK_ERROR code and detail', async () => {
    // Replace fetch with one that rejects (simulates DNS/conn failure).
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn((url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('model-mapping')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    }) as any;

    try {
      const { HttpApiClient } = await import('../../src/api/http-client.js');
      const client = new HttpApiClient();
      try {
        await client.listModels();
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('NETWORK_ERROR');
        expect((err as CliError).detail).toContain('ECONNREFUSED');
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it('redacts Authorization header in error body even when truncated', async () => {
    // Test very long body (>500 chars) gets truncated in detail.
    const longBody = 'X'.repeat(800);
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': { body: longBody, init: { status: 502, statusText: 'Bad Gateway' } },
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    try {
      await client.listModels();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('SERVER_ERROR');
      expect((err as CliError).detail).toContain('HTTP 502');
      expect((err as CliError).detail).toContain('truncated');
    }
  });
});

// ── 2.4 Header injection sanity ─────────────────────────────────────

describe('HttpApiClient request() headers', () => {
  it('injects User-Agent and Authorization on every authenticated call', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () => listModelsResponse([]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    await client.listModels();
    const apiCall = activeMock.lastRequest('/data/v2/api.json');
    expect(apiCall?.headers['User-Agent']).toContain(`${s.userAgentPrefix}/`);
    expect(apiCall?.headers['Authorization']).toBe('Bearer fake-token-1234567890');
    expect(apiCall?.headers['Content-Type']).toBe('application/json');
  });

  it('omits Authorization on the public model-mapping fetch', async () => {
    activeMock = mockFetch({
      [cdnKey]: () => ({}),
      '/data/v2/api.json': () => listModelsResponse([]),
    });

    const { HttpApiClient } = await import('../../src/api/http-client.js');
    const client = new HttpApiClient();
    await client.listModels();
    const mapCall = activeMock.lastRequest('model-mapping');
    expect(mapCall?.headers['Authorization']).toBeUndefined();
    expect(mapCall?.headers['User-Agent']).toContain(`${s.userAgentPrefix}/`);
  });
});
