/**
 * Unit tests for VideoService — tier 0/1/2/3 assembly into a native async body,
 * submission via VideoClient, wait orchestration via TaskService, and optional
 * client-side download.
 *
 * Real RequestPayloadParser, LayerConflictDetector, DefaultModelResolver,
 * MappingRegistry, InvocationEnvelope, AsyncWaiter and TaskService are injected;
 * only the network transport and filesystem download boundary are substituted.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  VideoService,
  DEFAULT_T2V_MODEL,
  DEFAULT_I2V_MODEL,
  type VideoServiceDeps,
} from '../../src/services/video-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import { AssetPolicy } from '../../src/services/asset-policy.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { AsyncWaiter } from '../../src/services/async-waiter.js';
import { TaskService } from '../../src/services/task-service.js';
import { TaskClient } from '../../src/api/providers/dashscope/task-client.js';
import { VideoClient } from '../../src/api/providers/dashscope/video-client.js';
import { ImageDownloader } from '../../src/services/image-downloader.js';
import type { DashScopeTransport } from '../../src/api/providers/dashscope/transport.js';

function makeParser(): RequestPayloadParser {
  return new RequestPayloadParser({
    readFile: (p: string) => {
      throw new Error(`unexpected readFile(${p})`);
    },
    readStdin: () => {
      throw new Error('unexpected readStdin');
    },
  });
}

function makeResolver(): DefaultModelResolver {
  return new DefaultModelResolver({
    fetchMapping: async () => ({
      [`video generate:t2v`]: DEFAULT_T2V_MODEL,
      [`video generate:i2v`]: DEFAULT_I2V_MODEL,
    }),
    readCache: () => null,
    writeCache: () => {},
  });
}

function makeAssetPolicy(
  resolvedUrl = 'https://mock-media.test.qianwenai.com/frame.png',
): AssetPolicy {
  return new AssetPolicy({
    readFileBytes: () => Buffer.from('bytes'),
    fileExists: () => true,
    uploadTemp: async () => resolvedUrl,
    readCache: () => null,
    writeCache: () => {},
  });
}

function makeDownloader(record?: { downloaded: string[] }): ImageDownloader {
  return new ImageDownloader({
    fetchBytes: async () => new Uint8Array([1, 2, 3]),
    writeFile: (path: string) => {
      record?.downloaded.push(path);
    },
    ensureDir: () => {},
    fileExists: () => false,
    isDirectory: () => false,
  });
}

function makeTaskService(responses: Array<Record<string, unknown>>): {
  taskService: TaskService;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  for (const r of responses) request.mockResolvedValueOnce(r);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  const client = new TaskClient({ transport });
  let clock = 0;
  const waiter = new AsyncWaiter({
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  });
  return {
    taskService: new TaskService({ client, waiter, envelope: new InvocationEnvelope() }),
    request,
  };
}

function makeVideoClient(submitResponse: Record<string, unknown>): {
  client: VideoClient;
  submitBody: () => Record<string, unknown>;
} {
  const request = vi.fn().mockResolvedValue(submitResponse);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return {
    client: new VideoClient({ transport }),
    submitBody: () => (request.mock.calls[0]![0] as { body: Record<string, unknown> }).body,
  };
}

function makeVideoClientWithHeaders(submitResponse: Record<string, unknown>): {
  client: VideoClient;
  submitHeaders: () => Record<string, string> | undefined;
} {
  const request = vi.fn().mockResolvedValue(submitResponse);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return {
    client: new VideoClient({ transport }),
    submitHeaders: () =>
      (request.mock.calls[0]![0] as { headers?: Record<string, string> }).headers,
  };
}

function makeDeps(overrides: Partial<VideoServiceDeps> = {}): VideoServiceDeps {
  return {
    parser: makeParser(),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: makeResolver(),
    registry: new MappingRegistry(),
    assetPolicy: makeAssetPolicy(),
    taskService: makeTaskService([]).taskService,
    client: makeVideoClient({ output: { task_id: 't' } }).client,
    downloader: makeDownloader(),
    context: () => ({ site: 'qianwen', account: 'QIANWEN_API_KEY' }),
    ...overrides,
  };
}

describe('VideoService.buildRequest — tier 0 / tier 1', () => {
  it('builds a text-to-video body with the default T2V model', async () => {
    const service = new VideoService(makeDeps());
    const { model, body } = await service.buildRequest({ prompt: 'sunset over the sea' });

    expect(model).toBe(DEFAULT_T2V_MODEL);
    expect(body.model).toBe(DEFAULT_T2V_MODEL);
    expect(body.input).toEqual({ prompt: 'sunset over the sea' });
    expect(body.parameters).toEqual({});
  });

  it('honors an explicit --model over the default', async () => {
    const service = new VideoService(makeDeps());
    const { model, body } = await service.buildRequest({
      prompt: 'a running horse',
      model: 'wan2.7-t2v-turbo',
    });

    expect(model).toBe('wan2.7-t2v-turbo');
    expect(body.model).toBe('wan2.7-t2v-turbo');
  });
});

describe('VideoService.buildRequest — tier 2 --image mode switch (I2V)', () => {
  it('switches to the default I2V model and builds Wan2.7 media first_frame', async () => {
    const service = new VideoService(
      makeDeps({ assetPolicy: makeAssetPolicy('https://mock-media.test.qianwenai.com/cat.png') }),
    );
    const { model, body } = await service.buildRequest({
      prompt: 'make the cat run',
      image: 'cat.png',
    });

    expect(model).toBe(DEFAULT_I2V_MODEL);
    const input = body.input as Record<string, unknown>;
    expect(input.prompt).toBe('make the cat run');
    expect(input.media).toEqual([
      { type: 'first_frame', url: 'https://mock-media.test.qianwenai.com/cat.png' },
    ]);
    expect('img_url' in input).toBe(false);
  });

  it('uses input.img_url for legacy Wan2.1-2.6 I2V models', async () => {
    const service = new VideoService(
      makeDeps({ assetPolicy: makeAssetPolicy('https://mock-media.test.qianwenai.com/a.png') }),
    );
    const { model, body } = await service.buildRequest({
      prompt: 'animate',
      model: 'wan2.1-i2v',
      image: 'a.png',
    });

    expect(model).toBe('wan2.1-i2v');
    const input = body.input as Record<string, unknown>;
    expect(input.img_url).toBe('https://mock-media.test.qianwenai.com/a.png');
    expect('media' in input).toBe(false);
  });

  it('passes an http --image straight through as first_frame url', async () => {
    const service = new VideoService(makeDeps());
    const { body } = await service.buildRequest({
      prompt: 'go',
      image: 'https://mock-media.test.qianwenai.com/remote.png',
    });
    const input = body.input as Record<string, unknown>;
    expect(input.media).toEqual([
      { type: 'first_frame', url: 'https://mock-media.test.qianwenai.com/remote.png' },
    ]);
  });
});

describe('VideoService.buildRequest — tier 3 passthrough and errors', () => {
  it('passes a native --request body through without pre-validating media', async () => {
    const service = new VideoService(makeDeps());
    const raw = JSON.stringify({
      model: 'wan2.7-i2v',
      input: {
        prompt: 'edit',
        media: [{ type: 'last_frame', url: 'https://mock-media.test.qianwenai.com/last.png' }],
      },
      parameters: { resolution: '720P', ratio: '16:9', duration: 10 },
    });
    const { body } = await service.buildRequest({ request: raw });

    expect(body.model).toBe('wan2.7-i2v');
    expect((body.input as Record<string, unknown>).media).toEqual([
      { type: 'last_frame', url: 'https://mock-media.test.qianwenai.com/last.png' },
    ]);
    expect(body.parameters).toEqual({ resolution: '720P', ratio: '16:9', duration: 10 });
  });

  it('lets --model override the model inside a --request body', async () => {
    const service = new VideoService(makeDeps());
    const raw = JSON.stringify({ model: 'wan2.7-t2v', input: { prompt: 'x' } });
    const { model, body } = await service.buildRequest({ request: raw, model: 'wan2.7-t2v-plus' });

    expect(model).toBe('wan2.7-t2v-plus');
    expect(body.model).toBe('wan2.7-t2v-plus');
  });

  it('rejects prompt together with request.input (exit 4)', async () => {
    const service = new VideoService(makeDeps());
    const raw = JSON.stringify({ input: { prompt: 'from request' } });

    await expect(service.buildRequest({ prompt: 'from flag', request: raw })).rejects.toMatchObject(
      {
        exitCode: 4,
      },
    );
  });

  it('rejects when neither prompt nor --request is provided (exit 4)', async () => {
    const service = new VideoService(makeDeps());
    await expect(service.buildRequest({})).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects an explicit T2V model combined with --image (no silent I2V switch)', async () => {
    const service = new VideoService(makeDeps());
    await expect(
      service.buildRequest({ prompt: 'p', model: 'wan2.7-t2v', image: 'cat.png' }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects --image when request already carries the same input segment (exit 4)', async () => {
    const service = new VideoService(makeDeps());
    const raw = JSON.stringify({
      input: {
        media: [{ type: 'first_frame', url: 'https://mock-media.test.qianwenai.com/x.png' }],
      },
    });
    await expect(
      service.buildRequest({ model: 'wan2.7-i2v', image: 'cat.png', request: raw }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe('VideoService.generate — async submit + wait', () => {
  it('submits, waits to succeeded, and returns urls without downloading when --out is absent', async () => {
    const submit = { output: { task_id: 'vt-1', task_status: 'PENDING' } };
    const succeeded = {
      request_id: 'q-1',
      output: {
        task_id: 'vt-1',
        task_status: 'SUCCEEDED',
        video_url: 'https://mock-media.test.qianwenai.com/out.mp4',
      },
    };
    const record = { downloaded: [] as string[] };
    const service = new VideoService(
      makeDeps({
        client: makeVideoClient(submit).client,
        taskService: makeTaskService([succeeded]).taskService,
        downloader: makeDownloader(record),
      }),
    );

    const outcome = await service.generate({ prompt: 'sunset' });

    expect(outcome.completed).toBe(true);
    expect(outcome.envelope.data.task_status).toBe('SUCCEEDED');
    expect(outcome.envelope.data.video_url).toBe('https://mock-media.test.qianwenai.com/out.mp4');
    expect('urls' in outcome.envelope.data).toBe(false);
    expect('artifacts' in outcome.envelope.data).toBe(false);
    expect('path' in outcome.envelope.data).toBe(false);
    expect(record.downloaded).toEqual([]);
  });

  it('throws the upstream reason when the task reaches a FAILED terminal state', async () => {
    const submit = { output: { task_id: 'vt-2', task_status: 'PENDING' } };
    const failed = {
      request_id: 'q-2',
      output: {
        task_id: 'vt-2',
        task_status: 'FAILED',
        code: 'InvalidParameter',
        message: 'ratio is not supported by this model',
      },
    };
    const service = new VideoService(
      makeDeps({
        client: makeVideoClient(submit).client,
        taskService: makeTaskService([failed]).taskService,
      }),
    );

    await expect(service.generate({ prompt: 'sunset' })).rejects.toThrowError(
      /ratio is not supported/,
    );
  });

  it('downloads the video and records artifacts when --out is provided', async () => {
    const submit = { output: { task_id: 'vt-2', task_status: 'PENDING' } };
    const succeeded = {
      output: {
        task_id: 'vt-2',
        task_status: 'SUCCEEDED',
        video_url: 'https://mock-media.test.qianwenai.com/clip.mp4',
      },
    };
    const record = { downloaded: [] as string[] };
    const service = new VideoService(
      makeDeps({
        client: makeVideoClient(submit).client,
        taskService: makeTaskService([succeeded]).taskService,
        downloader: makeDownloader(record),
      }),
    );

    const outcome = await service.generate({ prompt: 'sunset', out: 'clip.mp4' });

    expect(outcome.completed).toBe(true);
    expect(outcome.envelope.data.video_url).toBe('https://mock-media.test.qianwenai.com/clip.mp4');
    expect(outcome.envelope.data.path).toBe('clip.mp4');
    expect(record.downloaded).toEqual(['clip.mp4']);
  });

  it('returns the submission task id immediately when wait is disabled', async () => {
    const submit = { output: { task_id: 'vt-3', task_status: 'PENDING' } };
    const { taskService, request } = makeTaskService([]);
    const service = new VideoService(
      makeDeps({ client: makeVideoClient(submit).client, taskService }),
    );

    const outcome = await service.generate({ prompt: 'sunset', wait: false });

    expect(outcome.completed).toBe(false);
    expect(outcome.envelope.data.task_id).toBe('vt-3');
    expect(outcome.envelope.data.task_status).toBe('PENDING');
    expect(request).not.toHaveBeenCalled();
  });

  it('reports completed=false with a follow-up hint on timeout', async () => {
    const submit = { output: { task_id: 'vt-4', task_status: 'PENDING' } };
    const pending = { output: { task_id: 'vt-4', task_status: 'RUNNING' } };
    const service = new VideoService(
      makeDeps({
        client: makeVideoClient(submit).client,
        taskService: makeTaskService([pending, pending, pending]).taskService,
      }),
    );

    const outcome = await service.generate({
      prompt: 'sunset',
      wait: true,
      timeoutMs: 1000,
      pollIntervalMs: 2000,
    });

    expect(outcome.completed).toBe(false);
    expect(outcome.envelope.data.task_id).toBe('vt-4');
    expect(String(outcome.envelope.data.hint)).toContain('task get');
    expect(outcome.envelope.data.hint).toContain('vt-4');
  });
});

describe('VideoService.generate — OSS resolve header propagation', () => {
  it('forwards the OSS resolve header (alongside the async header) for an oss:// frame', async () => {
    const stub = makeVideoClientWithHeaders({ output: { task_id: 'vt-oss' } });
    const service = new VideoService(makeDeps({ client: stub.client }));

    await service.generate({
      prompt: 'animate',
      image: 'oss://qwen-uploads/20260610/cat.png',
      wait: false,
    });

    const headers = stub.submitHeaders();
    expect(headers?.['X-DashScope-OssResourceResolve']).toBe('enable');
    expect(headers?.['X-DashScope-Async']).toBe('enable');
  });

  it('omits the resolve header for text-to-video (no --image)', async () => {
    const stub = makeVideoClientWithHeaders({ output: { task_id: 'vt-t2v' } });
    const service = new VideoService(makeDeps({ client: stub.client }));

    await service.generate({ prompt: 'sunset', wait: false });

    const headers = stub.submitHeaders();
    expect(headers?.['X-DashScope-OssResourceResolve']).toBeUndefined();
    expect(headers?.['X-DashScope-Async']).toBe('enable');
  });
});
