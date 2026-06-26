/** Public docs search via the flat-parameter protocol. */

import type { ApiClient } from '../api/api-client.js';
import type {
  DocContentResult,
  DocsIndexEntry,
  DocsSearchItem,
  DocsSearchResponse,
  RawSearchAllItem,
  RawSearchAllResponse,
  ResolveResult,
} from '../types/docs.js';
import { API_PRODUCT_SEARCH, API_ACTION_SEARCH_ALL } from '../types/api-routes.js';
import { site } from '../site.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getCacheFilePath } from '../config/paths.js';

export interface DocsSearchOptions {
  query: string;
  limit?: number;
  page?: number;
  language?: 'en' | 'zh';
}

const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;
const MAX_LIMIT = 100;

const FETCH_DOC_TIMEOUT = 10_000;

const LLMS_INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const LLMS_INDEX_CACHE_FILE = 'llms-index.json';
const LLMS_INDEX_FETCH_TIMEOUT = 10_000;
const MAX_CANDIDATES = 5;

interface LlmsIndexCacheEnvelope {
  fetchedAt: number | string;
  entries: DocsIndexEntry[];
}

/**
 * Resolve a docs path (relative or absolute) to a full URL against the
 * configured docs base. Absolute http(s) URLs are passed through as-is so
 * users can paste a docs link verbatim. Anchors (`#section`) are preserved
 * verbatim — `fetchDocContent` strips them before issuing the request.
 */
export function buildDocsUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const base = (site.docsBaseUrl ?? '').replace(/\/+$/, '');
  let normalized = path.replace(/^\/+/, '');
  if (normalized === 'docs' || normalized.startsWith('docs/')) {
    normalized = normalized.slice(normalized.indexOf('/') === -1 ? 4 : 5);
  }
  const anchorIdx = normalized.indexOf('#');
  let anchor = '';
  if (anchorIdx !== -1) {
    anchor = normalized.slice(anchorIdx);
    normalized = normalized.slice(0, anchorIdx);
  }
  if (normalized.endsWith('.md')) {
    normalized = normalized.slice(0, -3);
  }
  return `${base}/${normalized}${anchor}`;
}

export class DocsService {
  constructor(private readonly apiClient: ApiClient) {}

  /** Resolve a docs path against the configured base URL. */
  buildDocsUrl(path: string): string {
    return buildDocsUrl(path);
  }

  async fetchDocContent(url: string): Promise<DocContentResult> {
    let anchor: string | null = null;
    let baseUrl = url;

    const hashIndex = url.indexOf('#');
    if (hashIndex !== -1) {
      anchor = url.slice(hashIndex + 1) || null;
      baseUrl = url.slice(0, hashIndex);
    }

    // Whitelist extensions that are fetched verbatim; everything else is
    // treated as a docs slug and resolved to its `.md` source.
    const ALLOWED_EXTENSIONS = /\.(json|txt|md)$/i;
    const resolvedMarkdownUrl = ALLOWED_EXTENSIONS.test(baseUrl) ? baseUrl : baseUrl + '.md';

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_DOC_TIMEOUT);

      const MAX_REDIRECTS = 5;
      let currentUrl = resolvedMarkdownUrl;
      let redirectCount = 0;
      let response: Response;

