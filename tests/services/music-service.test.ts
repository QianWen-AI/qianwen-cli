/**
 * Unit tests for MusicService — tier 0/1/3 assembly into a native synchronous
 * Fun-Music body, generation via MusicClient, audio download, and the
 * site-availability guard on the generate path.
 *
 * Real base collaborators are injected (parsing, conflict detection, resolver,
 * registry, envelope, guard); only the synthesis client and downloader are
 * substituted.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MusicService,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_MUSIC_TIMEOUT_MS,
  registerMusicMappings,
  type MusicServiceDeps,
} from '../../src/services/music-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { SiteAvailabilityGuard } from '../../src/services/site-availability.js';
import type { MusicClient } from '../../src/api/providers/dashscope/music-client.js';
import type { ImageDownloader } from '../../src/services/image-downloader.js';
import { CliError } from '../../src/utils/errors.js';

const AUDIO_URL = 'https://mock-api.test.qianwenai.com/song.mp3';

function makeParser(): RequestPayloadParser {
  return new RequestPayloadParser({
    readFile: () => {
      throw new Error('unexpected readFile');
    },
    readStdin: () => '',
  });
}

function makeResolver(): DefaultModelResolver {
  return new DefaultModelResolver({
    fetchMapping: async () => ({ [`music generate:music`]: DEFAULT_MUSIC_MODEL }),
    readCache: () => null,
    writeCache: () => {},
  });
}

/**
 * Build a client whose `generateStream` yields the given SSE events, plus a
 * `generate` stub for the `--no-stream` path.
 */
function makeStreamClient(
  events: Array<Record<string, unknown>>,
  syncResponse: Record<string, unknown> = { output: { audio: { url: AUDIO_URL } } },
): {
  client: MusicClient;
  generateStream: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
} {
  const generateStream = vi.fn(async function* () {
    for (const event of events) yield event;
  });
  const generate = vi.fn().mockResolvedValue(syncResponse);
  return {
    client: { generateStream, generate } as unknown as MusicClient,
    generateStream,
    generate,
  };
}

function makeDownloader(): { downloader: ImageDownloader; download: ReturnType<typeof vi.fn> } {
  const download = vi.fn(async (_url: string, index: number) => `downloads/music-${index}.mp3`);
  return {
    downloader: {
      download,
      writeBytes: vi.fn((_bytes: Uint8Array, index: number) => `downloads/music-${index}.mp3`),
      inferFileName: vi.fn(() => 'x.mp3'),
      fetchBytes: vi.fn(async () => new Uint8Array([1])),
    } as unknown as ImageDownloader,
    download,
  };
}

function makeDownloaderWithBytes(): {
  downloader: ImageDownloader;
  download: ReturnType<typeof vi.fn>;
  writeBytes: ReturnType<typeof vi.fn>;
} {
  const download = vi.fn(async (_url: string, index: number) => `downloads/music-${index}.mp3`);
  const writeBytes = vi.fn((_bytes: Uint8Array, index: number) => `downloads/music-${index}.mp3`);
  return {
    downloader: {
      download,
      writeBytes,
      inferFileName: vi.fn(() => 'x.mp3'),
      fetchBytes: vi.fn(async () => new Uint8Array([1])),
    } as unknown as ImageDownloader,
    download,
    writeBytes,
  };
}

function makeGuard(site = 'qianwen'): SiteAvailabilityGuard {
  return new SiteAvailabilityGuard({
    site: () => site,
    availableSites: new Set(['qianwen']),
    command: 'music generate',
  });
}

function makeRegistry(): MappingRegistry {
  const registry = new MappingRegistry();
  registerMusicMappings(registry);
  return registry;
}

function makeDeps(overrides: Partial<MusicServiceDeps> = {}): MusicServiceDeps {
  return {
    parser: makeParser(),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: makeResolver(),
    registry: makeRegistry(),
    envelope: new InvocationEnvelope(),
    client: makeStreamClient([
      { requestId: 'r-1', audioData: 'YWJj', finishReason: 'null' },
      { requestId: 'r-1', url: AUDIO_URL, finishReason: 'stop', usage: { duration: 30 } },
    ]).client,
    downloader: makeDownloader().downloader,
    guard: makeGuard(),
    context: () => ({ site: 'qianwen', account: 'QIANWEN_API_KEY' }),
    ...overrides,
  };
}

