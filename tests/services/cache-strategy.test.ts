/**
 * Tests for createCachedFetcher — the L1 (memory) + L2 (file) cache strategy.
 *
 * Strategy:
 *   - Build minimal in-memory stubs for MemoryCache + FileCache that record
 *     every interaction via vi.fn().
 *   - Walk through the documented L1 hit / L2 hit / full miss paths plus the
 *     skipFileCache branch and invalidate flow.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCachedFetcher } from '../../src/services/cache-strategy.js';
import type { MemoryCache } from '../../src/utils/cache.js';
import type { FileCache } from '../../src/types/cache.js';

interface MemStub extends MemoryCache {
  store: Map<string, unknown>;
}

function makeMemoryCache(): MemStub {
  const store = new Map<string, unknown>();
  // Only the three methods the strategy uses; cast through unknown is fine
  // because we never expose this stub outside the test boundary.
  const stub = {
    store,
    get: vi.fn(<T>(k: string): T | null => (store.has(k) ? (store.get(k) as T) : null)),
    set: vi.fn(<T>(k: string, v: T): void => {
      store.set(k, v);
    }),
    delete: vi.fn((k: string): void => {
      store.delete(k);
    }),
  };
  return stub as unknown as MemStub;
}

interface FileStub extends FileCache {
  store: Map<string, unknown>;
}

function makeFileCache(): FileStub {
  const store = new Map<string, unknown>();
  const stub = {
    store,
    get: vi.fn(<T>(k: string): T | null => (store.has(k) ? (store.get(k) as T) : null)),
    set: vi.fn(<T>(k: string, v: T): void => {
      store.set(k, v);
    }),
    delete: vi.fn((k: string): void => {
      store.delete(k);
    }),
  };
  return stub as unknown as FileStub;
}

describe('createCachedFetcher.getOrFetch', () => {
  it('returns the L1 value without invoking L2 or upstream on hit', async () => {
    const mem = makeMemoryCache();
    const file = makeFileCache();
    mem.store.set('k', 'l1-value');
    const fetcher = createCachedFetcher(mem, file);

    const upstream = vi.fn().mockResolvedValue('upstream-value');
    const out = await fetcher.getOrFetch('k', 60_000, upstream);

    expect(out).toBe('l1-value');
    expect(upstream).not.toHaveBeenCalled();
    expect(file.get).not.toHaveBeenCalled();
  });

  it('promotes L2 → L1 and skips upstream on L2 hit', async () => {
    const mem = makeMemoryCache();
    const file = makeFileCache();
    file.store.set('k', 'l2-value');
    const fetcher = createCachedFetcher(mem, file);

    const upstream = vi.fn().mockResolvedValue('upstream-value');
    const out = await fetcher.getOrFetch('k', 60_000, upstream);

    expect(out).toBe('l2-value');
    expect(upstream).not.toHaveBeenCalled();
    // L1 promoted with the supplied TTL
    expect(mem.set).toHaveBeenCalledWith('k', 'l2-value', 60_000);
  });

  it('calls upstream on full miss and writes both tiers with the supplied TTL', async () => {
    const mem = makeMemoryCache();
    const file = makeFileCache();
    const fetcher = createCachedFetcher(mem, file);

    const upstream = vi.fn().mockResolvedValue({ ok: true });
    const out = await fetcher.getOrFetch('k', 30_000, upstream);

    expect(out).toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(mem.set).toHaveBeenCalledWith('k', { ok: true }, 30_000);
    expect(file.set).toHaveBeenCalledWith('k', { ok: true }, 30_000);
  });

  it('skips L2 read entirely when opts.skipFileCache=true', async () => {
    const mem = makeMemoryCache();
    const file = makeFileCache();
    file.store.set('k', 'l2-value'); // would normally hit
    const fetcher = createCachedFetcher(mem, file);

    const upstream = vi.fn().mockResolvedValue('fresh');
    const out = await fetcher.getOrFetch('k', 60_000, upstream, { skipFileCache: true });

    expect(out).toBe('fresh');
    expect(file.get).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
    // Even when skipFileCache=true, the fresh value is written to L2 for future reads.
    expect(file.set).toHaveBeenCalledWith('k', 'fresh', 60_000);
  });

  it('propagates fetcher rejections without caching', async () => {
    const mem = makeMemoryCache();
    const file = makeFileCache();
    const fetcher = createCachedFetcher(mem, file);

    const upstream = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(fetcher.getOrFetch('k', 60_000, upstream)).rejects.toThrow('boom');

    expect(mem.set).not.toHaveBeenCalled();
    expect(file.set).not.toHaveBeenCalled();
  });
});

describe('createCachedFetcher.invalidate', () => {
  it('deletes from both tiers', () => {
    const mem = makeMemoryCache();
    const file = makeFileCache();
    mem.store.set('k', 'm');
    file.store.set('k', 'f');
    const fetcher = createCachedFetcher(mem, file);

    fetcher.invalidate('k');

    expect(mem.delete).toHaveBeenCalledWith('k');
    expect(file.delete).toHaveBeenCalledWith('k');
    expect(mem.store.has('k')).toBe(false);
    expect(file.store.has('k')).toBe(false);
  });
});
