/**
 * Unit tests for Model3dService — tier 0/1/2/3 assembly into a native async
 * Tripo body, submission via Model3dClient, wait orchestration via TaskService,
 * optional download, and the site-availability guard on the generate path.
 *
 * Real RequestPayloadParser, LayerConflictDetector, DefaultModelResolver,
 * MappingRegistry, AssetPolicy, InvocationEnvelope, AsyncWaiter, TaskService and
 * SiteAvailabilityGuard are injected; only the network transport and download
 * boundary are substituted.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Model3dService,
  DEFAULT_MODEL3D_MODEL,
  registerModel3dMappings,
  type Model3dServiceDeps,
} from '../../src/services/model3d-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import { AssetPolicy } from '../../src/services/asset-policy.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { AsyncWaiter } from '../../src/services/async-waiter.js';
import { TaskService } from '../../src/services/task-service.js';
import { TaskClient } from '../../src/api/providers/dashscope/task-client.js';
import { Model3dClient } from '../../src/api/providers/dashscope/model3d-client.js';
import { ImageDownloader } from '../../src/services/image-downloader.js';
import { SiteAvailabilityGuard } from '../../src/services/site-availability.js';
import type { DashScopeTransport } from '../../src/api/providers/dashscope/transport.js';

function makeParser(): RequestPayloadParser {
  return new RequestPayloadParser({
    readFile: () => {
      throw new Error('unexpected readFile');
    },
    readStdin: () => {
      throw new Error('unexpected readStdin');
    },
  });
}

function makeResolver(): DefaultModelResolver {
  return new DefaultModelResolver({
    fetchMapping: async () => ({ [`model3d generate:model3d`]: DEFAULT_MODEL3D_MODEL }),
    readCache: () => null,
    writeCache: () => {},
  });
}

function makeAssetPolicy(url = 'https://mock-media.test.qianwenai.com/chair.png'): AssetPolicy {
  return new AssetPolicy({
    readFileBytes: () => Buffer.from('bytes'),
    fileExists: () => true,
    uploadTemp: async () => url,
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

function makeTaskService(responses: Array<Record<string, unknown>>): TaskService {
  const request = vi.fn();
  for (const r of responses) request.mockResolvedValueOnce(r);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  let clock = 0;
  const waiter = new AsyncWaiter({
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  });
  return new TaskService({
    client: new TaskClient({ transport }),
    waiter,
    envelope: new InvocationEnvelope(),
  });
}

function makeClient(submitResponse: Record<string, unknown>): Model3dClient {
  const request = vi.fn().mockResolvedValue(submitResponse);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return new Model3dClient({ transport });
}

function makeClientWithHeaders(submitResponse: Record<string, unknown>): {
  client: Model3dClient;
  submitHeaders: () => Record<string, string> | undefined;
} {
  const request = vi.fn().mockResolvedValue(submitResponse);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return {
    client: new Model3dClient({ transport }),
    submitHeaders: () =>
      (request.mock.calls[0]![0] as { headers?: Record<string, string> }).headers,
  };
}

function makeGuard(site = 'qianwen'): SiteAvailabilityGuard {
  return new SiteAvailabilityGuard({
    site: () => site,
    availableSites: new Set(['qianwen']),
    command: 'model3d generate',
  });
}

function makeRegistry(): MappingRegistry {
  const registry = new MappingRegistry();
  registerModel3dMappings(registry);
  return registry;
}

function makeDeps(overrides: Partial<Model3dServiceDeps> = {}): Model3dServiceDeps {
  return {
    parser: makeParser(),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: makeResolver(),
    registry: makeRegistry(),
    assetPolicy: makeAssetPolicy(),
    taskService: makeTaskService([]),
    client: makeClient({ output: { task_id: 't' } }),
    downloader: makeDownloader(),
    guard: makeGuard(),
    context: () => ({ site: 'qianwen', account: 'QIANWEN_API_KEY' }),
    ...overrides,
  };
}

describe('Model3dService.buildRequest — tier 0 / tier 1', () => {
  it('wraps a bare prompt into input.prompt with the default model', async () => {
    const svc = new Model3dService(makeDeps());

    const { model, body } = await svc.buildRequest({ prompt: '一把木质椅子' });

    expect(model).toBe(DEFAULT_MODEL3D_MODEL);
    expect(body.model).toBe(DEFAULT_MODEL3D_MODEL);
    expect(body.input).toEqual({ prompt: '一把木质椅子' });
  });

  it('honours an explicit --model over the default', async () => {
    const svc = new Model3dService(makeDeps());

    const { model } = await svc.buildRequest({ prompt: 'x', model: 'Tripo/Tripo-H3.1' });

    expect(model).toBe('Tripo/Tripo-H3.1');
  });

  it('lets a --request self-carried model win when no --model is given', async () => {
    const svc = new Model3dService(makeDeps());

    const { model } = await svc.buildRequest({
      request: '{"model":"Tripo/Tripo-H3.1","input":{"prompt":"x"}}',
    });

    expect(model).toBe('Tripo/Tripo-H3.1');
  });
});

describe('Model3dService.buildRequest — tier 2', () => {
  it('maps --image onto input.image via the asset policy', async () => {
    const svc = new Model3dService(
      makeDeps({ assetPolicy: makeAssetPolicy('https://mock-media.test.qianwenai.com/c.png') }),
    );

    const { body } = await svc.buildRequest({ image: 'chair.png' });

    expect((body.input as Record<string, unknown>).image).toBe(
      'https://mock-media.test.qianwenai.com/c.png',
    );
  });

  it('maps --texture-quality onto parameters.texture_quality', async () => {
    const svc = new Model3dService(makeDeps());

    const { body } = await svc.buildRequest({ prompt: 'x', textureQuality: 'detailed' });

    expect((body.parameters as Record<string, unknown>).texture_quality).toBe('detailed');
  });

  it('rejects an unsupported --texture-quality value', async () => {
    const svc = new Model3dService(makeDeps());

    await expect(svc.buildRequest({ prompt: 'x', textureQuality: 'ultra' })).rejects.toMatchObject({
      exitCode: 4,
    });
  });
});

describe('Model3dService.buildRequest — mutually exclusive inputs', () => {
  it('rejects combining a prompt with --image', async () => {
    const svc = new Model3dService(makeDeps());

    await expect(svc.buildRequest({ prompt: 'x', image: 'chair.png' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      exitCode: 4,
    });
  });

  it('rejects combining a prompt with request.input', async () => {
    const svc = new Model3dService(makeDeps());

    await expect(
      svc.buildRequest({ prompt: 'x', request: '{"input":{"prompt":"y"}}' }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects an empty invocation with none of prompt/image/request', async () => {
    const svc = new Model3dService(makeDeps());

    await expect(svc.buildRequest({})).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      exitCode: 4,
    });
  });
});

describe('Model3dService.extractUrls — Tripo result shape', () => {
  it('reads the GLB from results[].pbr_model_url (default PBR/textured output)', () => {
    const svc = new Model3dService(makeDeps());
    const urls = svc.extractUrls({
      output: {
        results: [{ pbr_model_url: 'https://openapi.cdn.tripo3d.com/a.glb?auth_key=x' }],
      },
    });
    expect(urls).toEqual(['https://openapi.cdn.tripo3d.com/a.glb?auth_key=x']);
  });

  it('falls back to results[].base_model_url when pbr is disabled', () => {
    const svc = new Model3dService(makeDeps());
    const urls = svc.extractUrls({
      output: {
        results: [{ base_model_url: 'https://openapi.cdn.tripo3d.com/b.glb?auth_key=x' }],
      },
    });
    expect(urls).toEqual(['https://openapi.cdn.tripo3d.com/b.glb?auth_key=x']);
  });

  it('prefers pbr_model_url over base_model_url when both are present', () => {
    const svc = new Model3dService(makeDeps());
    const urls = svc.extractUrls({
      output: {
        results: [
          {
            pbr_model_url: 'https://openapi.cdn.tripo3d.com/pbr.glb?auth_key=x',
            base_model_url: 'https://openapi.cdn.tripo3d.com/base.glb?auth_key=x',
          },
        ],
      },
    });
    expect(urls).toEqual(['https://openapi.cdn.tripo3d.com/pbr.glb?auth_key=x']);
  });

  it('does not treat rendered_image_url (preview) as a model artifact', () => {
    const svc = new Model3dService(makeDeps());
    const urls = svc.extractUrls({
      output: {
        results: [{ rendered_image_url: 'https://openapi.cdn.tripo3d.com/p.webp?auth_key=x' }],
      },
    });
    expect(urls).toEqual([]);
  });

  it('returns an empty list when the task carries no results', () => {
    const svc = new Model3dService(makeDeps());
    expect(svc.extractUrls({ output: { results: [] } })).toEqual([]);
    expect(svc.extractUrls({ output: {} })).toEqual([]);
  });
});

describe('Model3dService.extractAssets — model + preview', () => {
  it('returns the model and preview as typed assets with extensions', () => {
    const svc = new Model3dService(makeDeps());
    const assets = svc.extractAssets({
      output: {
        results: [
          {
            pbr_model_url: 'https://openapi.cdn.tripo3d.com/a.glb?auth_key=x',
            rendered_image_url: 'https://openapi.cdn.tripo3d.com/legacy_mesh.webp?auth_key=x',
          },
        ],
      },
    });
    expect(assets).toEqual([
      { url: 'https://openapi.cdn.tripo3d.com/a.glb?auth_key=x', type: 'model', ext: 'glb' },
      {
        url: 'https://openapi.cdn.tripo3d.com/legacy_mesh.webp?auth_key=x',
        type: 'preview',
        ext: 'webp',
      },
    ]);
  });

  it('omits the preview when the result carries no rendered_image_url', () => {
    const svc = new Model3dService(makeDeps());
    const assets = svc.extractAssets({
      output: { results: [{ pbr_model_url: 'https://openapi.cdn.tripo3d.com/a.glb?auth_key=x' }] },
    });
    expect(assets).toEqual([
      { url: 'https://openapi.cdn.tripo3d.com/a.glb?auth_key=x', type: 'model', ext: 'glb' },
    ]);
  });
});

describe('Model3dService.generate — site guard and async wait', () => {
  it('raises the site-not-available error before building or submitting', async () => {
    const svc = new Model3dService(makeDeps({ guard: makeGuard('other-site') }));

    await expect(svc.generate({ prompt: 'x' })).rejects.toMatchObject({ exitCode: 4 });
  });

  it('returns completed=true when the task finishes within the wait window', async () => {
    const svc = new Model3dService(
      makeDeps({
        client: makeClient({ output: { task_id: 'td-1', task_status: 'PENDING' } }),
        taskService: makeTaskService([
          {
            output: {
              task_id: 'td-1',
              task_status: 'SUCCEEDED',
              results: [{ pbr_model_url: 'https://openapi.cdn.tripo3d.com/model.glb?auth_key=x' }],
            },
          },
        ]),
      }),
    );

    const outcome = await svc.generate({ prompt: 'x' });

    expect(outcome.completed).toBe(true);
  });

  it('downloads the Tripo GLB and preview, recording both artifacts with a type', async () => {
    const record = { downloaded: [] as string[] };
    const svc = new Model3dService(
      makeDeps({
        client: makeClient({ output: { task_id: 'td-3', task_status: 'PENDING' } }),
        taskService: makeTaskService([
          {
            output: {
              task_id: 'td-3',
              task_status: 'SUCCEEDED',
              results: [
                {
                  pbr_model_url: 'https://openapi.cdn.tripo3d.com/robot.glb?auth_key=x',
                  rendered_image_url: 'https://openapi.cdn.tripo3d.com/robot.webp?auth_key=x',
                },
              ],
            },
          },
        ]),
        downloader: makeDownloader(record),
      }),
    );

    const outcome = await svc.generate({ prompt: 'a cartoon robot' });

    expect(outcome.completed).toBe(true);
    expect(record.downloaded).toHaveLength(2);
    expect(record.downloaded[0]).toMatch(/\.glb$/);
    expect(record.downloaded[1]).toMatch(/\.webp$/);
    const files = (outcome.envelope.data as Record<string, unknown>).files as Array<
      Record<string, unknown>
    >;
    expect(files[0]).toMatchObject({
      type: 'model',
      url: 'https://openapi.cdn.tripo3d.com/robot.glb?auth_key=x',
    });
    expect(files[1]).toMatchObject({
      type: 'preview',
      url: 'https://openapi.cdn.tripo3d.com/robot.webp?auth_key=x',
    });
  });

  it('throws the upstream reason when the task reaches a FAILED terminal state', async () => {
    const svc = new Model3dService(
      makeDeps({
        client: makeClient({ output: { task_id: 'td-2', task_status: 'PENDING' } }),
        taskService: makeTaskService([
          {
            output: {
              task_id: 'td-2',
              task_status: 'FAILED',
              code: 'InternalError',
              message: 'mesh generation failed',
            },
          },
        ]),
      }),
    );

    await expect(svc.generate({ prompt: 'x' })).rejects.toThrowError(/mesh generation failed/);
  });

  it('surfaces the submitted task id immediately on no-wait', async () => {
    const svc = new Model3dService(
      makeDeps({ client: makeClient({ output: { task_id: 'td-9', task_status: 'PENDING' } }) }),
    );

    const outcome = await svc.generate({ prompt: 'x', wait: false });

    expect((outcome.envelope.data as Record<string, unknown>).task_id).toBe('td-9');
  });
});

describe('Model3dService.generate — OSS resolve header propagation', () => {
  it('forwards the OSS resolve header (alongside the async header) for an oss:// reference image', async () => {
    const stub = makeClientWithHeaders({ output: { task_id: 'm-oss' } });
    const svc = new Model3dService(makeDeps({ client: stub.client }));

    await svc.generate({ image: 'oss://qwen-uploads/20260610/chair.png', wait: false });

    const headers = stub.submitHeaders();
    expect(headers?.['X-DashScope-OssResourceResolve']).toBe('enable');
    expect(headers?.['X-DashScope-Async']).toBe('enable');
  });

  it('omits the resolve header when no reference image is provided', async () => {
    const stub = makeClientWithHeaders({ output: { task_id: 'm-txt' } });
    const svc = new Model3dService(makeDeps({ client: stub.client }));

    await svc.generate({ prompt: 'a chair', wait: false });

    const headers = stub.submitHeaders();
    expect(headers?.['X-DashScope-OssResourceResolve']).toBeUndefined();
    expect(headers?.['X-DashScope-Async']).toBe('enable');
  });
});