      while (true) {
        response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { Accept: 'text/plain, text/markdown' },
        });

        if (response.status >= 300 && response.status < 400) {
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            clearTimeout(timer);
            return {
              url,
              resolvedMarkdownUrl,
              content: null,
              error: 'Cannot open this document.',
              anchor,
            };
          }
          const location = response.headers.get('location');
          if (!location) {
            clearTimeout(timer);
            return {
              url,
              resolvedMarkdownUrl,
              content: null,
              error: 'Cannot open this document.',
              anchor,
            };
          }
          const redirectTarget = new URL(location, currentUrl);
          const rHost = redirectTarget.hostname;
          if (rHost !== 'qianwenai.com' && !rHost.endsWith('.qianwenai.com')) {
            clearTimeout(timer);
            return {
              url,
              resolvedMarkdownUrl,
              content: null,
              error: 'Cannot open this document.',
              anchor,
            };
          }
          currentUrl = redirectTarget.href;
          continue;
        }
        break;
      }
      clearTimeout(timer);

      if (response.status !== 200) {
        return {
          url,
          resolvedMarkdownUrl,
          content: null,
          error: `HTTP ${response.status}`,
          anchor,
        };
      }

      const content = await response.text();
      return { url, resolvedMarkdownUrl, content, error: null, anchor };
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Request timed out'
          : err instanceof Error
            ? err.message
            : 'Unknown error';
      return { url, resolvedMarkdownUrl, content: null, error: message, anchor };
    }
  }

  /** Perform a docs search. The query is required; pagination defaults
   *  follow the documented public contract. */
  async searchDocs(options: DocsSearchOptions): Promise<DocsSearchResponse> {
    const query = (options.query ?? '').trim();
    const limit = clampLimit(options.limit);
    const page = clampPage(options.page);
    const language = options.language ?? defaultLanguage();

    const raw = await this.apiClient.callFlatApi<RawSearchAllResponse | null>({
      product: API_PRODUCT_SEARCH,
      action: API_ACTION_SEARCH_ALL,
      params: {
        CommonParams: {
          Loc: '2024SPAllResult',
          From: 'pc',
          CookieId: '',
        },
        QuerySceneParams: {
          QueryWord: query,
          Limit: limit,
          PageNo: page,
          Language: language,
          BizType: 'doc',
        },
      },
      authOptional: true,
    });

    return normalizeSearchAllResponse(raw, { page, pageSize: limit });
  }

  /**
   * Load the docs directory index from `llms.txt`.
   *
   * Reads from a 24-hour local cache when fresh, otherwise fetches the
   * upstream index and persists a new cache. Any failure (network,
   * filesystem, parse) returns an empty array so callers can degrade
   * gracefully — the index is an enhancement, never a hard dependency.
   */
  async loadDocsIndex(): Promise<DocsIndexEntry[]> {
    return loadDocsIndex();
  }

  /** Resolve a user-supplied path against the loaded index. */
  resolveDocPath(input: string, index: DocsIndexEntry[]): ResolveResult {
    return resolveDocPath(input, index);
  }
}

/** Module-level loader; mirrors `DocsService.loadDocsIndex`. */
export async function loadDocsIndex(): Promise<DocsIndexEntry[]> {
  const cached = readIndexCache();
  const cachedAtMs = cached ? toMillis(cached.fetchedAt) : null;
  if (cached && cachedAtMs !== null && Date.now() - cachedAtMs < LLMS_INDEX_TTL_MS) {
    return cached.entries;
  }

  const fresh = await fetchLlmsIndex();
  if (fresh.length === 0) {
    return cached?.entries ?? [];
  }

  writeIndexCache({ fetchedAt: Date.now(), entries: fresh });
  return fresh;
}

