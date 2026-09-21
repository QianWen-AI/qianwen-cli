/**
 * Pre-request notice for models scheduled to retire. Before a model is
 * invoked the guard consults a CDN-hosted schedule (fetched once, then served
 * from the two-tier cache). When the target model is listed but has not yet
 * reached its `expiredTime`, a one-time migration notice is written to stderr;
 * the call then proceeds normally. Models that are absent, already expired, or
 * whose schedule cannot be loaded produce no notice.
 */

import type { CachedFetcher } from '../types/cache.js';
import type { DeprecationEntry, DeprecationManifest } from '../types/model-deprecation.js';
import { theme } from '../ui/theme.js';
import { getGlobalCache, getGlobalFileCache } from '../utils/cache.js';
import { createCachedFetcher } from './cache-strategy.js';
import {
  ANNOUNCEMENT_URL,
  fetchDeprecationManifestFromCdn,
  loadDeprecationManifest,
} from './model-deprecation-source.js';
import { RETIRE_NOTICE_WINDOW_MS } from './model-lifecycle.js';

export interface ModelDeprecationGuardDeps {
  cache: CachedFetcher;
  now?: () => number;
  fetchManifest?: () => Promise<DeprecationManifest>;
  emit?: (line: string) => void;
}

export class ModelDeprecationGuard {
  private readonly now: () => number;
  private readonly fetchManifest: () => Promise<DeprecationManifest>;
  private readonly emit: (line: string) => void;
  private readonly notified = new Set<string>();

  constructor(private readonly deps: ModelDeprecationGuardDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.fetchManifest = deps.fetchManifest ?? fetchDeprecationManifestFromCdn;
    this.emit = deps.emit ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /**
   * Warn once, before the request, when the model is scheduled to retire but is
   * still callable. Never blocks the call.
   */
  async notifyIfDeprecated(model: string): Promise<string | null> {
    if (this.notified.has(model)) return null;

    const manifest = await this.loadManifest().catch(() => null);
    if (!manifest) return null;

    const entry = manifest.find((m) => m.id === model);
    if (!entry || !entry.expiredTime) return null;

    const expiresAt = Date.parse(entry.expiredTime);
    if (Number.isNaN(expiresAt) || this.now() >= expiresAt) return null;
    if (expiresAt - this.now() > RETIRE_NOTICE_WINDOW_MS) return null;

    this.notified.add(model);
    const plain = this.plainNotice(model, entry);
    this.emit(this.styledNotice(plain));
    return plain;
  }

  /** Plain text notice suitable for JSON `warnings` and non-TTY stderr. */
  private plainNotice(model: string, entry: DeprecationEntry): string {
    const date = formatRetireDate(entry.expiredTime as string);
    return `${model} 将于 ${date} 下线，请提前迁移。详情：${ANNOUNCEMENT_URL}`;
  }

  /** Styled notice for TTY stderr (symbol + colour). */
  private styledNotice(plain: string): string {
    if (!process.stderr.isTTY) return plain;
    return `${theme.warning(theme.symbols.warn)} ${theme.warning(plain)}`;
  }

  private async loadManifest(): Promise<DeprecationManifest> {
    return loadDeprecationManifest(this.deps.cache, this.fetchManifest);
  }
}

/** Format an ISO instant (with offset) as `YYYY年M月D日` in its own timezone. */
function formatRetireDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

/** Build a guard backed by the shared two-tier cache. */
export function createModelDeprecationGuard(options?: { silent?: boolean }): ModelDeprecationGuard {
  return new ModelDeprecationGuard({
    cache: createCachedFetcher(getGlobalCache(), getGlobalFileCache()),
    ...(options?.silent ? { emit: () => {} } : {}),
  });
}
