/**
 * Unit tests for the synchronous text-to-speech boundary over the shared
 * inference transport (DashScope-native dialect).
 *
 * Only the transport is substituted; the client's own request assembly runs
 * for real.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TTSClient,
  SPEECH_SYNTHESIS_PATH,
  COSYVOICE_SYNTHESIS_PATH,
} from '../../../../src/api/providers/dashscope/tts-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';

function makeTransport(overrides: Partial<DashScopeTransport> = {}): DashScopeTransport {
  return {
    request: vi.fn().mockResolvedValue({ request_id: 'req-1' }),
    requestRaw: vi.fn(),
    ...overrides,
  } as unknown as DashScopeTransport;
}

describe('TTSClient', () => {
  describe('endpoint', () => {
    it('targets the multimodal generation synthesis path', () => {
      expect(SPEECH_SYNTHESIS_PATH).toBe(
        '/api/v1/services/aigc/multimodal-generation/generation',
      );
    });
  });

  describe('generate', () => {
    it('posts to the synthesis path', async () => {
      const transport = makeTransport();

      await new TTSClient({ transport }).generate({ model: 'qwen3-tts-flash' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { path: string }).path).toBe(SPEECH_SYNTHESIS_PATH);
    });

    it('issues the request as a POST', async () => {
      const transport = makeTransport();

      await new TTSClient({ transport }).generate({ model: 'm' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { method?: string }).method).toBe('POST');
    });

    it('forwards the assembled body to the transport unchanged', async () => {
      const transport = makeTransport();
      const body = {
        model: 'qwen3-tts-flash',
        input: { text: 'hello', voice: 'Cherry' },
      };

      await new TTSClient({ transport }).generate(body);

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { body?: unknown }).body).toEqual(body);
    });

    it('returns the upstream payload unchanged', async () => {
      const upstream = {
        request_id: 'r-7',
        output: { audio: { url: 'https://mock-api.test.qianwenai.com/a.wav' } },
      };
      const transport = makeTransport({
        request: vi.fn().mockResolvedValue(upstream),
      } as unknown as Partial<DashScopeTransport>);

      const result = await new TTSClient({ transport }).generate({ model: 'm' });

      expect(result).toEqual(upstream);
    });

    it('forwards caller-supplied extra headers', async () => {
      const transport = makeTransport();

      await new TTSClient({ transport }).generate({ model: 'm' }, { 'X-Probe': 'on' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      const headers = (mock.mock.calls[0]![0] as { headers?: Record<string, string> }).headers;
      expect(headers).toMatchObject({ 'X-Probe': 'on' });
    });

    it('posts to a caller-supplied path override (CosyVoice SpeechSynthesizer)', async () => {
      const transport = makeTransport();

      await new TTSClient({ transport }).generate(
        { model: 'cosyvoice-v2' },
        undefined,
        COSYVOICE_SYNTHESIS_PATH,
      );

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { path: string }).path).toBe(
        '/api/v1/services/audio/tts/SpeechSynthesizer',
      );
    });

    it('propagates a transport failure to the caller', async () => {
      const transport = makeTransport({
        request: vi.fn().mockRejectedValue(new Error('upstream refused')),
      } as unknown as Partial<DashScopeTransport>);

      await expect(new TTSClient({ transport }).generate({ model: 'm' })).rejects.toThrow(
        'upstream refused',
      );
    });
  });
});