function toMillis(value: number | string): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Module-level resolver; mirrors `DocsService.resolveDocPath`. */
export function resolveDocPath(input: string, index: DocsIndexEntry[]): ResolveResult {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0 || index.length === 0) {
    return { type: 'notfound', suggestions: [] };
  }

  // Split off anchor; matching is performed on the path portion only and the
  // anchor is reattached to the resolved URL on success.
  const hashIdx = trimmed.indexOf('#');
  const rawPath = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? '' : trimmed.slice(hashIdx);
  const normalized = rawPath.replace(/^\/+/, '').replace(/\.md$/i, '').toLowerCase();

  if (normalized.length === 0) {
    return { type: 'notfound', suggestions: [] };
  }

  const exactHits = index.filter((e) => e.path.toLowerCase() === normalized);
  if (exactHits.length === 1) {
    return { type: 'exact', url: exactHits[0].fullUrl + anchor };
  }
  if (exactHits.length > 1) {
    return { type: 'ambiguous', candidates: exactHits.slice(0, MAX_CANDIDATES) };
  }

  const suffixHits = index.filter((e) => {
    const p = e.path.toLowerCase();
    return p === normalized || p.endsWith('/' + normalized);
  });
  if (suffixHits.length === 1) {
    return { type: 'exact', url: suffixHits[0].fullUrl + anchor };
  }
  if (suffixHits.length > 1) {
    return { type: 'ambiguous', candidates: suffixHits.slice(0, MAX_CANDIDATES) };
  }

  const tokens = tokenize(normalized);
  if (tokens.length > 0) {
    // Pass A: literal substring match — every token must appear verbatim in
    // the path or title. This catches keyword-style queries (e.g. `pricing`)
    // even when the canonical path differs in nesting depth.
    const literalHits = index.filter((entry) => allTokensLiteralMatch(entry, tokens));
    if (literalHits.length > 0) {
      return {
        type: 'ambiguous',
        candidates: literalHits.slice(0, MAX_CANDIDATES),
      };
    }

    // Pass B: Levenshtein-tolerant near-miss search for typos. Returned as
    // `notfound` with suggestions so the caller can still attempt a direct
    // fetch (the index may legitimately be incomplete) while showing a
    // "Did you mean?" hint when the fetch ultimately 404s.
    const typoHits = index
      .map((entry) => ({ entry, score: typoScore(entry, tokens) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score);
    if (typoHits.length > 0) {
      return {
        type: 'notfound',
        suggestions: typoHits.slice(0, MAX_CANDIDATES).map((m) => m.entry),
      };
    }
  }

  return { type: 'notfound', suggestions: [] };
}

function allTokensLiteralMatch(entry: DocsIndexEntry, tokens: string[]): boolean {
  const haystackPath = entry.path.toLowerCase();
  const haystackTitle = entry.title.toLowerCase();
  return tokens.every((t) => haystackPath.includes(t) || haystackTitle.includes(t));
}

function tokenize(value: string): string[] {
  return value
    .split(/[/\-_\s]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

function typoScore(entry: DocsIndexEntry, tokens: string[]): number {
  const haystackPath = entry.path.toLowerCase();
  const haystackTitle = entry.title.toLowerCase();
  const pathSegments = haystackPath.split(/[/\-_\s]+/).filter((s) => s.length > 0);
  const titleSegments = haystackTitle.split(/[\s\-_]+/).filter((s) => s.length > 0);
  const segments = [...pathSegments, ...titleSegments];

  let score = 0;
  for (const t of tokens) {
    if (haystackPath.includes(t) || haystackTitle.includes(t)) {
      score += 2;
      continue;
    }
    const tolerance = Math.max(1, Math.floor(t.length / 4));
    let best = tolerance + 1;
    for (const seg of segments) {
      const d = levenshtein(t, seg, tolerance + 1);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best <= tolerance) score += 1;
  }
  return score;
}

/**
 * Bounded Levenshtein distance with early exit when the running minimum
 * exceeds `cutoff`. Returns `cutoff` (or higher) for fully-rejected pairs.
 */
function levenshtein(a: string, b: string, cutoff: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > cutoff) return cutoff;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cutoff) return cutoff;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

function readIndexCache(): LlmsIndexCacheEnvelope | null {
  const path = getCacheFilePath(LLMS_INDEX_CACHE_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as LlmsIndexCacheEnvelope;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (typeof parsed.fetchedAt !== 'number' && typeof parsed.fetchedAt !== 'string') ||
      !Array.isArray(parsed.entries)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeIndexCache(envelope: LlmsIndexCacheEnvelope): void {
  const path = getCacheFilePath(LLMS_INDEX_CACHE_FILE);
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(envelope), 'utf-8');
  } catch {
    // Cache writes are best-effort; failures fall through silently.
  }
}

async function fetchLlmsIndex(): Promise<DocsIndexEntry[]> {
  const base = (site.docsBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) return [];
  const url = `${base}/llms.txt`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLMS_INDEX_FETCH_TIMEOUT);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' },
    });
    clearTimeout(timer);
    if (response.status !== 200) return [];
    const text = await response.text();
    return parseLlmsIndex(text, base);
  } catch {
    return [];
  }
}

