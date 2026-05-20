import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MemoryCache,
  getGlobalCache,
  resetGlobalCache,
  FileCache,
  getGlobalFileCache,
  resetGlobalFileCache,
  setFileCacheContextResolver,
  CacheKeys,
  CacheFileNames,
  FILE_CACHE_SCHEMA_VERSION,
} from '../../src/utils/cache.js';

describe('MemoryCache', () => {
  let cache: MemoryCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new MemoryCache(1000); // 1 second default TTL
  });

  afterEach(() => {
    cache.dispose();
    vi.useRealTimers();
  });

  it('should return null for missing keys', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('should store and retrieve values', () => {
    cache.set('key1', { value: 42 });
    expect(cache.get('key1')).toEqual({ value: 42 });
  });

  it('should store and retrieve string values', () => {
    cache.set('str', 'hello');
    expect(cache.get('str')).toBe('hello');
  });

  it('should return null for expired entries', () => {
    cache.set('key1', 'value');
    vi.advanceTimersByTime(1001); // Exceed 1s TTL
    expect(cache.get('key1')).toBeNull();
  });

  it('should return value before TTL expires', () => {
    cache.set('key1', 'value');
    vi.advanceTimersByTime(999); // Just before TTL
    expect(cache.get('key1')).toBe('value');
  });

  it('should support custom TTL per entry', () => {
    cache.set('short', 'data', 500);
    cache.set('long', 'data', 5000);

    vi.advanceTimersByTime(600);
    expect(cache.get('short')).toBeNull();
    expect(cache.get('long')).toBe('data');
  });

  it('should overwrite existing entries', () => {
    cache.set('key', 'v1');
    cache.set('key', 'v2');
    expect(cache.get('key')).toBe('v2');
  });

  it('should delete entries', () => {
    cache.set('key', 'value');
    cache.delete('key');
    expect(cache.get('key')).toBeNull();
  });

  it('should clear all entries', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });

  it('should report has() correctly', () => {
    cache.set('key', 'value');
    expect(cache.has('key')).toBe(true);
    expect(cache.has('missing')).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(cache.has('key')).toBe(false);
  });

  it('should return stats', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.keys).toContain('a');
    expect(stats.keys).toContain('b');
  });

  it('should auto-cleanup expired entries', () => {
    cache.set('expire-soon', 'data', 500);
    cache.set('stay', 'data', 120_000);

    // Advance past the cleanup interval (60s) and past the short TTL
    vi.advanceTimersByTime(61_000);

    // After cleanup, expired entry should be removed from store
    const stats = cache.getStats();
    expect(stats.keys).not.toContain('expire-soon');
    expect(stats.keys).toContain('stay');
  });

  it('should dispose and clear everything', () => {
    cache.set('key', 'value');
    cache.dispose();
    expect(cache.get('key')).toBeNull();
    expect(cache.getStats().size).toBe(0);
  });
});

describe('getGlobalCache / resetGlobalCache', () => {
  afterEach(() => {
    resetGlobalCache();
  });

  it('should return a singleton instance', () => {
    const c1 = getGlobalCache();
    const c2 = getGlobalCache();
    expect(c1).toBe(c2);
  });

  it('should return a new instance after reset', () => {
    const c1 = getGlobalCache();
    resetGlobalCache();
    const c2 = getGlobalCache();
    expect(c1).not.toBe(c2);
  });
});

// ── FileCache ────────────────────────────────────────────────────────
//
// Each test uses an isolated tmp directory to avoid touching the real
// ~/.qianwen/cache, and overrides getCacheFilePath via vi.mock so the
// FileCache writes/reads inside that tmp directory only.

let tmpCacheDir: string;

vi.mock('../../src/config/paths.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // Resolved on demand so each test can swap the root via tmpCacheDir.
    getCacheFilePath: (fileName: string) => join(tmpCacheDir, fileName),
  };
});

const ENDPOINT = 'https://api.test.example.com';
const KEY = CacheKeys.MODELS_RAW_LIST;
const FILE_NAME = CacheFileNames[KEY];

function filePath(): string {
  return join(tmpCacheDir, FILE_NAME);
}

function writeRawEnvelope(envelope: unknown): void {
  writeFileSync(filePath(), JSON.stringify(envelope), 'utf-8');
}

