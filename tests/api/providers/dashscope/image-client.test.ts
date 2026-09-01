/**
 * Unit tests for ImageClient — the synchronous image-synthesis boundary over
 * the shared inference transport (DashScope-native dialect).
 *
 * Only the transport is substituted; the client's own request assembly runs
 * for real.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ImageClient,
  IMAGE_SYNTHESIS_PATH,
  IMAGE_ASYNC_SYNTHESIS_PATH,
} from '../../../../src/api/providers/dashscope/image-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';

function makeTransport(overrides: Partial<DashScopeTransport> = {}): DashScopeTransport {
  return {
    request: vi.fn().mockResolvedValue({ request_id: 'req-1' }),
    requestRaw: vi.fn(),
    ...overrides,
  } as unknown as DashScopeTransport;
}

describe('ImageClient', () => {
  describe('endpoint', () => {
    it('targets the multimodal generation synthesis path', () => {
      expect(IMAGE_SYNTHESIS_PATH).toBe('/api/v1/services/aigc/multimodal-generation/generation');
    });
  });

  describe('generate', () => {
    it('posts to the synthesis path', async () => {
      const transport = makeTransport();

      await new ImageClient({ transport }).generate({ model: 'qwen-image-2.0' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { path: string }).path).toBe(IMAGE_SYNTHESIS_PATH);
    });

    it('issues the request as a POST', async () => {
      const transport = makeTransport();

      await new ImageClient({ transport }).generate({ model: 'm' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { method?: string }).method).toBe('POST');
    });

    it('forwards the assembled body to the transport', async () => {
      const transport = makeTransport();
      const body = {
        model: 'qwen-image-2.0',
        input: { messages: [{ role: 'user', content: [{ text: 'city' }] }] },
        parameters: { size: '2048*2048' },
      };

      await new ImageClient({ transport }).generate(body);

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { body?: unknown }).body).toEqual(body);
    });

    it('returns the upstream payload unchanged', async () => {
      const upstream = { request_id: 'r-7', output: { results: [{ url: 'https://x/a.png' }] } };
      const transport = makeTransport({
        request: vi.fn().mockResolvedValue(upstream),
      } as unknown as Partial<DashScopeTransport>);

      const result = await new ImageClient({ transport }).generate({ model: 'm' });

      expect(result).toEqual(upstream);
    });

    it('forwards caller-supplied extra headers', async () => {
      const transport = makeTransport();

      await new ImageClient({ transport }).generate({ model: 'm' }, { 'X-Probe': 'on' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      const headers = (mock.mock.calls[0]![0] as { headers?: Record<string, string> }).headers;
      expect(headers).toMatchObject({ 'X-Probe': 'on' });
    });

    it('forwards an explicit per-request timeout to the transport', async () => {
      const transport = makeTransport();

      await new ImageClient({ transport }).generate({ model: 'm' }, undefined, 300_000);

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      const arg = mock.mock.calls[0]![0] as { timeoutMs?: number };
      expect(arg.timeoutMs).toBe(300_000);
    });

    it('propagates a transport failure to the caller', async () => {
      const transport = makeTransport({
        request: vi.fn().mockRejectedValue(new Error('upstream refused')),
      } as unknown as Partial<DashScopeTransport>);

      await expect(new ImageClient({ transport }).generate({ model: 'm' })).rejects.toThrow(
        'upstream refused',
      );
    });
  });

  describe('submit', () => {
    it('targets the async text2image synthesis path', () => {
      expect(IMAGE_ASYNC_SYNTHESIS_PATH).toBe('/api/v1/services/aigc/text2image/image-synthesis');
    });

    it('posts with the async-enable header', async () => {
      const transport = makeTransport();

      await new ImageClient({ transport }).submit({ model: 'wanx-v1' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      const arg = mock.mock.calls[0]![0] as {
        path: string;
        method?: string;
        headers?: Record<string, string>;
      };
      expect(arg.path).toBe(IMAGE_ASYNC_SYNTHESIS_PATH);
      expect(arg.method).toBe('POST');
      expect(arg.headers).toMatchObject({ 'X-DashScope-Async': 'enable' });
    });
  });
});
