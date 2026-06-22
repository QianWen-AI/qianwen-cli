// ============================================================
// Local cache utility
// In-memory cache with expiration, used to reduce API calls.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { getCacheFilePath } from '../config/paths.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number; // Expiration timestamp (milliseconds)
  createdAt: number; // Creation timestamp (milliseconds)
}

export interface CacheOptions {
  ttl: number; // Cache time-to-live (milliseconds)
}

/** In-memory cache with TTL-based expiration. */
export class MemoryCache {
  private store: Map<string, CacheEntry<unknown>> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private defaultTTL: number = 5 * 60 * 1000) {
    // Default: 5 minutes
    // Automatically clean up expired entries every minute
    this.startCleanup(60 * 1000);
  }

  /**
   * Get cached data.
   * @param key Cache key
   * @returns The cached data, or null if it does not exist or has expired
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      return null;
    }

    // Check whether the entry has expired
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set cached data.
   * @param key Cache key
   * @param data The data to cache
   * @param ttl Optional custom expiration time (milliseconds)
   */
  set<T>(key: string, data: T, ttl?: number): void {
    const now = Date.now();
    const actualTTL = ttl ?? this.defaultTTL;

    this.store.set(key, {
      data,
      createdAt: now,
      expiresAt: now + actualTTL,
    } as CacheEntry<unknown>);
  }

  /**
   * Delete cached data.
   * @param key Cache key
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Check whether the cache entry exists and has not expired.
   * @param key Cache key
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.store.size,
      keys: Array.from(this.store.keys()),
    };
  }

  /**
   * Clean up all expired entries.
   */
  private cleanup(): void {
    const now = Date.now();
    let _cleanedCount = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        _cleanedCount++;
      }
    }
  }

  /**
   * Start the periodic cleanup.
   */
  private startCleanup(interval: number): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, interval);
    // Prevent the timer from blocking Node.js process exit (critical for one-shot CLI mode)
    this.cleanupInterval.unref();
  }

  /**
   * Stop the periodic cleanup (for resource cleanup).
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

// ============================================================
// Cache key constants
// Note: only the model list and model details are cached; all other data
// (usage, auth, etc.) is queried in real time.
// ============================================================

export const CacheKeys = {
  MODELS_RAW_LIST: 'models:raw_list',
  MODEL_MAPPING: 'models:mapping',
} as const;

export type CacheKey = (typeof CacheKeys)[keyof typeof CacheKeys];

/**
 * Stable file names per cache key. Hand-picked so users can locate or clear
 * a single entry without parsing the file content.
 */
export const CacheFileNames: Record<CacheKey, string> = {
  [CacheKeys.MODELS_RAW_LIST]: 'models-raw-list.json',
  [CacheKeys.MODEL_MAPPING]: 'model-mapping.json',
};

// ============================================================
// Default cache configuration
// Note: only model data is cached; all other data (usage, auth, etc.)
// is queried in real time.
// ============================================================

export const CacheTTL = {
  MODELS_LIST: 10 * 60 * 1000, // Raw model data: 10 minutes (excluding quota)
  MODEL_MAPPING: 10 * 60 * 1000, // Model mapping: 10 minutes
} as const;

// ============================================================
// Global cache instance
// ============================================================

let globalCache: MemoryCache | null = null;

/**
 * Get the global cache instance.
 */
export function getGlobalCache(): MemoryCache {
  if (!globalCache) {
    globalCache = new MemoryCache(5 * 60 * 1000); // Default 5-minute TTL
  }
  return globalCache;
}

/**
 * Reset the global cache (for tests).
 */
export function resetGlobalCache(): void {
  if (globalCache) {
    globalCache.dispose();
    globalCache = null;
  }
}

// ============================================================
// File cache (cross-process, one-shot mode)
//
// Persists a small set of cache entries to ~/.qianwen/cache/<file>.json so
// each one-shot CLI invocation does not re-fetch slow upstream resources
// (model list, model-mapping). Reliability requirements:
//   - Validity is determined entirely by self-describing fields inside the
//     file (schemaVersion, key, endpoint, expiresAt). No reliance on file
//     mtime / atime, file locks, inotify, or any other OS facility.
//   - Any read/parse error, schema mismatch, endpoint mismatch or expiry
//     produces a miss; the caller is expected to refetch and overwrite.
//   - Writes are atomic via tmp-file + rename, safe under concurrent
//     one-shot invocations (last writer wins; never half-written).
// ============================================================

declare const __VERSION__: string;

