/**
 * Two-tier cached fetcher (L1 memory + L2 file).
 * Provides a unified getOrFetch interface that resolves through:
 *   L1 hit → return immediately
 *   L2 hit → promote to L1, return
 *   miss → call upstream, write both tiers, return
 */

import type { MemoryCache } from '../utils/cache.js';
import type { FileCache, CacheKey, CachedFetcher } from '../types/cache.js';

// Re-export types so existing consumers can still import from this module
export type { FileCache, CacheKey, CachedFetcher } from '../types/cache.js';

// ────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────

export function createCachedFetcher(memoryCache: MemoryCache, fileCache: FileCache): CachedFetcher {
  return {
    async getOrFetch<T>(
      key: CacheKey,
      ttl: number,
      fetcher: () => Promise<T>,
      opts?: { skipFileCache?: boolean },
    ): Promise<T> {
      // L1 check (always)
      const l1Value = memoryCache.get<T>(key);
      if (l1Value !== null) {
        return l1Value;
      }

      // L2 check (unless skipFileCache)
      if (!opts?.skipFileCache) {
        const l2Value = fileCache.get<T>(key);
        if (l2Value !== null) {
          // Promote to L1
          memoryCache.set(key, l2Value, ttl);
          return l2Value;
        }
      }

      // Full miss — call upstream
      const freshValue = await fetcher();

      // Write both tiers
      memoryCache.set(key, freshValue, ttl);
      fileCache.set(key, freshValue, ttl);

      return freshValue;
    },

    invalidate(key: CacheKey): void {
      memoryCache.delete(key);
      fileCache.delete(key);
    },
  };
}