describe('MusicService.buildRequest — tier 0 / tier 1', () => {
  it('wraps a bare prompt into input.prompt with the default model', async () => {
    const svc = new MusicService(makeDeps());

    const { model, body } = await svc.buildRequest({ prompt: '轻快的钢琴曲' });

    expect(model).toBe(DEFAULT_MUSIC_MODEL);
    expect(body.model).toBe(DEFAULT_MUSIC_MODEL);
    expect(body.input).toEqual({ prompt: '轻快的钢琴曲' });
  });

  it('honours an explicit --model over the default', async () => {
    const svc = new MusicService(makeDeps());

    const { model } = await svc.buildRequest({ prompt: 'x', model: 'fun-music-v2' });

    expect(model).toBe('fun-music-v2');
  });

  it('preserves native lyrics/instrumental fields from --request verbatim', async () => {
    const svc = new MusicService(makeDeps());

    const { body } = await svc.buildRequest({
      request: '{"model":"fun-music-v1","input":{"lyrics":"[verse]清晨的风","is_instrumental":true}}',
    });

    const input = body.input as Record<string, unknown>;
    expect(input.lyrics).toBe('[verse]清晨的风');
    expect(input.is_instrumental).toBe(true);
  });

  it('rejects an empty invocation with neither prompt nor --request', async () => {
    const svc = new MusicService(makeDeps());

    await expect(svc.buildRequest({})).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      exitCode: 4,
    });
  });

  it('rejects combining a prompt with request.input', async () => {
    const svc = new MusicService(makeDeps());

    await expect(
      svc.buildRequest({ prompt: 'x', request: '{"input":{"prompt":"y"}}' }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe('MusicService.extractUrls', () => {
  it('reads output.audio.url', () => {
    const svc = new MusicService(makeDeps());
    expect(svc.extractUrls({ output: { audio: { url: AUDIO_URL } } })).toEqual([AUDIO_URL]);
  });

  it('reads a scalar output.audio string url', () => {
    const svc = new MusicService(makeDeps());
    expect(svc.extractUrls({ output: { audio: AUDIO_URL } })).toEqual([AUDIO_URL]);
  });

  it('returns an empty list when no audio url is present', () => {
    const svc = new MusicService(makeDeps());
    expect(svc.extractUrls({ output: {} })).toEqual([]);
  });
});

describe('MusicService.generate — SSE streaming (default)', () => {
  it('raises the site-not-available error before building or requesting', async () => {
    const svc = new MusicService(makeDeps({ guard: makeGuard('other-site') }));

    await expect(svc.generate({ prompt: 'x' })).rejects.toMatchObject({ exitCode: 4 });
  });

  it('streams over SSE and downloads the terminal audio url', async () => {
    const { downloader, download } = makeDownloader();
    const { client, generateStream, generate } = makeStreamClient([
      { audioData: 'YWJj', finishReason: 'null' },
      { requestId: 'r-9', url: AUDIO_URL, finishReason: 'stop', usage: { duration: 30 } },
    ]);
    const svc = new MusicService(makeDeps({ client, downloader }));

    const envelope = await svc.generate({ prompt: 'x' });

    expect(generateStream).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
    const audio = (envelope.data as Record<string, unknown>).audio as Record<string, unknown>;
    expect(audio.url).toBe(AUDIO_URL);
    expect(audio.path).toBe('downloads/music-0.mp3');
    expect(envelope.meta.request_id).toBe('r-9');
  });

  it('reconstructs audio from base64 chunks when only interim frames arrive', async () => {
    const { downloader, download, writeBytes } = makeDownloaderWithBytes();
    const { client } = makeStreamClient([
      { audioData: Buffer.from('hello').toString('base64'), finishReason: 'null' },
      { audioData: Buffer.from('world').toString('base64'), finishReason: 'stop' },
    ]);
    const svc = new MusicService(makeDeps({ client, downloader }));

    const envelope = await svc.generate({ prompt: 'x' });

    expect(download).not.toHaveBeenCalled();
    expect(writeBytes).toHaveBeenCalledTimes(1);
    const writtenBytes = writeBytes.mock.calls[0]![0] as Uint8Array;
    expect(Buffer.from(writtenBytes).toString('utf-8')).toBe('helloworld');
    const audio = (envelope.data as Record<string, unknown>).audio as Record<string, unknown>;
    expect(audio.path).toBe('downloads/music-0.mp3');
  });

  it('skips download when download is false and returns url-only artifacts', async () => {
    const { downloader, download } = makeDownloader();
    const svc = new MusicService(makeDeps({ downloader }));

    const envelope = await svc.generate({ prompt: 'x', download: false });

    expect(download).not.toHaveBeenCalled();
    const audio = (envelope.data as Record<string, unknown>).audio as Record<string, unknown>;
    expect(audio.url).toBe(AUDIO_URL);
    expect('path' in audio).toBe(false);
  });

  it('forwards --out to the downloader', async () => {
    const { downloader, download } = makeDownloader();
    const svc = new MusicService(makeDeps({ downloader }));

    await svc.generate({ prompt: 'x', out: 'travel.mp3' });

    expect(download.mock.calls[0]![2]).toBe('travel.mp3');
  });

  it('errors when the stream ends without any audio output', async () => {
    const { client } = makeStreamClient([]);
    const svc = new MusicService(makeDeps({ client }));

    await expect(svc.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('enriches a stream stall (NETWORK_ERROR) with an actionable timeout hint', async () => {
    const generateStream = vi.fn(async function* () {
      // Simulate the transport aborting on an inactivity stall before any frame.
      throw new CliError({
        code: 'NETWORK_ERROR',
        message: 'Request stalled: the server sent no response for 300000ms',
        exitCode: 3,
      });
      yield {} as never;
    });
    const client = { generateStream, generate: vi.fn() } as unknown as MusicClient;
    const svc = new MusicService(makeDeps({ client }));

    await expect(svc.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      hint: expect.stringContaining('--timeout'),
    });
  });

  it('forwards the per-request timeout to the stream (only bounds the connection open)', async () => {
    const { client, generateStream } = makeStreamClient([
      { url: AUDIO_URL, finishReason: 'stop' },
    ]);
    const svc = new MusicService(makeDeps({ client }));

    await svc.generate({ prompt: 'x' });
    expect(generateStream.mock.calls[0]![2]).toBe(DEFAULT_MUSIC_TIMEOUT_MS);

    generateStream.mockClear();
    await svc.generate({ prompt: 'x', timeoutMs: 123456 });
    expect(generateStream.mock.calls[0]![2]).toBe(123456);
  });
});

describe('MusicService.generate — blocking (--no-stream)', () => {
  it('uses the one-shot generate() and raises the request timeout', async () => {
    const { client, generate } = makeStreamClient(
      [],
      { request_id: 'r-1', output: { audio: { url: AUDIO_URL } } },
    );
    const svc = new MusicService(makeDeps({ client }));

    await svc.generate({ prompt: 'x', stream: false });
    expect(generate.mock.calls[0]![2]).toBe(DEFAULT_MUSIC_TIMEOUT_MS);

    generate.mockClear();
    await svc.generate({ prompt: 'x', stream: false, timeoutMs: 123456 });
    expect(generate.mock.calls[0]![2]).toBe(123456);
  });

  it('downloads the synthesized audio and records the artifact path', async () => {
    const { downloader, download } = makeDownloader();
    const { client } = makeStreamClient([], {
      request_id: 'r-1',
      output: { audio: { url: AUDIO_URL } },
    });
    const svc = new MusicService(makeDeps({ client, downloader }));

    const envelope = await svc.generate({ prompt: 'x', stream: false });

    expect(download).toHaveBeenCalledTimes(1);
    const audio = (envelope.data as Record<string, unknown>).audio as Record<string, unknown>;
    expect(audio.url).toBe(AUDIO_URL);
    expect(audio.path).toBe('downloads/music-0.mp3');
  });
});
