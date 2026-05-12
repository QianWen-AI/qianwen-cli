// ============================================================
// Local cache utility
// In-memory cache with expiration, used to reduce API calls.
// ============================================================

interface CacheEntry<T> {
  data: T;
  expiresAt: number; // Expiration timestamp (milliseconds)
  createdAt: number; // Creation timestamp (milliseconds)
}

export interface CacheOptions {
  ttl: number; // Cache time-to-live (milliseconds)
}

/**
 * In-memory cache implementation.
 *
 * Features:
 * - Supports a custom TTL (Time To Live)
 * - Automatically cleans up expired entries
 * - Thread-safe (single-threaded Node.js environment)
 */
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
