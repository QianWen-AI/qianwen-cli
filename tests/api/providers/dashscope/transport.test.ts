/**
 * Unit tests for DashScopeTransport — the HTTP boundary shared by every
 * model-invocation client.
 *
 * Responsibilities under test:
 *   1. Attach the bearer credential and compose the absolute URL from base +
 *      path.
 *   2. Normalize upstream failures from both wire dialects into a single shape
 *      carrying `code` and `message`, passing the upstream message through
 *      verbatim.
 *   3. Surface transport-level faults (network, timeout) with a network-class
 *      exit code.
 *   4. Never retry automatically.
 *
 * Only the network boundary is substituted; the transport's own request
 * composition and error normalization run for real.
 */
import { describe, it, expect, vi } from 'vitest';
import { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';
import { CliError } from '../../../../src/utils/errors.js';
import { EXIT_CODES } from '../../../../src/utils/exit-codes.js';

const BASE_URL = 'https://mock-dashscope.test.qianwenai.com';
const TOKEN = 'sk-test-token';
const CHAT_PATH = '/compatible-mode/v1/chat/completions';

/** Build a JSON Response double for the injected fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTransport(fetchImpl: typeof fetch, token: string = TOKEN): DashScopeTransport {
  return new DashScopeTransport({
    baseUrl: BASE_URL,
    token,
    channel: 'qianwenai-cli',
    commandType: 'chat-create',
    userAgent: 'qianwen-cli/9.9.9',
    fetchImpl,
  });
}

/** Read the request init captured by a mocked fetch call. */
function capturedInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[0]![1] as RequestInit;
}

function capturedHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  return capturedInit(fetchMock).headers as Record<string, string>;
}