describe('FileCache', () => {
  let cache: FileCache;

  beforeEach(() => {
    tmpCacheDir = mkdtempSync(join(tmpdir(), 'qianwen-filecache-'));
    cache = new FileCache();
    setFileCacheContextResolver(() => ({ endpoint: ENDPOINT, ttlMs: 60_000 }));
  });

  afterEach(() => {
    setFileCacheContextResolver(null);
    resetGlobalFileCache();
    rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  it('returns null when no file exists', () => {
    expect(cache.get(KEY)).toBeNull();
  });

  it('round-trips a payload through set/get', () => {
    cache.set(KEY, [{ id: 'm1' }, { id: 'm2' }]);
    expect(existsSync(filePath())).toBe(true);
    expect(cache.get(KEY)).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('writes a self-describing envelope with all validation fields', () => {
    cache.set(KEY, { hello: 'world' });
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8'));
    expect(raw.schemaVersion).toBe(FILE_CACHE_SCHEMA_VERSION);
    expect(raw.key).toBe(KEY);
    expect(raw.endpoint).toBe(ENDPOINT);
    expect(typeof raw.expiresAt).toBe('number');
    expect(typeof raw.createdAt).toBe('number');
    expect(raw.ttlMs).toBe(60_000);
    expect(raw.data).toEqual({ hello: 'world' });
  });

  it('treats ttlMs=0 as disabled (no read, no write)', () => {
    setFileCacheContextResolver(() => ({ endpoint: ENDPOINT, ttlMs: 0 }));
    cache.set(KEY, { hello: 'world' });
    expect(existsSync(filePath())).toBe(false);
    // Manually plant a valid file: read should still return null because disabled.
    setFileCacheContextResolver(() => ({ endpoint: ENDPOINT, ttlMs: 60_000 }));
    cache.set(KEY, { hello: 'world' });
    setFileCacheContextResolver(() => ({ endpoint: ENDPOINT, ttlMs: 0 }));
    expect(cache.get(KEY)).toBeNull();
  });

  it('returns null when no resolver is wired', () => {
    setFileCacheContextResolver(null);
    cache.set(KEY, { hello: 'world' });
    expect(existsSync(filePath())).toBe(false);
    expect(cache.get(KEY)).toBeNull();
  });

  it('treats expired entries as miss and removes the file', () => {
    cache.set(KEY, 42);
    // Forge an envelope that is already expired.
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8'));
    raw.expiresAt = Date.now() - 1000;
    writeRawEnvelope(raw);
    expect(cache.get(KEY)).toBeNull();
    expect(existsSync(filePath())).toBe(false);
  });

  it('treats corrupted JSON as miss and removes the file', () => {
    writeFileSync(filePath(), '{not-json', 'utf-8');
    expect(cache.get(KEY)).toBeNull();
    expect(existsSync(filePath())).toBe(false);
  });

  it('rejects entries with mismatched schemaVersion', () => {
    cache.set(KEY, 'v1');
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8'));
    raw.schemaVersion = FILE_CACHE_SCHEMA_VERSION + 1;
    writeRawEnvelope(raw);
    expect(cache.get(KEY)).toBeNull();
    expect(existsSync(filePath())).toBe(false);
  });

  it('rejects entries with mismatched key', () => {
    cache.set(KEY, 'v1');
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8'));
    raw.key = 'something:else';
    writeRawEnvelope(raw);
    expect(cache.get(KEY)).toBeNull();
  });

  it('rejects entries with mismatched endpoint', () => {
    cache.set(KEY, 'v1');
    setFileCacheContextResolver(() => ({
      endpoint: 'https://api.other.example.com',
      ttlMs: 60_000,
    }));
    expect(cache.get(KEY)).toBeNull();
    expect(existsSync(filePath())).toBe(false);
  });

  it('delete() removes the cache file', () => {
    cache.set(KEY, 'v1');
    expect(existsSync(filePath())).toBe(true);
    cache.delete(KEY);
    expect(existsSync(filePath())).toBe(false);
  });

  it('overwrites an existing entry on set', () => {
    cache.set(KEY, 'first');
    cache.set(KEY, 'second');
    expect(cache.get(KEY)).toBe('second');
  });
});

describe('getGlobalFileCache / resetGlobalFileCache', () => {
  afterEach(() => {
    resetGlobalFileCache();
  });

  it('returns a singleton instance', () => {
    const a = getGlobalFileCache();
    const b = getGlobalFileCache();
    expect(a).toBe(b);
  });

  it('returns a new instance after reset', () => {
    const a = getGlobalFileCache();
    resetGlobalFileCache();
    const b = getGlobalFileCache();
    expect(a).not.toBe(b);
  });
});
