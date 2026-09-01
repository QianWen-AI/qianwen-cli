/**
 * Unit tests for ImageService — orchestration of tiers 0/1/2/3 into a native
 * DashScope image body, plus the synchronous generate path with download / b64
 * post-processing.
 *
 * Real base collaborators are injected (request parsing, conflict detection,
 * envelope construction, mapping registry). Only the outermost boundaries are
 * substituted: the model resolver (network), the asset policy (fs/upload), the
 * image client (HTTP) and the downloader (fs/network).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ImageService,
  type ImageServiceDeps,
  registerImageMappings,
  DEFAULT_IMAGE_TIMEOUT_MS,
} from '../../src/services/image-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import type { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import type { AssetPolicy } from '../../src/services/asset-policy.js';
import type { ImageClient } from '../../src/api/providers/dashscope/image-client.js';
import type { ImageDownloader } from '../../src/services/image-downloader.js';
import { TaskService } from '../../src/services/task-service.js';
import { TaskClient } from '../../src/api/providers/dashscope/task-client.js';
import { AsyncWaiter } from '../../src/services/async-waiter.js';
import type { DashScopeTransport } from '../../src/api/providers/dashscope/transport.js';

function makeRegistry(): MappingRegistry {
  const registry = new MappingRegistry();
  registerImageMappings(registry);
  return registry;
}

function makeResolver(model: string): DefaultModelResolver {
  return {
    resolve: vi.fn(async (_q: unknown, flag?: string) => flag ?? model),
  } as unknown as DefaultModelResolver;
}

function makeAssetPolicy(url: string): AssetPolicy {
  return {
    resolve: vi.fn(async () => ({ url, delivery: 'public-url' as const })),
  } as unknown as AssetPolicy;
}

function makeOssAssetPolicy(url: string): AssetPolicy {
  return {
    resolve: vi.fn(async () => ({
      url,
      delivery: 'temp-upload' as const,
      extraHeaders: { 'X-DashScope-OssResourceResolve': 'enable' },
    })),
  } as unknown as AssetPolicy;
}

function makeClient(response: Record<string, unknown>): {
  client: ImageClient;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn().mockResolvedValue(response);
  const submit = vi.fn().mockResolvedValue(response);
  return { client: { generate, submit } as unknown as ImageClient, generate };
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

function makeDownloader(): { downloader: ImageDownloader; download: ReturnType<typeof vi.fn> } {
  const download = vi.fn(async (_url: string, index: number) => `downloads/img-${index}.png`);
  return {
    downloader: {
      download,
      inferFileName: vi.fn(() => 'x.png'),
      fetchBytes: vi.fn(async () => new Uint8Array([9, 9])),
    } as unknown as ImageDownloader,
    download,
  };
}

function makeDeps(overrides: Partial<ImageServiceDeps> = {}): ImageServiceDeps {
  return {
    parser: new RequestPayloadParser({
      readFile: () => {
        throw new Error('no file');
      },
      readStdin: () => '',
    }),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: makeResolver('qwen-image-2.0'),
    registry: makeRegistry(),
    assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/src.png'),
    envelope: new InvocationEnvelope(),
    client: makeClient({ request_id: 'r-1' }).client,
    downloader: makeDownloader().downloader,
    taskService: makeTaskService([]).taskService,
    context: () => ({ site: 'qianwen', account: 'acct-1' }),
    ...overrides,
  };
}

describe('ImageService.buildRequest — tier 0 generation', () => {
  it('wraps a bare prompt into a native input.messages content block', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({ prompt: 'cyberpunk city' });

    expect(body.input).toEqual({
      messages: [{ role: 'user', content: [{ text: 'cyberpunk city' }] }],
    });
  });

  it('resolves the default model and stamps it on the body', async () => {
    const svc = new ImageService(makeDeps({ modelResolver: makeResolver('qwen-image-2.0') }));

    const { model, body } = await svc.buildRequest({ prompt: 'x' });

    expect(model).toBe('qwen-image-2.0');
    expect(body.model).toBe('qwen-image-2.0');
  });

  it('omits parameters when neither size nor n is given', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({ prompt: 'x' });

    expect(body.parameters).toBeUndefined();
  });

  it('maps --size onto parameters.size', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({ prompt: 'x', size: '1024*1024' });

    expect((body.parameters as Record<string, unknown>).size).toBe('1024*1024');
  });

  it('maps --n onto parameters.n', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({ prompt: 'x', n: 3 });

    expect((body.parameters as Record<string, unknown>).n).toBe(3);
  });

  it('rejects a non-positive --n with exit 4', async () => {
    const svc = new ImageService(makeDeps());

    await expect(svc.buildRequest({ prompt: 'x', n: 0 })).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects a fractional --n with exit 4', async () => {
    const svc = new ImageService(makeDeps());

    await expect(svc.buildRequest({ prompt: 'x', n: 2.5 })).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects --n above the model ceiling with exit 4', async () => {
    const svc = new ImageService(makeDeps());

    await expect(svc.buildRequest({ prompt: 'x', n: 7 })).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects --n above the single-image ceiling for a plain image model', async () => {
    const svc = new ImageService(makeDeps({ modelResolver: makeResolver('qwen-image-max') }));

    await expect(
      svc.buildRequest({ prompt: 'x', model: 'qwen-image-max', n: 2 }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects a --size that is not a width*height shape with exit 4', async () => {
    const svc = new ImageService(makeDeps());

    await expect(svc.buildRequest({ prompt: 'x', size: '1024' })).rejects.toMatchObject({
      exitCode: 4,
    });
  });

  it('does not treat --out or --response-format as body fields', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({ prompt: 'x', out: 'pics/', responseFormat: 'b64' });

    expect('out' in body).toBe(false);
    expect('response_format' in body).toBe(false);
  });
});

describe('ImageService.buildRequest — edit mode via --image', () => {
  it('builds an image content part alongside text for an edit-capable model', async () => {
    const svc = new ImageService(
      makeDeps({
        modelResolver: makeResolver('qwen-image-edit-plus'),
        assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/src.png'),
      }),
    );

    const { body } = await svc.buildRequest({
      prompt: 'replace the sky',
      model: 'qwen-image-edit-plus',
      image: './src.png',
    });

    expect(body.input).toEqual({
      messages: [
        {
          role: 'user',
          content: [
            { image: 'https://mock-api.test.qianwenai.com/src.png' },
            { text: 'replace the sky' },
          ],
        },
      ],
    });
  });

  it('does not inject a default size in edit mode', async () => {
    const svc = new ImageService(makeDeps({ modelResolver: makeResolver('qwen-image-edit-plus') }));

    const { body } = await svc.buildRequest({
      prompt: 'edit',
      model: 'qwen-image-edit-plus',
      image: './src.png',
    });

    expect('parameters' in body).toBe(false);
  });

  it('rejects --image on a model that does not support editing with exit 4', async () => {
    const svc = new ImageService(makeDeps());

    await expect(
      svc.buildRequest({
        prompt: 'x',
        model: 'qwen-image-2.0-pro-preview-nonedit',
        image: './s.png',
      }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe('ImageService.buildRequest — tier 3 passthrough & conflicts', () => {
  it('passes a --request body through unchanged when no flags collide', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({
      request:
        '{"input":{"messages":[{"role":"user","content":[{"text":"hi"}]}]},"parameters":{"seed":123}}',
    });

    expect((body.parameters as Record<string, unknown>).seed).toBe(123);
    expect(body.input).toBeDefined();
  });

  it('lets --model override request.model while keeping other keys', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({
      model: 'qwen-image-2.0-pro',
      request: '{"model":"qwen-image-2.0","input":{"messages":[]}}',
    });

    expect(body.model).toBe('qwen-image-2.0-pro');
  });

  it('honors request.model when --model is absent (does not fall back to default)', async () => {
    const svc = new ImageService(makeDeps());

    const { model, body } = await svc.buildRequest({
      request: '{"model":"wanx2.1-t2i-turbo","input":{"prompt":"x"}}',
    });

    expect(model).toBe('wanx2.1-t2i-turbo');
    expect(body.model).toBe('wanx2.1-t2i-turbo');
  });

  it('rejects a prompt together with request.input (exit 4)', async () => {
    const svc = new ImageService(makeDeps());

    await expect(
      svc.buildRequest({ prompt: 'x', request: '{"input":{"messages":[]}}' }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects when neither a prompt nor a --request is supplied (exit 4)', async () => {
    const svc = new ImageService(makeDeps());

    await expect(svc.buildRequest({})).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects a --size that duplicates a request parameters.size (exit 4)', async () => {
    const svc = new ImageService(makeDeps());

    await expect(
      svc.buildRequest({
        prompt: 'x',
        size: '1024*1024',
        request: '{"parameters":{"size":"512*512"}}',
      }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('does not construct input from the prompt when request already supplies it', async () => {
    const svc = new ImageService(makeDeps());

    const { body } = await svc.buildRequest({
      request: '{"input":{"messages":[{"role":"user","content":[{"text":"only"}]}]}}',
    });

    const messages = (body.input as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(1);
  });
});

describe('ImageService.extractUrls', () => {
  it('reads image URLs from output.choices[].message.content[].image', () => {
    const svc = new ImageService(makeDeps());

    const urls = svc.extractUrls({
      output: {
        choices: [
          { message: { content: [{ image: 'https://mock-api.test.qianwenai.com/a.png' }] } },
          { message: { content: [{ image: 'https://mock-api.test.qianwenai.com/b.png' }] } },
        ],
      },
    });

    expect(urls).toEqual([
      'https://mock-api.test.qianwenai.com/a.png',
      'https://mock-api.test.qianwenai.com/b.png',
    ]);
  });

  it('falls back to the legacy output.results[].url shape', () => {
    const svc = new ImageService(makeDeps());

    const urls = svc.extractUrls({
      output: { results: [{ url: 'https://mock-api.test.qianwenai.com/c.png' }] },
    });

    expect(urls).toEqual(['https://mock-api.test.qianwenai.com/c.png']);
  });

  it('returns an empty list when the response carries no image fields', () => {
    const svc = new ImageService(makeDeps());

    expect(svc.extractUrls({ output: {} })).toEqual([]);
    expect(svc.extractUrls({})).toEqual([]);
  });

  it('skips non-string and empty image entries', () => {
    const svc = new ImageService(makeDeps());

    const urls = svc.extractUrls({
      output: {
        choices: [
          { message: { content: [{ image: '' }, { image: 42 }, { text: 'no image here' }] } },
          { message: { content: [{ image: 'https://mock-api.test.qianwenai.com/d.png' }] } },
        ],
      },
    });

    expect(urls).toEqual(['https://mock-api.test.qianwenai.com/d.png']);
  });
});

describe('ImageService.generate — synchronous download path', () => {
  const upstream = {
    request_id: 'req-99',
    output: {
      choices: [
        { message: { content: [{ image: 'https://mock-api.test.qianwenai.com/a.png' }] } },
        { message: { content: [{ image: 'https://mock-api.test.qianwenai.com/b.png' }] } },
      ],
    },
  };

  it('sends the assembled body to the client', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(makeDeps({ client: stub.client }));

    await svc.generate({ prompt: 'city' });

    const sent = stub.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.input).toEqual({
      messages: [{ role: 'user', content: [{ text: 'city' }] }],
    });
  });

  it('raises the per-request timeout past the transport 60s default and honours --timeout', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(makeDeps({ client: stub.client }));

    // qwen-image is synchronous and slow at high resolution; the request timeout
    // must be raised or the shared 60s transport default aborts before the URL.
    await svc.generate({ prompt: 'city' });
    expect(stub.generate.mock.calls[0]![2]).toBe(DEFAULT_IMAGE_TIMEOUT_MS);

    stub.generate.mockClear();
    await svc.generate({ prompt: 'city', timeoutMs: 123456 });
    expect(stub.generate.mock.calls[0]![2]).toBe(123456);
  });

  it('downloads every extracted URL and normalizes artifacts to {url, path}', async () => {
    const stub = makeClient(upstream);
    const dl = makeDownloader();
    const svc = new ImageService(makeDeps({ client: stub.client, downloader: dl.downloader }));

    const env = await svc.generate({ prompt: 'city' });

    expect(dl.download).toHaveBeenCalledTimes(2);
    expect((env.data as { images: unknown[] }).images).toEqual([
      { index: 1, url: 'https://mock-api.test.qianwenai.com/a.png', path: 'downloads/img-0.png' },
      { index: 2, url: 'https://mock-api.test.qianwenai.com/b.png', path: 'downloads/img-1.png' },
    ]);
  });

  it('threads --out through to the downloader', async () => {
    const stub = makeClient(upstream);
    const dl = makeDownloader();
    const svc = new ImageService(makeDeps({ client: stub.client, downloader: dl.downloader }));

    await svc.generate({ prompt: 'city', out: 'pics/' });

    expect(dl.download.mock.calls[0]![2]).toBe('pics/');
  });

  it('passes a png fallback extension so an extensionless --out is saved as .png', async () => {
    const stub = makeClient(upstream);
    const dl = makeDownloader();
    const svc = new ImageService(makeDeps({ client: stub.client, downloader: dl.downloader }));

    await svc.generate({ prompt: 'city', out: 'apple' });

    expect(dl.download.mock.calls[0]![3]).toBe('png');
  });

  it('exposes only the normalized images[] in data, not the raw upstream output', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(makeDeps({ client: stub.client }));

    const env = await svc.generate({ prompt: 'city' });

    expect('output' in (env.data as Record<string, unknown>)).toBe(false);
    expect('request_id' in (env.data as Record<string, unknown>)).toBe(false);
    expect(Object.keys(env.data as Record<string, unknown>)).toEqual(['images']);
  });

  it('maps the upstream request_id into meta.request_id', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(makeDeps({ client: stub.client }));

    const env = await svc.generate({ prompt: 'city' });

    expect(env.meta.request_id).toBe('req-99');
  });

  it('omits meta.request_id when the upstream has none', async () => {
    const stub = makeClient({ output: { results: [] } });
    const svc = new ImageService(makeDeps({ client: stub.client }));

    const env = await svc.generate({ prompt: 'city' });

    expect('request_id' in env.meta).toBe(false);
  });

  it('reports image_count metering in meta.usage and no token fields', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(makeDeps({ client: stub.client }));

    const env = await svc.generate({ prompt: 'city' });

    expect(env.meta.usage).toEqual({ image_count: 2 });
  });

  it('adds width/height to meta.usage when a --size is supplied', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(makeDeps({ client: stub.client }));

    const env = await svc.generate({ prompt: 'city', size: '2048*2048' });

    expect(env.meta.usage).toEqual({ image_count: 2, width: 2048, height: 2048 });
  });
});

describe('ImageService.generate — b64 and download-disabled paths', () => {
  const upstream = {
    request_id: 'req-b64',
    output: { results: [{ url: 'https://mock-api.test.qianwenai.com/a.png' }] },
  };

  it('encodes bytes locally as base64 and omits path in b64 mode', async () => {
    const stub = makeClient(upstream);
    const dl = makeDownloader();
    const svc = new ImageService(makeDeps({ client: stub.client, downloader: dl.downloader }));

    const env = await svc.generate({ prompt: 'city', responseFormat: 'b64' });

    const images = (env.data as { images: Array<Record<string, unknown>> }).images;
    expect(dl.download).not.toHaveBeenCalled();
    expect(images).toHaveLength(1);
    expect(images[0]!.index).toBe(1);
    expect(images[0]!.url).toBe('https://mock-api.test.qianwenai.com/a.png');
    expect('path' in images[0]!).toBe(false);
    expect(typeof images[0]!.b64).toBe('string');
    expect((images[0]!.b64 as string).length).toBeGreaterThan(0);
  });

  it('normalizes artifacts to {url} only and touches neither fs nor network when download is disabled', async () => {
    const stub = makeClient(upstream);
    const dl = makeDownloader();
    const svc = new ImageService(makeDeps({ client: stub.client, downloader: dl.downloader }));

    const env = await svc.generate({ prompt: 'city', download: false });

    const images = (env.data as { images: Array<Record<string, unknown>> }).images;
    expect(dl.download).not.toHaveBeenCalled();
    expect(images).toEqual([{ index: 1, url: 'https://mock-api.test.qianwenai.com/a.png' }]);
  });
});

describe('ImageService.generate — OSS resolve header propagation', () => {
  const upstream = {
    request_id: 'r-oss',
    output: {
      choices: [{ message: { content: [{ image: 'https://mock-api.test.qianwenai.com/o.png' }] } }],
    },
  };

  it('forwards the OSS resolve header to the client for an oss:// edit asset', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(
      makeDeps({
        client: stub.client,
        modelResolver: makeResolver('qwen-image-edit-plus'),
        assetPolicy: makeOssAssetPolicy('oss://qwen-uploads/20260610/src.png'),
      }),
    );

    await svc.generate({ prompt: 'edit', model: 'qwen-image-edit-plus', image: './src.png' });

    const headers = stub.generate.mock.calls[0]![1] as Record<string, string> | undefined;
    expect(headers?.['X-DashScope-OssResourceResolve']).toBe('enable');
  });

  it('omits the resolve header for pure text-to-image generation', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(makeDeps({ client: stub.client }));

    await svc.generate({ prompt: 'a city' });

    const headers = stub.generate.mock.calls[0]![1] as Record<string, string> | undefined;
    expect(headers?.['X-DashScope-OssResourceResolve']).toBeUndefined();
  });

  it('omits the resolve header for a public-URL edit asset', async () => {
    const stub = makeClient(upstream);
    const svc = new ImageService(
      makeDeps({
        client: stub.client,
        modelResolver: makeResolver('qwen-image-edit-plus'),
        assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/src.png'),
      }),
    );

    await svc.generate({ prompt: 'edit', model: 'qwen-image-edit-plus', image: './src.png' });

    const headers = stub.generate.mock.calls[0]![1] as Record<string, string> | undefined;
    expect(headers?.['X-DashScope-OssResourceResolve']).toBeUndefined();
  });
});

describe('ImageService — wan async text2image routing', () => {
  const submitted = { output: { task_id: 't-1', task_status: 'PENDING' } };
  const succeeded = {
    output: {
      task_id: 't-1',
      task_status: 'SUCCEEDED',
      results: [{ url: 'https://mock-api.test.qianwenai.com/wan.png' }],
    },
  };

  it('builds input.prompt as a string for wan async models', async () => {
    const svc = new ImageService(makeDeps({ modelResolver: makeResolver('wanx2.1-t2i-turbo') }));

    const { body, async } = await svc.buildRequest({ prompt: 'a fox', model: 'wanx2.1-t2i-turbo' });

    expect(async).toBe(true);
    expect(body.input).toEqual({ prompt: 'a fox' });
  });

  it('keeps qwen-image on the synchronous multimodal path', async () => {
    const svc = new ImageService(makeDeps({ modelResolver: makeResolver('qwen-image-2.0') }));

    const { async } = await svc.buildRequest({ prompt: 'x', model: 'qwen-image-2.0' });

    expect(async).toBe(false);
  });

  it('treats wan2.5 and below as async but wan2.6+ as sync', async () => {
    const svc = new ImageService(makeDeps({ modelResolver: makeResolver('wan2.2-t2i-plus') }));
    const older = await svc.buildRequest({ prompt: 'x', model: 'wan2.2-t2i-plus' });
    expect(older.async).toBe(true);

    const svc2 = new ImageService(makeDeps({ modelResolver: makeResolver('wan2.6-t2i') }));
    const newer = await svc2.buildRequest({ prompt: 'x', model: 'wan2.6-t2i' });
    expect(newer.async).toBe(false);
  });

  it('rejects --image for a wan async model with exit 4', async () => {
    const svc = new ImageService(makeDeps({ modelResolver: makeResolver('wanx-v1') }));

    await expect(
      svc.buildRequest({ prompt: 'x', model: 'wanx-v1', image: './src.png' }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('submits asynchronously and returns downloaded artifacts on success', async () => {
    const stub = makeClient(submitted);
    const svc = new ImageService(
      makeDeps({
        client: stub.client,
        modelResolver: makeResolver('wanx2.1-t2i-turbo'),
        taskService: makeTaskService([succeeded]).taskService,
      }),
    );

    const envelope = await svc.generate({ prompt: 'a fox', model: 'wanx2.1-t2i-turbo' });

    expect(stub.generate).not.toHaveBeenCalled();
    expect(stub.client.submit).toHaveBeenCalledTimes(1);
    const images = envelope.data.images as Array<Record<string, unknown>>;
    expect(images).toEqual([
      { index: 1, url: 'https://mock-api.test.qianwenai.com/wan.png', path: 'downloads/img-0.png' },
    ]);
    expect(envelope.meta.model).toBe('wanx2.1-t2i-turbo');
  });

  it('returns the task id with a hint when --no-wait is used', async () => {
    const stub = makeClient(submitted);
    const svc = new ImageService(
      makeDeps({
        client: stub.client,
        modelResolver: makeResolver('wanx2.1-t2i-turbo'),
        taskService: makeTaskService([]).taskService,
      }),
    );

    const envelope = await svc.generate({
      prompt: 'a fox',
      model: 'wanx2.1-t2i-turbo',
      wait: false,
    });

    expect(envelope.data.task_id).toBe('t-1');
    expect(String(envelope.data.hint)).toContain('qianwen task get t-1');
  });
});
