/**
 * Tests for DocsService.
 *
 * Strategy:
 *   - searchDocs: drive ApiClient via the shared mock (flat-parameter, authOptional).
 *   - fetchDocContent: stub global fetch with a minimal Response shim.
 *   - Boundary cases for the normalisation helper exported from docs-service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DocsService, normalizeSearchAllResponse } from '../../src/services/docs-service.js';
import type { DocsIndexEntry } from '../../src/types/docs.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import { site } from '../../src/site.js';

// Redirect index cache to a per-test temp directory so tests exercise the real
// fs layer without polluting the user's home cache. The `getCacheFilePath`
// indirection is the documented persistence seam shared with FileCache.
const pathsState = vi.hoisted(() => ({ cacheDir: '' }));

vi.mock('../../src/config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/paths.js')>();
  return {
    ...actual,
    getCacheDir: () => pathsState.cacheDir,
    getCacheFilePath: (fileName: string) => join(pathsState.cacheDir, fileName),
  };
});

const SEARCH_PRODUCT = 'aliyun-search-maas';
const SEARCH_ACTION = 'SearchAll';

let originalFetch: typeof globalThis.fetch | undefined;
afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// normalizeSearchAllResponse
// ────────────────────────────────────────────────────────────────────

describe('normalizeSearchAllResponse', () => {
  it('prefers PascalCase upstream fields and normalises Info[]', () => {
    const out = normalizeSearchAllResponse(
      {
        TotalCount: 12,
        PageNo: 2,
        Info: [
          {
            title: 'Hello',
            content: 'lorem ipsum',
            subBizType: 'doc',
            url: 'https://docs.test.qianwen.com/a',
            nodesInfo: JSON.stringify([{ nodeName: 'Guides' }, { nodeName: 'Quickstart' }]),
          },
        ],
      },
      { page: 1, pageSize: 20 },
    );
    expect(out.totalCount).toBe(12);
    expect(out.page).toBe(2);
    expect(out.pageSize).toBe(20); // taken from fallback because raw.pageSize is absent
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toEqual({
      title: 'Hello',
      highlightedTitle: 'Hello',
      subBizType: 'doc',
      url: 'https://docs.test.qianwen.com/a',
      summary: 'lorem ipsum',
      highlightedSummary: 'lorem ipsum',
      breadcrumb: ['Guides', 'Quickstart'],
    });
  });

  it('falls back through legacy camelCase fields and breadcrumb arrays', () => {
    const out = normalizeSearchAllResponse(
      {
        totalCount: 3,
        pageNo: 1,
        pageSize: 10,
        items: [
          {
            title: 't',
            summary: 'legacy summary',
            highlightedSummary: '<em>legacy</em>',
            breadcrumb: ['A', 'B'],
            url: 'https://docs.test.qianwen.com/legacy',
          },
        ],
      },
      { page: 1, pageSize: 10 },
    );
    expect(out.pageSize).toBe(10);
    expect(out.items[0]?.summary).toBe('legacy summary');
    expect(out.items[0]?.highlightedSummary).toBe('<em>legacy</em>');
    expect(out.items[0]?.breadcrumb).toEqual(['A', 'B']);
  });

  it('returns empty defaults when raw is null', () => {
    const out = normalizeSearchAllResponse(null, { page: 1, pageSize: 20 });
    expect(out).toEqual({ totalCount: 0, page: 1, pageSize: 20, items: [], rawItems: [] });
  });

  it('handles malformed nodesInfo without throwing', () => {
    const out = normalizeSearchAllResponse(
      {
        Info: [{ title: 'x', nodesInfo: 'not-json' }],
      },
      { page: 1, pageSize: 20 },
    );
    expect(out.items[0]?.breadcrumb).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// searchDocs
// ────────────────────────────────────────────────────────────────────

describe('DocsService.searchDocs', () => {
  it('issues a flat-protocol call with authOptional=true and the documented param shape', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.product).toBe(SEARCH_PRODUCT);
        expect(opts.action).toBe(SEARCH_ACTION);
        expect(opts.authOptional).toBe(true);
        const params = opts.params as Record<string, unknown>;
        expect(params.QuerySceneParams).toMatchObject({
          QueryWord: 'qwen',
          Limit: 5,
          PageNo: 2,
          BizType: 'doc',
        });
        return {
          TotalCount: 1,
          PageNo: 2,
          Info: [{ title: 'r', url: 'https://docs.test.qianwen.com/r', content: 'body' }],
        };
      },
    });
    const svc = new DocsService(api);
    const out = await svc.searchDocs({ query: '  qwen  ', limit: 5, page: 2 });
    expect(out.totalCount).toBe(1);
    expect(out.items[0]?.url).toBe('https://docs.test.qianwen.com/r');
  });

  it('clamps limit/page to documented ranges', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        const p = opts.params as Record<string, unknown>;
        const q = p.QuerySceneParams as Record<string, unknown>;
        expect(q.Limit).toBe(100); // clamped to MAX_LIMIT
        expect(q.PageNo).toBe(1); // clamped up from 0
        return { TotalCount: 0, PageNo: 1, Info: [] };
      },
    });
    const svc = new DocsService(api);
    await svc.searchDocs({ query: 'x', limit: 999, page: 0 });
    expect(api.callFlatApi).toHaveBeenCalledTimes(1);
  });

  it('falls back to defaults when limit/page are non-finite', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        const p = opts.params as Record<string, unknown>;
        const q = p.QuerySceneParams as Record<string, unknown>;
        expect(q.Limit).toBe(20); // DEFAULT_LIMIT
        expect(q.PageNo).toBe(1); // DEFAULT_PAGE
        return { TotalCount: 0, PageNo: 1, Info: [] };
      },
    });
    const svc = new DocsService(api);
    await svc.searchDocs({ query: 'x', limit: Number.NaN, page: Number.NaN });
  });

  it('honours an explicit language override', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        const p = opts.params as Record<string, unknown>;
        const q = p.QuerySceneParams as Record<string, unknown>;
        expect(q.Language).toBe('en');
        return { TotalCount: 0, Info: [] };
      },
    });
    const svc = new DocsService(api);
    await svc.searchDocs({ query: 'x', language: 'en' });
  });
});

// ────────────────────────────────────────────────────────────────────
// fetchDocContent
// ────────────────────────────────────────────────────────────────────

describe('DocsService.fetchDocContent', () => {
  it('appends .md when missing, returns markdown content on 200', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      expect(url).toBe('https://docs.test.qianwen.com/a.md');
      return new Response('# Hello', { status: 200 });
    }) as unknown as typeof fetch;

    const svc = new DocsService(makeMockApiClient());
    const out = await svc.fetchDocContent('https://docs.test.qianwen.com/a');
    expect(out.content).toBe('# Hello');
    expect(out.error).toBeNull();
    expect(out.anchor).toBeNull();
    expect(out.resolvedMarkdownUrl).toBe('https://docs.test.qianwen.com/a.md');
  });

  it('preserves an existing .md suffix and extracts the anchor fragment', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      expect(typeof input === 'string' ? input : input.toString()).toBe(
        'https://docs.test.qianwen.com/b.md',
      );
      return new Response('body', { status: 200 });
    }) as unknown as typeof fetch;

    const svc = new DocsService(makeMockApiClient());
    const out = await svc.fetchDocContent('https://docs.test.qianwen.com/b.md#section-1');
    expect(out.anchor).toBe('section-1');
  });

  it('returns an HTTP error string on non-200 responses', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;

    const svc = new DocsService(makeMockApiClient());
    const out = await svc.fetchDocContent('https://docs.test.qianwen.com/missing');
    expect(out.content).toBeNull();
    expect(out.error).toBe('HTTP 404');
  });

  it('reports timeout via Request timed out', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;

    const svc = new DocsService(makeMockApiClient());
    const out = await svc.fetchDocContent('https://docs.test.qianwen.com/timeout');
    expect(out.error).toBe('Request timed out');
  });

  it('reports network errors verbatim', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const svc = new DocsService(makeMockApiClient());
    const out = await svc.fetchDocContent('https://docs.test.qianwen.com/net-fail');
    expect(out.error).toBe('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// fetchDocContent — extension whitelist + cross-domain redirect interception.
// ---------------------------------------------------------------------------

describe('DocsService.fetchDocContent (extensions & redirects)', () => {
  let service: DocsService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new DocsService(makeMockApiClient());
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should not double-append .md if URL already ends with .md', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      text: async () => '# Doc',
    });

    const result = await service.fetchDocContent('https://mock-docs.test.qianwenai.com/guide.md');

    expect(result.resolvedMarkdownUrl).toBe('https://mock-docs.test.qianwenai.com/guide.md');
  });

  it('should fetch .json URLs verbatim without appending .md', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      text: async () => '{"openapi":"3.0.0"}',
    });

    const result = await service.fetchDocContent(
      'https://mock-docs.test.qianwenai.com/openapi-wan27-video-editing.json',
    );

    expect(result.resolvedMarkdownUrl).toBe(
      'https://mock-docs.test.qianwenai.com/openapi-wan27-video-editing.json',
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mock-docs.test.qianwenai.com/openapi-wan27-video-editing.json',
      expect.any(Object),
    );
  });

  it('should fetch .txt URLs verbatim without appending .md', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      text: async () => 'plain text',
    });

    const result = await service.fetchDocContent('https://mock-docs.test.qianwenai.com/llms.txt');

    expect(result.resolvedMarkdownUrl).toBe('https://mock-docs.test.qianwenai.com/llms.txt');
  });

  it('should append .md when extension is not whitelisted', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      text: async () => '# Doc',
    });

    const result = await service.fetchDocContent(
      'https://mock-docs.test.qianwenai.com/malicious.exe',
    );

    expect(result.resolvedMarkdownUrl).toBe(
      'https://mock-docs.test.qianwenai.com/malicious.exe.md',
    );
  });

  it('should append .md to slug paths without an extension', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      text: async () => '# Doc',
    });

    const result = await service.fetchDocContent(
      'https://mock-docs.test.qianwenai.com/guide/quickstart',
    );

    expect(result.resolvedMarkdownUrl).toBe(
      'https://mock-docs.test.qianwenai.com/guide/quickstart.md',
    );
  });

  it('should follow in-domain redirect to a qianwenai.com subdomain and fetch content', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        status: 301,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location'
              ? 'https://platform.qianwenai.com/docs/developer-guides/moved-page.md'
              : null,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        text: async () => '# Moved Page\n\nNew content.',
      });

    const result = await service.fetchDocContent(
      'https://mock-docs.test.qianwenai.com/developer-guides/moved-page',
    );

    expect(result.error).toBeNull();
    expect(result.content).toBe('# Moved Page\n\nNew content.');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://platform.qianwenai.com/docs/developer-guides/moved-page.md',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('should block redirect that targets an off-domain host', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location' ? 'https://evil.example.com/leak' : null,
      },
    });

    const result = await service.fetchDocContent(
      'https://mock-docs.test.qianwenai.com/developer-guides/external',
    );

    expect(result.content).toBeNull();
    expect(result.error).toBe('Cannot open this document.');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('should error when redirect response lacks a Location header', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 301,
      headers: { get: () => null },
    });

    const result = await service.fetchDocContent(
      'https://mock-docs.test.qianwenai.com/developer-guides/no-location',
    );

    expect(result.content).toBeNull();
    expect(result.error).toBe('Cannot open this document.');
  });

  it('should error after exceeding the 5-redirect limit', async () => {
    const inDomainRedirect = {
      status: 301,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location'
            ? 'https://platform.qianwenai.com/docs/developer-guides/looping.md'
            : null,
      },
    };
    fetchSpy.mockResolvedValue(inDomainRedirect);

    const result = await service.fetchDocContent(
      'https://mock-docs.test.qianwenai.com/developer-guides/looping',
    );

    expect(result.content).toBeNull();
    expect(result.error).toBe('Cannot open this document.');
    // Initial request + 5 follow-ups = 6 calls before tripping the limit.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
});

// ---------------------------------------------------------------------------
// buildDocsUrl — relative path → absolute docs URL.
// ---------------------------------------------------------------------------

describe('DocsService.buildDocsUrl', () => {
  let service: DocsService;

  beforeEach(() => {
    service = new DocsService(makeMockApiClient());
  });

  it('prepends the configured docs base URL to a relative path', () => {
    const result = service.buildDocsUrl('developer-guides/getting-started/pricing');
    expect(result).toBe(`${site.docsBaseUrl}/developer-guides/getting-started/pricing`);
  });

  it('strips a leading slash from the relative path before composing', () => {
    const result = service.buildDocsUrl('/developer-guides/getting-started/pricing');
    expect(result).toBe(`${site.docsBaseUrl}/developer-guides/getting-started/pricing`);
    expect(result).not.toContain('//developer');
  });

  it('passes a fully qualified https:// URL through with .md stripped', () => {
    const direct = 'https://mock-docs.test.qianwenai.com/resources/free-quota.md';
    expect(service.buildDocsUrl(direct)).toBe(
      'https://mock-docs.test.qianwenai.com/resources/free-quota',
    );
  });

  it('passes a fully qualified http:// URL through with .md stripped', () => {
    const direct = 'http://mock-docs.test.qianwenai.com/resources/free-quota.md';
    expect(service.buildDocsUrl(direct)).toBe(
      'http://mock-docs.test.qianwenai.com/resources/free-quota',
    );
  });

  it('passes a fully qualified URL without .md through verbatim', () => {
    const direct = 'https://mock-docs.test.qianwenai.com/resources/free-quota';
    expect(service.buildDocsUrl(direct)).toBe(direct);
  });

  it('preserves the #anchor suffix on the composed URL', () => {
    const result = service.buildDocsUrl('api-reference/chat/openai-chat#streaming');
    expect(result).toBe(`${site.docsBaseUrl}/api-reference/chat/openai-chat#streaming`);
    expect(result.endsWith('#streaming')).toBe(true);
  });

  it('handles an empty path without crashing and stays under the docs base URL', () => {
    const result = service.buildDocsUrl('');
    expect(result.startsWith(site.docsBaseUrl)).toBe(true);
  });

  it('去除与 docsBaseUrl 路径后缀重复的 docs/ 前缀', () => {
    expect(service.buildDocsUrl('/docs/developer-guides/text-generation/qwen-mt'))
      .toBe('https://platform.qianwenai.com/docs/developer-guides/text-generation/qwen-mt');
  });

  it('不重复的路径保持不变', () => {
    expect(service.buildDocsUrl('developer-guides/text-generation/qwen-mt'))
      .toBe('https://platform.qianwenai.com/docs/developer-guides/text-generation/qwen-mt');
  });
});

// ---------------------------------------------------------------------------
// loadDocsIndex — TTL-bounded cache + Markdown-link parsing.
// ---------------------------------------------------------------------------

const SAMPLE_LLMS_TXT = `# QianWen Docs

> Documentation index for QianWen platform

## Getting Started

- [Pricing](https://platform.qianwenai.com/docs/developer-guides/getting-started/pricing.md): Pay-as-you-go pricing for API usage
- [Quick Start](https://platform.qianwenai.com/docs/developer-guides/getting-started/quick-start.md): Get started with QianWen CLI

## Models

- [Model List](https://platform.qianwenai.com/docs/models/list.md): Available models catalog
- [Model Info](https://platform.qianwenai.com/docs/models/info.md): Detailed model information

## Resources

- [Free Quota](https://platform.qianwenai.com/docs/resources/free-quota.md): Free-tier quota details
- [FAQ Billing](https://platform.qianwenai.com/docs/resources/faq-billing.md): Payments and costs Q&A
`;

describe('DocsService.loadDocsIndex', () => {
  let service: DocsService;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let cachePath: string;

  beforeEach(() => {
    pathsState.cacheDir = mkdtempSync(join(tmpdir(), 'qianwen-llms-index-'));
    cachePath = join(pathsState.cacheDir, 'llms-index.json');
    service = new DocsService(makeMockApiClient());
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(pathsState.cacheDir, { recursive: true, force: true });
    pathsState.cacheDir = '';
  });

  it('reads a fresh local cache and skips the HTTP fetch', async () => {
    const cached: DocsIndexEntry[] = [
      {
        path: 'developer-guides/getting-started/pricing',
        fullUrl: 'https://platform.qianwenai.com/docs/developer-guides/getting-started/pricing.md',
        title: 'Pricing',
        description: 'Pay-as-you-go pricing for API usage',
        section: 'Getting Started',
      },
    ];
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: new Date().toISOString(), entries: cached }),
      'utf8',
    );

    const result = await service.loadDocsIndex();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('developer-guides/getting-started/pricing');
    expect(result[0].title).toBe('Pricing');
  });

  it('refreshes the cache and refetches when the on-disk entry is older than 24h', async () => {
    const stale: DocsIndexEntry[] = [
      {
        path: 'old/entry',
        fullUrl: 'https://platform.qianwenai.com/docs/old/entry.md',
        title: 'Old',
        description: 'stale',
        section: 'Old',
      },
    ];
    const staleFetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: staleFetchedAt, entries: stale }), 'utf8');
    fetchSpy.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => SAMPLE_LLMS_TXT,
    });

    const result = await service.loadDocsIndex();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchSpy.mock.calls[0][0]);
    expect(requestedUrl).toContain('llms.txt');
    // Returned data must reflect the fresh fetch, not the stale cache.
    expect(result.find((e) => e.path === 'old/entry')).toBeUndefined();
    expect(result.find((e) => e.path === 'developer-guides/getting-started/pricing')).toBeDefined();
    // Cache file must be updated on disk so the next call re-uses the fresh data.
    expect(existsSync(cachePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      entries: DocsIndexEntry[];
    };
    expect(
      persisted.entries.find((e) => e.path === 'developer-guides/getting-started/pricing'),
    ).toBeDefined();
  });

  it('fetches and persists a fresh cache when no local cache exists', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => SAMPLE_LLMS_TXT,
    });

    const result = await service.loadDocsIndex();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.length).toBeGreaterThanOrEqual(6);
    expect(existsSync(cachePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      entries: DocsIndexEntry[];
    };
    expect(persisted.entries.length).toBe(result.length);
  });

  it('parses each Markdown-link entry into the documented field shape', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => SAMPLE_LLMS_TXT,
    });

    const result = await service.loadDocsIndex();

    const pricing = result.find((e) => e.title === 'Pricing');
    expect(pricing).toBeDefined();
    if (!pricing) return;
    expect(pricing.path).toBe('developer-guides/getting-started/pricing');
    expect(pricing.fullUrl).toBe(
      'https://platform.qianwenai.com/docs/developer-guides/getting-started/pricing.md',
    );
    expect(pricing.description).toBe('Pay-as-you-go pricing for API usage');
    expect(pricing.section).toBe('Getting Started');
  });

  it('returns an empty array when the upstream fetch rejects (silent degradation)', async () => {
    fetchSpy.mockRejectedValue(new Error('Network unreachable'));

    const result = await service.loadDocsIndex();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('returns an empty array when the upstream returns a non-200 status', async () => {
    fetchSpy.mockResolvedValue({
      status: 503,
      ok: false,
      text: async () => 'Service Unavailable',
    });

    const result = await service.loadDocsIndex();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('tolerates malformed llms.txt content without throwing', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => 'not a llms.txt file\nrandom garbage\n###\n',
    });

    const result = await service.loadDocsIndex();

    expect(Array.isArray(result)).toBe(true);
    expect(result.every((e) => typeof e.path === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveDocPath — pure path → ResolveResult mapper.
// ---------------------------------------------------------------------------

function makeIndex(): DocsIndexEntry[] {
  return [
    {
      path: 'developer-guides/getting-started/pricing',
      fullUrl: 'https://platform.qianwenai.com/docs/developer-guides/getting-started/pricing.md',
      title: 'Pricing',
      description: 'Pay-as-you-go pricing for API usage',
      section: 'Getting Started',
    },
    {
      path: 'developer-guides/getting-started/quick-start',
      fullUrl: 'https://platform.qianwenai.com/docs/developer-guides/getting-started/quick-start.md',
      title: 'Quick Start',
      description: 'Get started with QianWen CLI',
      section: 'Getting Started',
    },
    {
      path: 'token-plan/overview',
      fullUrl: 'https://platform.qianwenai.com/docs/token-plan/overview.md',
      title: 'Token Plan Overview',
      description: 'Token Plan subscription overview',
      section: 'Token Plan',
    },
    {
      path: 'subscription/overview',
      fullUrl: 'https://platform.qianwenai.com/docs/subscription/overview.md',
      title: 'Subscription Overview',
      description: 'Subscription program overview',
      section: 'Subscription',
    },
    {
      path: 'resources/faq-billing',
      fullUrl: 'https://platform.qianwenai.com/docs/resources/faq-billing.md',
      title: 'Billing FAQ',
      description: 'Payments and costs Q&A',
      section: 'Resources',
    },
  ];
}

describe('DocsService.resolveDocPath', () => {
  let service: DocsService;

  beforeEach(() => {
    service = new DocsService(makeMockApiClient());
  });

  it('returns an exact match when input fully equals an indexed path', () => {
    const index = makeIndex();
    const result = service.resolveDocPath('developer-guides/getting-started/pricing', index);

    expect(result.type).toBe('exact');
    if (result.type === 'exact') {
      expect(result.url).toBe(
        'https://platform.qianwenai.com/docs/developer-guides/getting-started/pricing.md',
      );
    }
  });

  it('treats a unique tail-fragment match as an exact resolution', () => {
    const index = makeIndex();
    const result = service.resolveDocPath('pricing', index);

    expect(result.type).toBe('exact');
    if (result.type === 'exact') {
      expect(result.url).toContain('developer-guides/getting-started/pricing');
    }
  });

  it('returns ambiguous when several entries share the same trailing segment', () => {
    const index = makeIndex();
    const result = service.resolveDocPath('overview', index);

    expect(result.type).toBe('ambiguous');
    if (result.type === 'ambiguous') {
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      const paths = result.candidates.map((c) => c.path);
      expect(paths).toContain('token-plan/overview');
      expect(paths).toContain('subscription/overview');
    }
  });

  it('returns notfound with fuzzy suggestions when input is a near-miss typo', () => {
    const index = makeIndex();
    // 'pricng' has no exact path, no suffix match, but is fuzzily close to 'pricing'.
    const result = service.resolveDocPath('pricng', index);

    expect(result.type).toBe('notfound');
    if (result.type === 'notfound') {
      expect(Array.isArray(result.suggestions)).toBe(true);
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
      expect(result.suggestions.some((s) => s.path.includes('pricing'))).toBe(true);
    }
  });

  it('returns notfound with empty suggestions when input has no overlap at all', () => {
    const index = makeIndex();
    const result = service.resolveDocPath('xyzzy-completely-unrelated-keyword', index);

    expect(result.type).toBe('notfound');
    if (result.type === 'notfound') {
      expect(result.suggestions).toEqual([]);
    }
  });

  it('returns notfound when the index itself is empty', () => {
    const result = service.resolveDocPath('developer-guides/getting-started/pricing', []);

    expect(result.type).toBe('notfound');
    if (result.type === 'notfound') {
      expect(result.suggestions).toEqual([]);
    }
  });

  it('caps the suggestion list at five entries when many candidates exist', () => {
    const oversized: DocsIndexEntry[] = [];
    for (let i = 0; i < 12; i++) {
      oversized.push({
        path: `section-${i}/pricing-detail`,
        fullUrl: `https://platform.qianwenai.com/docs/section-${i}/pricing-detail.md`,
        title: `Pricing detail ${i}`,
        description: 'Pricing-related guide',
        section: `Section ${i}`,
      });
    }

    // 'pricing-detail' is the trailing segment of every entry → ambiguous with
    // 12 candidates pre-cap.
    const result = service.resolveDocPath('pricing-detail', oversized);

    expect(result.type).toBe('ambiguous');
    if (result.type === 'ambiguous') {
      expect(result.candidates.length).toBeLessThanOrEqual(5);
      expect(result.candidates.length).toBeGreaterThan(0);
    }
  });
});
