/**
 * Unit tests for the text-to-speech service — orchestration of tiers 0/1/2/3
 * into a native DashScope synthesis body, plus the synchronous generate path
 * with audio download post-processing.
 *
 * Real base collaborators are injected (request parsing, conflict detection,
 * envelope construction, mapping registry). Only the outermost boundaries are
 * substituted: the model resolver (network), the synthesis client (HTTP) and
 * the downloader (fs/network).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TTSService,
  type TTSServiceDeps,
  registerTTSMappings,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
} from '../../src/services/tts-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import type { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import type { TTSClient } from '../../src/api/providers/dashscope/tts-client.js';
import type { TtsWebSocketClient } from '../../src/api/providers/dashscope/tts-ws-client.js';
import type { ImageDownloader } from '../../src/services/image-downloader.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';

function makeRegistry(): MappingRegistry {
  const registry = new MappingRegistry();
  registerTTSMappings(registry);
  return registry;
}

function makeResolver(model: string): DefaultModelResolver {
  return {
    resolve: vi.fn(async (_q: unknown, flag?: string) => flag ?? model),
  } as unknown as DefaultModelResolver;
}

function makeClient(response: Record<string, unknown>): {
  client: TTSClient;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn().mockResolvedValue(response);
  return { client: { generate } as unknown as TTSClient, generate };
}

function makeWsClient(
  audio: Uint8Array = new Uint8Array([0x49, 0x44, 0x33]),
  usage?: Record<string, unknown>,
): { wsClient: TtsWebSocketClient; synthesize: ReturnType<typeof vi.fn> } {
  const synthesize = vi
    .fn()
    .mockResolvedValue({ audio, format: 'mp3', ...(usage ? { usage } : {}) });
  return { wsClient: { synthesize } as unknown as TtsWebSocketClient, synthesize };
}

function makeDownloader(): { downloader: ImageDownloader; download: ReturnType<typeof vi.fn> } {
  const download = vi.fn(async (_url: string, index: number) => `downloads/speech-${index}.wav`);
  return {
    downloader: {
      download,
      inferFileName: vi.fn(() => 'x.wav'),
      fetchBytes: vi.fn(async () => new Uint8Array([1, 2])),
      writeBytes: vi.fn((_bytes: Uint8Array, index: number) => `downloads/speech-${index}.mp3`),
    } as unknown as ImageDownloader,
    download,
  };
}

const AUDIO_URL = 'https://mock-api.test.qianwenai.com/hello.wav';

function makeDeps(overrides: Partial<TTSServiceDeps> = {}): TTSServiceDeps {
  return {
    parser: new RequestPayloadParser({
      readFile: () => {
        throw new Error('no file');
      },
      readStdin: () => '',
    }),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: makeResolver(DEFAULT_TTS_MODEL),
    registry: makeRegistry(),
    envelope: new InvocationEnvelope(),
    client: makeClient({ request_id: 'r-1', output: { audio: { url: AUDIO_URL } } }).client,
    wsClient: makeWsClient().wsClient,
    downloader: makeDownloader().downloader,
    context: () => ({ site: 'qianwen', account: 'acct-1' }),
    ...overrides,
  };
}

describe('TTSService.buildRequest — tier 0 text', () => {
  it('wraps bare text into a native input.text block', async () => {
    const svc = new TTSService(makeDeps());

    const { body } = await svc.buildRequest({ text: '欢迎使用千问云' });

    expect((body.input as Record<string, unknown>).text).toBe('欢迎使用千问云');
  });

  it('resolves the default model and stamps it on the body', async () => {
    const svc = new TTSService(makeDeps());

    const { model, body } = await svc.buildRequest({ text: 'x' });

    expect(model).toBe(DEFAULT_TTS_MODEL);
    expect(body.model).toBe(DEFAULT_TTS_MODEL);
  });

  it('applies the default Qwen3-TTS voice when none is supplied', async () => {
    const svc = new TTSService(makeDeps());

    const { body } = await svc.buildRequest({ text: 'x' });

    expect((body.input as Record<string, unknown>).voice).toBe(DEFAULT_TTS_VOICE);
  });
});

describe('TTSService.buildRequest — tier 1 model', () => {
  it('honours an explicit --model over the default', async () => {
    const svc = new TTSService(makeDeps({ modelResolver: makeResolver(DEFAULT_TTS_MODEL) }));

    const { model, body } = await svc.buildRequest({ text: 'x', model: 'qwen3-tts' });

    expect(model).toBe('qwen3-tts');
    expect(body.model).toBe('qwen3-tts');
  });

  it('lets a --request self-carried model win when no --model is given', async () => {
    const resolver = makeResolver(DEFAULT_TTS_MODEL);
    const svc = new TTSService(makeDeps({ modelResolver: resolver }));

    const { model } = await svc.buildRequest({
      request: '{"model":"qwen3-tts","input":{"text":"hi"}}',
    });

    expect(model).toBe('qwen3-tts');
  });

  it('overrides a --request model when --model is explicit', async () => {
    const svc = new TTSService(makeDeps());

    const { body } = await svc.buildRequest({
      model: 'qwen3-tts-flash',
      request: '{"model":"qwen3-tts","input":{"text":"hi"}}',
    });

    expect(body.model).toBe('qwen3-tts-flash');
  });
});

describe('TTSService.buildRequest — tier 2 voice', () => {
  it('maps --voice onto input.voice', async () => {
    const svc = new TTSService(makeDeps());

    const { body } = await svc.buildRequest({ text: 'x', voice: 'Ethan' });

    expect((body.input as Record<string, unknown>).voice).toBe('Ethan');
  });

  it('does not overwrite an explicit --voice with the default', async () => {
    const svc = new TTSService(makeDeps());

    const { body } = await svc.buildRequest({ text: 'x', voice: 'Ethan' });

    expect((body.input as Record<string, unknown>).voice).not.toBe(DEFAULT_TTS_VOICE);
  });

  it('writes --voice into a --request body that omits text', async () => {
    const svc = new TTSService(makeDeps());

    const { body } = await svc.buildRequest({
      voice: 'Cherry',
      request: '{"input":{"text":"你好"}}',
    });

    const input = body.input as Record<string, unknown>;
    expect(input.voice).toBe('Cherry');
    expect(input.text).toBe('你好');
  });
});

describe('TTSService.buildRequest — tier 3 passthrough', () => {
  it('preserves native language and control fields verbatim', async () => {
    const svc = new TTSService(makeDeps());

    const { body } = await svc.buildRequest({
      request: '{"model":"qwen3-tts-flash","input":{"text":"你好","voice":"Cherry","language_type":"Chinese"}}',
    });

    const input = body.input as Record<string, unknown>;
    expect(input.language_type).toBe('Chinese');
    expect(input.text).toBe('你好');
  });

  it('rejects combining bare text with a request.input block', async () => {
    const svc = new TTSService(makeDeps());

    await expect(
      svc.buildRequest({ text: 'hi', request: '{"input":{"text":"x"}}' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', exitCode: 4 });
  });

  it('rejects an empty invocation with neither text nor --request', async () => {
    const svc = new TTSService(makeDeps());

    await expect(svc.buildRequest({})).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      exitCode: 4,
    });
  });
});

describe('TTSService.buildRequest — endpoint routing', () => {
  it('routes a CosyVoice model to the SpeechSynthesizer HTTP endpoint', async () => {
    const svc = new TTSService(makeDeps({ modelResolver: makeResolver('cosyvoice-v2') }));

    const built = await svc.buildRequest({ text: 'hi', model: 'cosyvoice-v2' });

    expect(built.model).toBe('cosyvoice-v2');
    expect(built.path).toBe('/api/v1/services/audio/tts/SpeechSynthesizer');
  });

  it('routes a Qwen-Audio-TTS model to the SpeechSynthesizer HTTP endpoint', async () => {
    const svc = new TTSService(
      makeDeps({ modelResolver: makeResolver('qwen-audio-3.0-tts-flash') }),
    );

    const built = await svc.buildRequest({ text: 'hi', model: 'qwen-audio-3.0-tts-flash' });

    expect(built.path).toBe('/api/v1/services/audio/tts/SpeechSynthesizer');
  });

  it('applies the default voice for the default Qwen-Audio-TTS model', async () => {
    const svc = new TTSService(
      makeDeps({ modelResolver: makeResolver('qwen-audio-3.0-tts-plus') }),
    );

    const built = await svc.buildRequest({ text: 'hi', model: 'qwen-audio-3.0-tts-plus' });

    expect(built.path).toBe('/api/v1/services/audio/tts/SpeechSynthesizer');
    expect((built.body.input as Record<string, unknown>).voice).toBe('longanhuan_v3.6');
  });

  it('keeps a multimodal-TTS model on the default multimodal endpoint', async () => {
    const svc = new TTSService(makeDeps({ modelResolver: makeResolver('qwen3-tts-flash') }));

    const built = await svc.buildRequest({ text: 'hi', model: 'qwen3-tts-flash' });

    expect(built.path).toBeUndefined();
  });
});

describe('TTSService.extractUrls', () => {
  it('reads output.audio.url', () => {
    const svc = new TTSService(makeDeps());

    const urls = svc.extractUrls({ output: { audio: { url: AUDIO_URL } } });

    expect(urls).toEqual([AUDIO_URL]);
  });

  it('reads a scalar output.audio string url', () => {
    const svc = new TTSService(makeDeps());

    const urls = svc.extractUrls({ output: { audio: AUDIO_URL } });

    expect(urls).toEqual([AUDIO_URL]);
  });

  it('skips base64 audio payloads with no url', () => {
    const svc = new TTSService(makeDeps());

    const urls = svc.extractUrls({ output: { audio: { data: 'AAAA' } } });

    expect(urls).toEqual([]);
  });

  it('returns an empty list when no audio is present', () => {
    const svc = new TTSService(makeDeps());

    expect(svc.extractUrls({ output: {} })).toEqual([]);
  });
});

describe('TTSService.generate — synchronous download path', () => {
  it('downloads the synthesized audio and records the artifact path', async () => {
    const { downloader, download } = makeDownloader();
    const svc = new TTSService(makeDeps({ downloader }));

    const envelope = await svc.generate({ text: 'hi' });

    expect(download).toHaveBeenCalledTimes(1);
    const audio = (envelope.data as Record<string, unknown>).audio as Record<string, unknown>;
    expect(audio.url).toBe(AUDIO_URL);
    expect(audio.path).toBe('downloads/speech-0.wav');
  });

  it('forwards --out to the downloader', async () => {
    const { downloader, download } = makeDownloader();
    const svc = new TTSService(makeDeps({ downloader }));

    await svc.generate({ text: 'hi', out: 'hello.wav' });

    expect(download.mock.calls[0]![2]).toBe('hello.wav');
  });

  it('uses the audio extension from the upstream url as the download fallback', async () => {
    const { downloader, download } = makeDownloader();
    const svc = new TTSService(makeDeps({ downloader }));

    await svc.generate({ text: 'hi', out: 'hello' });

    expect(download.mock.calls[0]![3]).toBe('wav');
  });

  it('skips download when download is false and returns url-only artifacts', async () => {
    const { downloader, download } = makeDownloader();
    const svc = new TTSService(makeDeps({ downloader }));

    const envelope = await svc.generate({ text: 'hi', download: false });

    expect(download).not.toHaveBeenCalled();
    const audio = (envelope.data as Record<string, unknown>).audio as Record<string, unknown>;
    expect(audio.url).toBe(AUDIO_URL);
    expect('path' in audio).toBe(false);
  });

  it('surfaces the upstream request id on the envelope meta', async () => {
    const svc = new TTSService(makeDeps());

    const envelope = await svc.generate({ text: 'hi' });

    expect(envelope.meta.request_id).toBe('r-1');
  });

  it('forwards the CosyVoice SpeechSynthesizer endpoint to the client', async () => {
    const { client, generate } = makeClient({ output: { audio: { url: AUDIO_URL } } });
    const svc = new TTSService(makeDeps({ client, modelResolver: makeResolver('cosyvoice-v2') }));

    await svc.generate({ text: 'hi', model: 'cosyvoice-v2' });

    expect(generate.mock.calls[0]![2]).toBe('/api/v1/services/audio/tts/SpeechSynthesizer');
  });

  it('uses the default endpoint (no override) for a multimodal-TTS model', async () => {
    const { client, generate } = makeClient({ output: { audio: { url: AUDIO_URL } } });
    const svc = new TTSService(
      makeDeps({ client, modelResolver: makeResolver('qwen3-tts-flash') }),
    );

    await svc.generate({ text: 'hi', model: 'qwen3-tts-flash' });

    expect(generate.mock.calls[0]![2]).toBeUndefined();
  });

  it('omits request_id from meta when the upstream did not return one', async () => {
    const client = makeClient({ output: { audio: { url: AUDIO_URL } } }).client;
    const svc = new TTSService(makeDeps({ client }));

    const envelope = await svc.generate({ text: 'hi' });

    expect('request_id' in envelope.meta).toBe(false);
  });
});

describe('TTSService.generate — WebSocket-only models', () => {
  it('routes sambert models through the WebSocket client in out mode', async () => {
    const { wsClient, synthesize } = makeWsClient();
    const svc = new TTSService(
      makeDeps({ wsClient, modelResolver: makeResolver('sambert-zhinan-v1') }),
    );

    await svc.generate({ text: 'hi', model: 'sambert-zhinan-v1' });

    expect(synthesize).toHaveBeenCalledTimes(1);
    const req = synthesize.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.model).toBe('sambert-zhinan-v1');
    expect(req.streaming).toBe('out');
    expect(req.text).toBe('hi');
  });

  it('routes cosyvoice-v3.5 models through the WebSocket client in duplex mode', async () => {
    const { wsClient, synthesize } = makeWsClient();
    const svc = new TTSService(
      makeDeps({ wsClient, modelResolver: makeResolver('cosyvoice-v3.5-flash') }),
    );

    await svc.generate({ text: 'hi', model: 'cosyvoice-v3.5-flash', voice: 'longxiaochun' });

    const req = synthesize.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.streaming).toBe('duplex');
    const params = req.parameters as Record<string, unknown>;
    expect(params.voice).toBe('longxiaochun');
    expect(params.text_type).toBe('PlainText');
  });

  it('writes synthesized bytes to disk and returns path-only artifacts', async () => {
    const { wsClient } = makeWsClient(new Uint8Array([1, 2, 3]));
    const { downloader } = makeDownloader();
    const writeBytes = downloader.writeBytes as unknown as ReturnType<typeof vi.fn>;
    const svc = new TTSService(
      makeDeps({ wsClient, downloader, modelResolver: makeResolver('sambert-zhinan-v1') }),
    );

    const envelope = await svc.generate({ text: 'hi', model: 'sambert-zhinan-v1' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const audio = (envelope.data as Record<string, unknown>).audio as Record<string, unknown>;
    expect(audio).toEqual({ path: 'downloads/speech-0.mp3' });
    expect(audio).not.toHaveProperty('url');
  });

  it('skips writing when download is false', async () => {
    const { wsClient } = makeWsClient();
    const { downloader } = makeDownloader();
    const writeBytes = downloader.writeBytes as unknown as ReturnType<typeof vi.fn>;
    const svc = new TTSService(
      makeDeps({ wsClient, downloader, modelResolver: makeResolver('sambert-zhinan-v1') }),
    );

    const envelope = await svc.generate({ text: 'hi', model: 'sambert-zhinan-v1', download: false });

    expect(writeBytes).not.toHaveBeenCalled();
    expect('audio' in (envelope.data as Record<string, unknown>)).toBe(false);
  });

  it('adds a custom-voice hint when cosyvoice-v3.5 rejects a system voice', async () => {
    const synthesize = vi.fn().mockRejectedValue(
      new CliError({
        code: 'API_ERROR',
        message: 'Engine return error code: 418 (InvalidParameter)',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      }),
    );
    const wsClient = { synthesize } as unknown as Parameters<typeof makeDeps>[0]['wsClient'];
    const svc = new TTSService(
      makeDeps({ wsClient, modelResolver: makeResolver('cosyvoice-v3.5-flash') }),
    );

    await expect(
      svc.generate({ text: 'hi', model: 'cosyvoice-v3.5-flash', voice: 'longxiaochun_v2' }),
    ).rejects.toMatchObject({ hint: expect.stringContaining('custom voice') });
  });
});

describe('TTSService.buildRequest — model routing preflight', () => {
  it.each([
    'qwen3-omni-flash',
    'qwen2.5-omni-7b',
    'qwen3.5-omni-plus',
    'qwen-omni-turbo',
    'qwen3-livetranslate-flash',
    'qwen3.5-livetranslate-flash-realtime',
  ])('rejects multimodal chat model %s with a chat-create hint', async (model) => {
    const svc = new TTSService(makeDeps({ modelResolver: makeResolver(model) }));

    await expect(svc.buildRequest({ text: 'hi', model })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('chat create'),
    });
  });

  it.each([
    'qwen-tts-realtime',
    'qwen3-tts-flash-realtime',
    'qwen3-tts-instruct-flash-realtime',
    'qwen3-tts-vc-realtime-2025-11-27',
  ])('rejects realtime-only TTS model %s with a streaming hint', async (model) => {
    const svc = new TTSService(makeDeps({ modelResolver: makeResolver(model) }));

    await expect(svc.buildRequest({ text: 'hi', model })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('realtime'),
    });
  });

  it('still accepts a non-realtime Qwen TTS model', async () => {
    const svc = new TTSService(makeDeps({ modelResolver: makeResolver('qwen3-tts-flash') }));

    const { model } = await svc.buildRequest({ text: 'hi', model: 'qwen3-tts-flash' });

    expect(model).toBe('qwen3-tts-flash');
  });
});

describe('TTSService.generate — voice-clone/design hint on the HTTP path', () => {
  it.each(['qwen3-tts-vc-2026-01-22', 'qwen3-tts-vd-2026-01-26'])(
    'adds a custom-voice hint when %s rejects a system voice over HTTP',
    async (model) => {
      const generate = vi.fn().mockRejectedValue(
        new CliError({
          code: 'API_ERROR',
          message: 'InvalidParameter: voice not found',
          exitCode: EXIT_CODES.GENERAL_ERROR,
        }),
      );
      const client = { generate } as unknown as Parameters<typeof makeDeps>[0]['client'];
      const svc = new TTSService(makeDeps({ client, modelResolver: makeResolver(model) }));

      await expect(svc.generate({ text: 'hi', model, voice: 'Cherry' })).rejects.toMatchObject({
        hint: expect.stringContaining('custom voice'),
      });
    },
  );
});
