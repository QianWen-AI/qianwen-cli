import { describe, expect, it, vi } from 'vitest';
import { ASRService } from '../../src/services/asr-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { AsyncWaiter } from '../../src/services/async-waiter.js';
import { TaskService } from '../../src/services/task-service.js';
import { TaskClient } from '../../src/api/providers/dashscope/task-client.js';
import { ASRClient } from '../../src/api/providers/dashscope/asr-client.js';
import type { DashScopeTransport } from '../../src/api/providers/dashscope/transport.js';
import { AssetPolicy } from '../../src/services/asset-policy.js';
import { TranscriptFetcher } from '../../src/services/transcript.js';

function scenario() {
  const request = vi.fn().mockResolvedValue({ output: { task_id: 'fixture-task', text: 'hello' } });
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  const envelope = new InvocationEnvelope();
  const service = new ASRService({
    parser: new RequestPayloadParser({
      readFile: () => {
        throw new Error('unexpected file read');
      },
      readStdin: () => {
        throw new Error('unexpected stdin read');
      },
    }),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: new DefaultModelResolver({
      fetchMapping: async () => ({}),
      readCache: () => null,
      writeCache: () => {},
    }),
    registry: new MappingRegistry(),
    assetPolicy: new AssetPolicy({
      readFileBytes: () => {
        throw new Error('unexpected file read');
      },
      fileExists: () => false,
      uploadTemp: async () => {
        throw new Error('unexpected upload');
      },
      readCache: () => null,
      writeCache: () => {},
    }),
    transcriptFetcher: new TranscriptFetcher({
      fetchText: async () => {
        throw new Error('unexpected transcript request');
      },
    }),
    client: new ASRClient({ transport }),
    taskService: new TaskService({
      client: new TaskClient({ transport }),
      waiter: new AsyncWaiter({ now: () => 0, sleep: async () => {} }),
      envelope,
    }),
    envelope,
    context: () => ({ site: 'qianwen', account: 'fixture' }),
  });
  return { service, request };
}

const audio = 'https://mock-media.test.qianwenai.com/audio.wav';
const syncBody = {
  model: 'qwen3-asr-flash',
  input: { messages: [{ role: 'user', content: [{ audio }] }] },
  parameters: { asr_options: { language: 'en' }, format: 'wav' },
};
const asyncBody = {
  model: 'qwen-audio-3.1-asr-flash-filetrans',
  input: { file_urls: [audio] },
  parameters: { language_hints: ['en'] },
};

describe('raw ASR model protocol overrides', () => {
  it.each([
    { original: syncBody.model, model: asyncBody.model, input: asyncBody.input },
    { original: asyncBody.model, model: syncBody.model, input: syncBody.input },
  ])('reconstructs source input across protocols: $model', async ({ original, model, input }) => {
    const { service, request } = scenario();
    const built = await service.buildRequest({
      source: audio,
      request: JSON.stringify({ model: original }),
      model,
    });
    expect(built.body.model).toBe(model);
    expect(built.body.input).toEqual(input);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { body: syncBody, model: 'qwen-audio-3.1-asr-flash-filetrans' },
    { body: asyncBody, model: 'qwen3-asr-flash' },
    { body: { model: syncBody.model }, model: asyncBody.model },
    { body: { model: asyncBody.model }, model: syncBody.model },
  ])('rejects incompatible raw input before sending: $model', async ({ body, model }) => {
    const { service, request } = scenario();
    await expect(
      service.generate({ request: JSON.stringify(body), model, wait: false }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      exitCode: 4,
      message: expect.stringMatching(/--request|--model/),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { body: syncBody, model: 'qwen-audio-3.0-asr-flash' },
    { body: asyncBody, model: 'fun-asr' },
  ])('preserves native input for same-protocol override: $model', async ({ body, model }) => {
    const { service, request } = scenario();
    const built = await service.buildRequest({ request: JSON.stringify(body), model });
    expect(built.body).toEqual({ ...body, model });
    expect(request).not.toHaveBeenCalled();
  });
});