describe('DashScopeTransport', () => {
  describe('request composition', () => {
    it('joins the base URL with the request path', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });

      expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE_URL}${CHAT_PATH}`);
    });

    it('attaches the credential as a bearer authorization header', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });

      expect(capturedHeaders(fetchMock).Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('serializes the body as JSON', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await transport.request({ path: CHAT_PATH, method: 'POST', body: { model: 'qwen3.7-max' } });

      expect(capturedInit(fetchMock).body).toBe(JSON.stringify({ model: 'qwen3.7-max' }));
    });

    it('sends a caller-supplied pre-serialized body verbatim', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);
      const rawBody = '{"temperature":2.0}';

      await transport.request({ path: CHAT_PATH, method: 'POST', rawBody });

      expect(capturedInit(fetchMock).body).toBe(rawBody);
    });

    it('merges caller-supplied headers alongside the authorization header', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await transport.request({
        path: CHAT_PATH,
        method: 'POST',
        body: {},
        headers: { 'X-DashScope-Async': 'enable' },
      });

      const headers = capturedHeaders(fetchMock);
      expect(headers['X-DashScope-Async']).toBe('enable');
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('attaches the branded User-Agent and source-config header', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const transport = makeTransport(fetchMock as unknown as typeof fetch, 'sk-ws-abc');

      await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });

      const headers = capturedHeaders(fetchMock);
      expect(headers['User-Agent']).toBe('qianwen-cli/9.9.9');
      expect(JSON.parse(headers['X-DashScope-Source-Config']!)).toEqual({
        channel: 'qianwenai-cli',
        tags: { t1: 'chat-create', t2: 'payg' },
      });
    });

    it('derives the payment tier from the api-key prefix', async () => {
      const cases: Array<[string, string]> = [
        ['sk-ws-live', 'payg'],
        ['sk-sp-live', 'tokenplan'],
        ['sk-other-live', 'other'],
        ['oauth-access-token', 'other'],
      ];
      for (const [token, tier] of cases) {
        const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
        const transport = makeTransport(fetchMock as unknown as typeof fetch, token);
        await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });
        const config = JSON.parse(capturedHeaders(fetchMock)['X-DashScope-Source-Config']!);
        expect(config.tags.t2).toBe(tier);
      }
    });

    it('returns the parsed payload on success', async () => {
      const payload = { output: { task_id: 'task-1' } };
      const fetchMock = vi.fn(async () => jsonResponse(payload));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await expect(transport.request({ path: CHAT_PATH, method: 'POST', body: {} })).resolves.toEqual(
        payload,
      );
    });
  });

  describe('error normalization', () => {
    it('normalizes the nested error dialect', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: { code: 'InvalidParameter', message: 'temperature must be Float' } }, 400),
      );
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      let captured: unknown;
      try {
        await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });
      } catch (error) {
        captured = error;
      }

      expect((captured as CliError).code).toBe('InvalidParameter');
      expect((captured as CliError).message).toBe('temperature must be Float');
    });

    it('normalizes the flat error dialect', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ code: 'Throttling', message: 'Requests throttled.', request_id: 'req-1' }, 429),
      );
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      let captured: unknown;
      try {
        await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });
      } catch (error) {
        captured = error;
      }

      expect((captured as CliError).code).toBe('Throttling');
      expect((captured as CliError).message).toBe('Requests throttled.');
    });

    it('falls back to a generic code when the failure body is unrecognized', async () => {
      const fetchMock = vi.fn(
        async () => new Response('<html>gateway error</html>', { status: 502 }),
      );
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      let captured: unknown;
      try {
        await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(CliError);
      expect((captured as CliError).code).toBe('UNKNOWN_ERROR');
    });

    it('does not retry a failed request', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ code: 'ServerError', message: 'boom' }, 500));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await expect(
        transport.request({ path: CHAT_PATH, method: 'POST', body: {} }),
      ).rejects.toBeInstanceOf(CliError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([403, 404])(
      'guides a Token Plan key to the supported-model list on HTTP %i',
      async (status) => {
        const fetchMock = vi.fn(async () =>
          jsonResponse({ code: 'ModelNotFound', message: 'model not found' }, status),
        );
        const transport = makeTransport(fetchMock as unknown as typeof fetch, 'sk-sp-live');

        let captured: unknown;
        try {
          await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });
        } catch (error) {
          captured = error;
        }

        expect((captured as CliError).code).toBe('MODEL_NOT_SUPPORTED');
        expect((captured as CliError).message).toContain('该模型不在 Token Plan 支持范围内');
        expect((captured as CliError).message).toContain('token-plan/personal/token-plan-personal-overview');
        expect((captured as CliError).message).toContain('token-plan/team/token-plan-team-overview');
      },
    );

    it('passes the upstream error through for non Token Plan keys on HTTP 404', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ code: 'ModelNotFound', message: 'model not found' }, 404),
      );
      const transport = makeTransport(fetchMock as unknown as typeof fetch, 'sk-ws-live');

      let captured: unknown;
      try {
        await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });
      } catch (error) {
        captured = error;
      }

      expect((captured as CliError).code).toBe('ModelNotFound');
      expect((captured as CliError).message).toBe('model not found');
    });
  });

  describe('transport faults', () => {
    it('reports a network failure with a network-class exit code', async () => {
      const fetchMock = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      let captured: unknown;
      try {
        await transport.request({ path: CHAT_PATH, method: 'POST', body: {} });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(CliError);
      expect((captured as CliError).exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
    });

    it('aborts the request once the timeout elapses', async () => {
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      );
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      let captured: unknown;
      try {
        await transport.request({ path: CHAT_PATH, method: 'POST', body: {}, timeoutMs: 10 });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(CliError);
      expect((captured as CliError).exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
    });
  });

  describe('raw responses', () => {
    it('exposes the untouched response for streaming and binary consumers', async () => {
      const response = jsonResponse({ ok: true });
      const fetchMock = vi.fn(async () => response);
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await expect(transport.requestRaw({ path: CHAT_PATH, method: 'POST', body: {} })).resolves.toBe(
        response,
      );
    });

    it('still raises on a failing status when requesting a raw response', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ code: 'AccessDenied', message: 'no permission' }, 403),
      );
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      await expect(
        transport.requestRaw({ path: CHAT_PATH, method: 'POST', body: {} }),
      ).rejects.toBeInstanceOf(CliError);
    });
  });

  describe('streaming (SSE) inactivity timer', () => {
    /** A streaming Response whose body emits chunks on the given schedule. */
    function streamingResponse(
      chunks: string[],
      { gapMs = 0 }: { gapMs?: number } = {},
    ): Response {
      const encoder = new TextEncoder();
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (i >= chunks.length) {
            controller.close();
            return;
          }
          if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
          controller.enqueue(encoder.encode(chunks[i]!));
          i += 1;
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    it('does not abort a long stream as long as chunks keep arriving within the idle window', async () => {
      // Each chunk arrives after 15ms; the idle window is 40ms. A one-shot
      // (total-time) timer would fire, but the inactivity timer keeps resetting.
      const fetchMock = vi.fn(async () =>
        streamingResponse(['data:{"a":1}\n', 'data:{"b":2}\n', 'data:{"c":3}\n'], { gapMs: 15 }),
      );
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      const response = await transport.requestRaw({
        path: CHAT_PATH,
        method: 'POST',
        body: {},
        stream: true,
        timeoutMs: 40,
      });

      const text = await new Response(response.body).text();
      expect(text).toBe('data:{"a":1}\ndata:{"b":2}\ndata:{"c":3}\n');
    });

    it('aborts a stream that stalls longer than the idle window', async () => {
      const fetchMock = vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"a":1}\n'));
            // Then stall forever — the idle timer must abort the read.
            await new Promise(() => {});
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      });
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      const response = await transport.requestRaw({
        path: CHAT_PATH,
        method: 'POST',
        body: {},
        stream: true,
        timeoutMs: 20,
      });

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('data:{"a":1}\n');
      // The next read stalls past the idle window and the abort surfaces as a
      // stream error.
      await expect(reader.read()).rejects.toBeTruthy();
    });

    it('sends a streaming request without the abort firing on connection open', async () => {
      const fetchMock = vi.fn(async () => streamingResponse(['data:{"x":1}\n']));
      const transport = makeTransport(fetchMock as unknown as typeof fetch);

      const response = await transport.requestRaw({
        path: CHAT_PATH,
        method: 'POST',
        body: {},
        stream: true,
        timeoutMs: 1000,
      });

      expect(capturedInit(fetchMock).signal).toBeInstanceOf(AbortSignal);
      const text = await new Response(response.body).text();
      expect(text).toBe('data:{"x":1}\n');
    });
  });
});