/**
 * On-disk schema version. Bump when the envelope shape changes; older files
 * with a different value are treated as miss and overwritten.
 */
export const FILE_CACHE_SCHEMA_VERSION = 1;

interface FileCacheEnvelope<T> {
  schemaVersion: number;
  cliVersion: string;
  endpoint: string;
  key: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  data: T;
}

export interface FileCacheContext {
  /** Current API endpoint (api.endpoint). Read entries with a different endpoint are evicted. */
  endpoint: string;
  /** TTL in milliseconds for the next write. `0` disables both read and write. */
  ttlMs: number;
}

/**
 * Resolver for the runtime context. Injected so that this module does not
 * depend on the config manager at import time (and tests can override).
 */
export type FileCacheContextResolver = () => FileCacheContext;

let contextResolver: FileCacheContextResolver | null = null;

/**
 * Wire the file cache to a context resolver. Called once during process
 * startup (or in tests). When unset, the file cache behaves as disabled.
 */
export function setFileCacheContextResolver(resolver: FileCacheContextResolver | null): void {
  contextResolver = resolver;
}

function resolveContext(): FileCacheContext | null {
  if (!contextResolver) return null;
  try {
    return contextResolver();
  } catch {
    return null;
  }
}

function currentCliVersion(): string {
  return typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0';
}

function filePathFor(key: CacheKey): string | null {
  const fileName = CacheFileNames[key];
  if (!fileName) return null;
  return getCacheFilePath(fileName);
}

export class FileCache {
  /**
   * Read a cache entry from disk. Returns `null` on any failure path:
   * file missing, parse error, schema/key/endpoint mismatch, or expired.
   * Never throws.
   */
  get<T>(key: CacheKey): T | null {
    const ctx = resolveContext();
    if (!ctx || ctx.ttlMs <= 0) return null; // disabled

    const path = filePathFor(key);
    if (!path || !existsSync(path)) return null;

    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }

    let parsed: FileCacheEnvelope<T>;
    try {
      parsed = JSON.parse(raw) as FileCacheEnvelope<T>;
    } catch {
      this.safeUnlink(path);
      return null;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== FILE_CACHE_SCHEMA_VERSION ||
      parsed.key !== key ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.endpoint !== 'string'
    ) {
      this.safeUnlink(path);
      return null;
    }

    if (parsed.endpoint !== ctx.endpoint) {
      // Stale entry from a different upstream; drop it.
      this.safeUnlink(path);
      return null;
    }

    if (Date.now() > parsed.expiresAt) {
      this.safeUnlink(path);
      return null;
    }

    return parsed.data;
  }

  /**
   * Persist a cache entry. Honours `ttlMs === 0` (disabled) by skipping the
   * write. All errors are swallowed so the cache layer never breaks the
   * primary request flow.
   */
  set<T>(key: CacheKey, data: T): void {
    const ctx = resolveContext();
    if (!ctx || ctx.ttlMs <= 0) return; // disabled

    const path = filePathFor(key);
    if (!path) return;

    const now = Date.now();
    const envelope: FileCacheEnvelope<T> = {
      schemaVersion: FILE_CACHE_SCHEMA_VERSION,
      cliVersion: currentCliVersion(),
      endpoint: ctx.endpoint,
      key,
      createdAt: now,
      expiresAt: now + ctx.ttlMs,
      ttlMs: ctx.ttlMs,
      data,
    };

    const dir = dirname(path);
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch {
      return;
    }

    // Write to a per-process tmp file then atomically rename. Safe under
    // concurrent one-shot invocations: rename within the same directory is
    // atomic on POSIX and Win32; readers either see the previous version or
    // the new one, never a partially written file.
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(tmpPath, JSON.stringify(envelope), 'utf-8');
      renameSync(tmpPath, path);
    } catch {
      // Best-effort cleanup of the tmp file; ignore errors.
      this.safeUnlink(tmpPath);
    }
  }

  /**
   * Remove a cache entry. Used by tests and by callers that detect a logical
   * inconsistency in the cached payload.
   */
  delete(key: CacheKey): void {
    const path = filePathFor(key);
    if (path) this.safeUnlink(path);
  }

  private safeUnlink(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* swallow */
    }
  }
}

let globalFileCache: FileCache | null = null;

/**
 * Get the global file cache instance.
 */
export function getGlobalFileCache(): FileCache {
  if (!globalFileCache) {
    globalFileCache = new FileCache();
  }
  return globalFileCache;
}

/**
 * Reset the global file cache (for tests).
 */
export function resetGlobalFileCache(): void {
  globalFileCache = null;
}
