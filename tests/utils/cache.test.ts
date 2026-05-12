import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryCache, getGlobalCache, resetGlobalCache } from '../../src/utils/cache.js';

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
