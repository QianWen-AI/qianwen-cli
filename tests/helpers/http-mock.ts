/**
 * Lightweight fetch router for ApiClient black-box tests.
 *
 * Why not nock / msw? Both pull in heavy network stacks and slow vitest startup
 * by ~500ms each. The CLI only ever calls global fetch, so a 60-line stub is
 * sufficient and keeps test code obvious to readers.
 *
 * Usage:
 *
 *   const mock = mockFetch({
 *     'data/v2/api.json': (req) => {
 *       const body = JSON.parse(req.body);
 *       if (body.action === 'ListModelSeries') return { code: '200', data: { Data: [] } };
 *       if (body.action === 'DescribeFqInstance') return { code: '200', data: { Data: [] } };
 *       return { code: '500', message: 'unknown action' };
 *     },
 *     'alioth.alicdn.com/model-mapping': () => ({}),
 *   });
 *   // ...run code under test...
 *   expect(mock.calls).toHaveLength(2);
 *   expect(mock.calls[0].url).toContain('/data/v2/api.json');
 *   mock.restore();
 */
import { vi } from 'vitest';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface MockResponseInit {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
}

export type RouteHandler =
  | ((req: RecordedRequest) => unknown | Promise<unknown>)
  | { body: unknown; init?: MockResponseInit }
  | unknown;

export interface MockFetch {
  /** Recorded requests in order. */
  calls: RecordedRequest[];
  /** Restore the previous global.fetch. */
  restore(): void;
  /** Helper: was a request made to a URL containing this fragment? */
  wasCalled(urlFragment: string): boolean;
  /** Helper: get the most recent request whose URL contains the fragment. */
  lastRequest(urlFragment: string): RecordedRequest | undefined;
}

/**
 * Build a fake fetch implementation. The route map is keyed by URL substring
 * (first match wins). Handlers can be plain JSON-able values, or functions
 * that receive the recorded request and return JSON-able data.
 *
 * Status code defaults to 200; pass `{ body, init: { status: 401 } }` to fake
 * an HTTP error. `init.body` may be a string (used as-is) or any other value
 * (JSON.stringify'd).
 */
export function mockFetch(routes: Record<string, RouteHandler>): MockFetch {
  const calls: RecordedRequest[] = [];

  const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k] = String(v);
    }
    const recorded: RecordedRequest = {
      url: urlStr,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body == null ? undefined : String(init.body),
    };
    calls.push(recorded);

    // Find first matching route
    const entry = Object.entries(routes).find(([fragment]) => urlStr.includes(fragment));
    if (!entry) {
      return new Response('not mocked: ' + urlStr, { status: 599 });
    }

    const handler = entry[1];
    let payload: unknown;
    let init2: MockResponseInit = {};

    if (typeof handler === 'function') {
      payload = await (handler as (req: RecordedRequest) => unknown)(recorded);
    } else if (
      handler &&
      typeof handler === 'object' &&
      'body' in (handler as Record<string, unknown>)
    ) {
      payload = (handler as { body: unknown; init?: MockResponseInit }).body;
      init2 = (handler as { body: unknown; init?: MockResponseInit }).init ?? {};
    } else {
      payload = handler;
    }

    const status = init2.status ?? 200;
    const statusText = init2.statusText ?? (status >= 200 && status < 300 ? 'OK' : 'Error');
    const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(bodyStr, {
      status,
      statusText,
      headers: { 'content-type': 'application/json', ...(init2.headers ?? {}) },
    });
  });

  const previous = globalThis.fetch;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
    wasCalled(fragment: string) {
      return calls.some((c) => c.url.includes(fragment));
    },
    lastRequest(fragment: string) {
      return [...calls].reverse().find((c) => c.url.includes(fragment));
    },
  };
}