/**
 * Parse a Markdown llms.txt body into structured entries.
 *
 * Recognised line forms:
 *   `## Section name`        → switches the current section heading
 *   `- [Title](url): Desc`   → an entry; the description after `:` is optional
 */
export function parseLlmsIndex(body: string, baseUrl: string): DocsIndexEntry[] {
  const entries: DocsIndexEntry[] = [];
  const baseNoSlash = baseUrl.replace(/\/+$/, '');
  const sectionRe = /^#{2,6}\s+(.+?)\s*$/;
  const linkRe = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.*))?$/;
  let section = '';
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const sectionMatch = sectionRe.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const linkMatch = linkRe.exec(line);
    if (!linkMatch) continue;
    const title = linkMatch[1].trim();
    const fullUrl = linkMatch[2].trim();
    const description = (linkMatch[3] ?? '').trim();
    const path = deriveIndexPath(fullUrl, baseNoSlash);
    if (path.length === 0) continue;
    entries.push({ path, fullUrl, title, description, section });
  }
  return entries;
}

function deriveIndexPath(fullUrl: string, base: string): string {
  let p = fullUrl;
  if (base && p.startsWith(base)) {
    p = p.slice(base.length);
  } else {
    // Try generic protocol+host strip so an unexpected upstream host still parses.
    p = p.replace(/^https?:\/\/[^/]+/i, '');
  }
  return p.replace(/^\/+/, '').replace(/\.md$/i, '');
}

export function normalizeSearchAllResponse(
  raw: RawSearchAllResponse | null | undefined,
  fallback: { page: number; pageSize: number },
): DocsSearchResponse {
  // Prefer PascalCase (actual API) fields, fall back to camelCase (legacy/test).
  const rawItems = Array.isArray(raw?.Info)
    ? raw!.Info!
    : Array.isArray(raw?.items)
      ? raw!.items!
      : [];
  return {
    totalCount: raw?.TotalCount ?? raw?.totalCount ?? 0,
    page: raw?.PageNo ?? raw?.pageNo ?? fallback.page,
    pageSize: raw?.pageSize ?? fallback.pageSize,
    items: rawItems.map(normalizeSearchAllItem),
    rawItems,
  };
}

function normalizeSearchAllItem(item: RawSearchAllItem): DocsSearchItem {
  // Parse breadcrumb from nodesInfo JSON string (actual API), or use legacy breadcrumb array.
  let breadcrumb: string[] = [];
  if (Array.isArray(item.breadcrumb)) {
    breadcrumb = item.breadcrumb as string[];
  } else if (typeof item.nodesInfo === 'string' && item.nodesInfo.length > 0) {
    try {
      const nodes = JSON.parse(item.nodesInfo) as Array<{ nodeName?: string }>;
      breadcrumb = nodes.map((n) => n.nodeName ?? '').filter(Boolean);
    } catch {
      // ignore parse failures
    }
  }
  // Use content/description for summary when legacy summary is absent.
  const summary = item.summary ?? item.content ?? item.description ?? '';
  const highlightedSummary = item.highlightedSummary ?? item.content ?? item.description ?? '';
  return {
    title: item.title ?? '',
    highlightedTitle: item.highlightedTitle ?? item.title ?? '',
    subBizType: item.subBizType ?? '',
    url: item.url ?? '',
    summary,
    highlightedSummary,
    breadcrumb,
  };
}

function clampLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw as number) < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(raw as number));
}

function clampPage(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw as number) < 1) return DEFAULT_PAGE;
  return Math.floor(raw as number);
}

function defaultLanguage(): 'en' | 'zh' {
  return site.defaults.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
