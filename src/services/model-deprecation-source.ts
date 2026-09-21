/**
 * Shared access to the CDN-hosted model retirement schedule. The pre-request
 * guard and the `models` list/detail views read the same manifest through this
 * module so a single fetch (served from the two-tier cache) drives both the
 * warning and the UI markers.
 */

import type { CachedFetcher } from '../types/cache.js';
import type { DeprecationEntry, DeprecationManifest } from '../types/model-deprecation.js';
import { addDiagnostic, isEnabled, startRequest, endRequest } from '../api/debug-buffer.js';
import { site } from '../site.js';
import { CacheKeys, getGlobalCache, getGlobalFileCache } from '../utils/cache.js';
import { createCachedFetcher } from './cache-strategy.js';
import { RETIRE_NOTICE_WINDOW_MS } from './model-lifecycle.js';

declare const __VERSION__: string;
declare const __NODE_ENV__: string;

/** CDN URL of the retirement schedule. In dev builds, QIANWEN_CDN_ENDPOINT
 *  overrides the configured URL for local testing. */
export const CDN_DEPRECATION_URL =
  typeof __NODE_ENV__ === 'undefined' || __NODE_ENV__ !== 'production'
    ? process.env.QIANWEN_CDN_ENDPOINT || site.features.modelOfflineUrl
    : site.features.modelOfflineUrl;

/** Public changelog entry for retiring models. */
export const CHANGELOG_URL = `${site.docsBaseUrl}/changelog/model-deprecation`;

// #下线模型列表 (URL-encoded for terminal compatibility)
export const ANNOUNCEMENT_URL = `${CHANGELOG_URL}#%E4%B8%8B%E7%BA%BF%E6%A8%A1%E5%9E%8B%E5%88%97%E8%A1%A8`;

const CACHE_TTL_DEPRECATIONS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Fetch the manifest from the CDN, failing open with an empty list. */
export async function fetchDeprecationManifestFromCdn(): Promise<DeprecationManifest> {
  const debugId = isEnabled()
    ? startRequest('GET', CDN_DEPRECATION_URL, {}, null, 'modelDeprecations')
    : -1;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CDN_DEPRECATION_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': `qianwen-cli/${typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0'}`,
      },
    });
    if (debugId >= 0) {
      endRequest(debugId, response.status, response.statusText, null, !response.ok);
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch model deprecations: ${response.status}`);
    }
    return normalizeManifest(await response.json());
  } catch (error) {
    if (isEnabled()) {
      addDiagnostic(
        'ModelDeprecation',
        `Failed to load model deprecations: ${error instanceof Error ? error.message : String(error)}`,
        'debug',
      );
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Load the manifest through the shared two-tier cache. */
export async function loadDeprecationManifest(
  cache: CachedFetcher,
  fetchManifest: () => Promise<DeprecationManifest> = fetchDeprecationManifestFromCdn,
): Promise<DeprecationManifest> {
  return cache.getOrFetch(CacheKeys.MODELS_DEPRECATIONS, CACHE_TTL_DEPRECATIONS, fetchManifest);
}

/** Read-only view over a manifest, keyed by model id. */
export class DeprecationLookup {
  private readonly byId: Map<string, DeprecationEntry>;

  constructor(
    manifest: DeprecationManifest,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.byId = new Map(manifest.map((entry) => [entry.id, entry]));
  }

  /** The scheduled retirement instant (ms) for a model, or null when absent/undated. */
  retireAt(id: string): number | null {
    const entry = this.byId.get(id);
    if (!entry?.expiredTime) return null;
    const at = Date.parse(entry.expiredTime);
    return Number.isNaN(at) ? null : at;
  }

  /** True when the model is scheduled to retire within the notice window. */
  isRetiring(id: string): boolean {
    const at = this.retireAt(id);
    if (at == null) return false;
    const now = this.now();
    return now < at && at - now <= RETIRE_NOTICE_WINDOW_MS;
  }

  /** The raw ISO retirement instant for a model that is still retiring, else null. */
  retireIso(id: string): string | null {
    if (!this.isRetiring(id)) return null;
    return this.byId.get(id)?.expiredTime ?? null;
  }
}

/** Build a lookup backed by the shared two-tier cache. */
export async function createDeprecationLookup(now?: () => number): Promise<DeprecationLookup> {
  const cache = createCachedFetcher(getGlobalCache(), getGlobalFileCache());
  const manifest = await loadDeprecationManifest(cache).catch(() => [] as DeprecationManifest);
  return new DeprecationLookup(manifest, now);
}

/** Coerce an untrusted CDN payload into a manifest, dropping malformed rows. */
export function normalizeManifest(raw: unknown): DeprecationManifest {
  if (!Array.isArray(raw)) return [];

  const entries: DeprecationEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    const entry: DeprecationEntry = { id };
    if (typeof record.expiredTime === 'string' && record.expiredTime) {
      entry.expiredTime = record.expiredTime;
    }
    entries.push(entry);
  }
  return entries;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Format an ISO instant (with offset) as `Month D, YYYY` in its own timezone. */
export function formatRetireDateLong(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1] ?? month;
  return `${name} ${Number(day)}, ${year}`;
}
