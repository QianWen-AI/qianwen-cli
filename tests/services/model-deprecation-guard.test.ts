/**
 * Unit tests for ModelDeprecationGuard.
 *
 * Before a request the guard warns once for a model that is scheduled to retire
 * but is still callable (now < expiredTime). It never blocks the call, emits
 * nothing for absent / already-expired / undated models, and fails silently
 * when the schedule cannot be loaded.
 */
import { describe, it, expect, vi } from 'vitest';
import { ModelDeprecationGuard } from '../../src/services/model-deprecation-guard.js';
import { ANNOUNCEMENT_URL } from '../../src/services/model-deprecation-source.js';
import type { CachedFetcher } from '../../src/types/cache.js';
import type { DeprecationManifest } from '../../src/types/model-deprecation.js';

/** A cache that always calls the fetcher, recording invocation counts. */
function passthroughCache(): CachedFetcher & { calls: number } {
  const cache = {
    calls: 0,
    async getOrFetch<T>(_key: string, _ttl: number, fetcher: () => Promise<T>): Promise<T> {
      cache.calls += 1;
      return fetcher();
    },
    invalidate() {},
  };
  return cache;
}

const NOW = Date.parse('2026-06-01T00:00:00+08:00');

function makeGuard(manifest: DeprecationManifest, fetchImpl?: () => Promise<DeprecationManifest>) {
  const cache = passthroughCache();
  const fetchManifest = vi.fn(fetchImpl ?? (async () => manifest));
  const lines: string[] = [];
  const guard = new ModelDeprecationGuard({
    cache,
    now: () => NOW,
    fetchManifest,
    emit: (line) => lines.push(line),
  });
  return { guard, cache, fetchManifest, lines };
}

describe('ModelDeprecationGuard', () => {
  it('warns once for a model scheduled to retire in the future', async () => {
    const { guard, lines } = makeGuard([
      { id: 'qwen3.8-max', expiredTime: '2026-06-20T23:59:59+08:00' },
    ]);

    const notice = await guard.notifyIfDeprecated('qwen3.8-max');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'qwen3.8-max 将于 2026年6月20日 下线，请提前迁移。' + `详情：${ANNOUNCEMENT_URL}`,
    );
    expect(notice).toBe(lines[0]);
  });

  it('returns the notice string on first call and null on subsequent calls', async () => {
    const { guard } = makeGuard([{ id: 'qwen3.8-max', expiredTime: '2026-06-20T23:59:59+08:00' }]);

    const first = await guard.notifyIfDeprecated('qwen3.8-max');
    const second = await guard.notifyIfDeprecated('qwen3.8-max');

    expect(typeof first).toBe('string');
    expect(second).toBeNull();
  });

  it('does not warn twice for the same model', async () => {
    const { guard, lines } = makeGuard([
      { id: 'qwen3.8-max', expiredTime: '2026-06-20T23:59:59+08:00' },
    ]);

    await guard.notifyIfDeprecated('qwen3.8-max');
    await guard.notifyIfDeprecated('qwen3.8-max');

    expect(lines).toHaveLength(1);
  });

  it('stays silent for a model absent from the schedule', async () => {
    const { guard, lines } = makeGuard([
      { id: 'qwen-old', expiredTime: '2026-06-20T23:59:59+08:00' },
    ]);
    await guard.notifyIfDeprecated('qwen3.8-max');
    expect(lines).toHaveLength(0);
  });

  it('stays silent for a model already past its expiry instant', async () => {
    const { guard, lines } = makeGuard([
      { id: 'qwen-legacy', expiredTime: '2026-01-01T00:00:00+08:00' },
    ]);
    await guard.notifyIfDeprecated('qwen-legacy');
    expect(lines).toHaveLength(0);
  });

  it('stays silent for a scheduled model without an expiry instant', async () => {
    const { guard, lines } = makeGuard([{ id: 'qwen-open' }]);
    await guard.notifyIfDeprecated('qwen-open');
    expect(lines).toHaveLength(0);
  });

  it('stays silent when expiry is beyond the 30-day notice window', async () => {
    const { guard, lines } = makeGuard([
      { id: 'qwen-far', expiredTime: '2026-10-10T23:59:59+08:00' },
    ]);
    await guard.notifyIfDeprecated('qwen-far');
    expect(lines).toHaveLength(0);
  });

  it('fails silently when the schedule cannot be loaded', async () => {
    const { guard, lines } = makeGuard([], async () => {
      throw new Error('cdn down');
    });
    await expect(guard.notifyIfDeprecated('anything')).resolves.toBeNull();
    expect(lines).toHaveLength(0);
  });
});
