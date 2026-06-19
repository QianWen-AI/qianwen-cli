/**
 * Shared mock factories for Service-layer tests.
 *
 * The Service layer consumes two abstractions exclusively:
 *   - ApiClient ({ callFlatApi, callEnvelopeApi })
 *   - CachedFetcher ({ getOrFetch, invalidate })
 *
 * Each mock is a minimal stub that lets a test override only the surfaces
 * it cares about. Mock domain follows the *.test.qianwen.com convention.
 */
import { vi, type Mock } from 'vitest';
import type {
  ApiClient,
  CallEnvelopeApiOptions,
  CallFlatApiOptions,
} from '../../src/api/api-client.js';
import type { CachedFetcher, CacheKey } from '../../src/types/cache.js';

export interface MockApiClient extends ApiClient {
  callFlatApi: Mock;
  callEnvelopeApi: Mock;
}

/**
 * Build a fully-typed ApiClient mock. Both methods default to throwing so
 * callers must wire up the responses they care about; this prevents silent
 * "undefined response" passes when a Service evolves and starts hitting
 * a new endpoint.
 */
export function makeMockApiClient(overrides?: {
  flat?: (opts: CallFlatApiOptions) => Promise<unknown>;
  envelope?: (opts: CallEnvelopeApiOptions) => Promise<unknown>;
}): MockApiClient {
  const flatHandler =
    overrides?.flat ??
    ((opts: CallFlatApiOptions) => {
      return Promise.reject(
        new Error(`MockApiClient.callFlatApi unhandled: ${opts.product}/${opts.action}`),
      );
    });
  const envelopeHandler =
    overrides?.envelope ??
    ((opts: CallEnvelopeApiOptions) => {
      return Promise.reject(new Error(`MockApiClient.callEnvelopeApi unhandled: ${opts.api}`));
    });

  // Variadic shim — service code uses both the options form and the
  // legacy positional form.
  const callFlatApi = vi.fn(
    (
      productOrOpts: string | CallFlatApiOptions,
      action?: string,
      params?: Record<string, unknown>,
    ) => {
      const opts: CallFlatApiOptions =
        typeof productOrOpts === 'string'
          ? { product: productOrOpts, action: action ?? '', params }
          : productOrOpts;
      return flatHandler(opts);
    },
  );
  const callEnvelopeApi = vi.fn((opts: CallEnvelopeApiOptions) => envelopeHandler(opts));
  return { callFlatApi, callEnvelopeApi } as MockApiClient;
}

export interface MockCachedFetcher extends CachedFetcher {
  getOrFetch: Mock;
  invalidate: Mock;
}

/**
 * Build a CachedFetcher mock. Default behavior: pass-through (always miss).
 * Pass `{ hit: value }` to short-circuit getOrFetch with a fixed cached value.
 */
export function makeMockCachedFetcher(opts?: { hit?: unknown }): MockCachedFetcher {
  const hit = opts && Object.prototype.hasOwnProperty.call(opts, 'hit') ? opts.hit : undefined;
  const has = opts && Object.prototype.hasOwnProperty.call(opts, 'hit');
  const getOrFetch = vi.fn(
    async <T>(_key: CacheKey, _ttl: number, fetcher: () => Promise<T>): Promise<T> => {
      if (has) return hit as T;
      return fetcher();
    },
  );
  const invalidate = vi.fn();
  return { getOrFetch, invalidate } as MockCachedFetcher;
}
