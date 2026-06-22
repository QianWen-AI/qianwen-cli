/**
 * Cache layer type definitions.
 * Provides interfaces for the two-tier (L1 memory + L2 file) caching strategy.
 */

/** File-based cache interface (generic for testability). */
export interface FileCache {
  get<T>(key: string): T | null;
  set<T>(key: string, data: T, ttl?: number): void;
  delete(key: string): void;
}

export type CacheKey = string;

export interface CachedFetcher {
  /**
   * Resolve a value through two-tier cache:
   *   1. L1 (memory) hit → return immediately
   *   2. L2 (file) hit → promote to L1, return
   *   3. miss → call fetcher(), write to both L1 and L2, return
   *
   * On fetcher() rejection: error propagates to caller (no caching of errors).
   */
  getOrFetch<T>(
    key: CacheKey,
    ttl: number,
    fetcher: () => Promise<T>,
    opts?: { skipFileCache?: boolean },
  ): Promise<T>;

  invalidate(key: CacheKey): void;
}
