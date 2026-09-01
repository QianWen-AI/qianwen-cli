/**
 * Unit tests for the synchronous music-generation boundary over the shared
 * inference transport. Only the transport is substituted.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MusicClient,
  MUSIC_GENERATION_PATH,
  SSE_ENABLE_HEADER,
} from '../../../../src/api/providers/dashscope/music-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';

function makeTransport(overrides: Partial<DashScopeTransport> = {}): DashScopeTransport {
  return {
    request: vi.fn().mockResolvedValue({ request_id: 'req-1' }),
    requestRaw: vi.fn(),
    ...overrides,
  } as unknown as DashScopeTransport;
}

/** Build a Response-like object whose body streams the given SSE text frames. */
function sseResponse(frames: string[]): { body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { body: stream };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('MusicClient', () => {
  // Guards the documented route: Fun-Music is under `audio/`, not `aigc/`.
  // The old `aigc/music-generation/generation` value made every call fail with
  // "url error, please check url".
  it('targets the documented music-generation path constant', () => {
    expect(MUSIC_GENERATION_PATH).toBe('/api/v1/services/audio/music/generation');
  });

  it('posts the assembled body to the music-generation path', async () => {
    const transport = makeTransport();
    const body = { model: 'fun-music-v1', input: { prompt: 'a piano tune' } };

    await new MusicClient({ transport }).generate(body);

    const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
    const arg = mock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.path).toBe(MUSIC_GENERATION_PATH);
    expect(arg.method).toBe('POST');
    expect(arg.body).toEqual(body);
  });

  it('forwards an explicit per-request timeout to the transport', async () => {
    const transport = makeTransport();

    await new MusicClient({ transport }).generate({ model: 'm' }, undefined, 300_000);

    const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
    const arg = mock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.timeoutMs).toBe(300_000);
  });

  it('returns the upstream payload unchanged', async () => {
    const upstream = {
      request_id: 'r-7',
      output: { audio: { url: 'https://mock-api.test.qianwenai.com/song.mp3' } },
    };
    const transport = makeTransport({
      request: vi.fn().mockResolvedValue(upstream),
    } as unknown as Partial<DashScopeTransport>);

    const result = await new MusicClient({ transport }).generate({ model: 'm' });

    expect(result).toEqual(upstream);
  });

  it('propagates a transport failure to the caller', async () => {
    const transport = makeTransport({
      request: vi.fn().mockRejectedValue(new Error('upstream refused')),
    } as unknown as Partial<DashScopeTransport>);

    await expect(new MusicClient({ transport }).generate({ model: 'm' })).rejects.toThrow(
      'upstream refused',
    );
  });

  describe('generateStream (SSE)', () => {
    it('enables SSE and streams interim + terminal frames as normalized events', async () => {
      const frames = [
        'data:{"output":{"audio":{"data":"YWJj"},"finish_reason":"null"},"request_id":"r-1"}\n\n',
        'data:{"output":{"audio":{"data":"ZGVm"},"finish_reason":"null"}}\n\n',
        'data:{"output":{"audio":{"url":"https://mock-api.test.qianwenai.com/song.mp3"},' +
          '"finish_reason":"stop","extra_info":{"sample_rate":44100}},' +
          '"usage":{"duration":30},"request_id":"r-1"}\n\n',
      ];
      const requestRaw = vi.fn().mockResolvedValue(sseResponse(frames));
      const transport = makeTransport({
        requestRaw,
      } as unknown as Partial<DashScopeTransport>);

      const events = await collect(
        new MusicClient({ transport }).generateStream({ model: 'm' }, undefined, 300_000),
      );

      const arg = requestRaw.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg.path).toBe(MUSIC_GENERATION_PATH);
      expect((arg.headers as Record<string, string>)[SSE_ENABLE_HEADER]).toBe('enable');
      expect(arg.stream).toBe(true);
      expect(arg.timeoutMs).toBe(300_000);

      expect(events).toEqual([
        { requestId: 'r-1', audioData: 'YWJj', finishReason: 'null' },
        { audioData: 'ZGVm', finishReason: 'null' },
        {
          requestId: 'r-1',
          url: 'https://mock-api.test.qianwenai.com/song.mp3',
          finishReason: 'stop',
          usage: { duration: 30 },
          extraInfo: { sample_rate: 44100 },
        },
      ]);
    });

    it('handles frames split across chunk boundaries', async () => {
      const frames = [
        'data:{"output":{"audio":{"da',
        'ta":"YWJj"},"finish_reason":"null"}}\n',
        'data:{"output":{"audio":{"url":"https://x/y.mp3"},"finish_reason":"stop"}}\n',
      ];
      const transport = makeTransport({
        requestRaw: vi.fn().mockResolvedValue(sseResponse(frames)),
      } as unknown as Partial<DashScopeTransport>);

      const events = await collect(new MusicClient({ transport }).generateStream({ model: 'm' }));

      expect(events).toEqual([
        { audioData: 'YWJj', finishReason: 'null' },
        { url: 'https://x/y.mp3', finishReason: 'stop' },
      ]);
    });

    it('ignores blank / non-data lines and yields nothing when body is absent', async () => {
      const transport = makeTransport({
        requestRaw: vi.fn().mockResolvedValue({ body: null }),
      } as unknown as Partial<DashScopeTransport>);

      const events = await collect(new MusicClient({ transport }).generateStream({ model: 'm' }));
      expect(events).toEqual([]);
    });
  });
});
