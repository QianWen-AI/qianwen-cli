/**
 * Unit tests for ASRService — tier 0/1/2/3 assembly into a native async body,
 * submission via ASRClient, and wait orchestration via TaskService.
 *
 * Real RequestPayloadParser, LayerConflictDetector, DefaultModelResolver,
 * MappingRegistry, InvocationEnvelope, AsyncWaiter and TaskService are injected;
 * only the network transport and the asset-resolution upload boundary are
 * substituted.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ASRService,
  DEFAULT_ASR_MODEL,
  type ASRServiceDeps,
} from '../../src/services/asr-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import { AssetPolicy } from '../../src/services/asset-policy.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { AsyncWaiter } from '../../src/services/async-waiter.js';
import { TaskService } from '../../src/services/task-service.js';
import { TaskClient } from '../../src/api/providers/dashscope/task-client.js';
import { ASRClient } from '../../src/api/providers/dashscope/asr-client.js';
import type { DashScopeTransport } from '../../src/api/providers/dashscope/transport.js';
import { TranscriptFetcher } from '../../src/services/transcript.js';

function makeTranscriptFetcher(text?: string): TranscriptFetcher {
  return new TranscriptFetcher({
    fetchText: async () => {
      if (text === undefined) throw new Error('no transcript');
      return JSON.stringify({ transcripts: [{ text }] });
    },
  });
}

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
    fetchMapping: async () => ({ [`audio transcribe:asr`]: DEFAULT_ASR_MODEL }),
    readCache: () => null,
    writeCache: () => {},
  });
}

function makeAssetPolicy(
  resolvedUrl = 'https://mock-media.test.qianwenai.com/uploaded.wav',
): AssetPolicy {
  return new AssetPolicy({
    readFileBytes: () => Buffer.from('bytes'),
    fileExists: () => true,
    uploadTemp: async () => resolvedUrl,
    readCache: () => null,
    writeCache: () => {},
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

function makeASRClient(submitResponse: Record<string, unknown>): {
  client: ASRClient;
  submitBody: () => Record<string, unknown>;
} {
  const request = vi.fn().mockResolvedValue(submitResponse);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return {
    client: new ASRClient({ transport }),
    submitBody: () => (request.mock.calls[0]![0] as { body: Record<string, unknown> }).body,
  };
}

function makeSyncASRClient(response: Record<string, unknown>): {
  client: ASRClient;
  requestBody: () => Record<string, unknown>;
} {
  const request = vi.fn().mockResolvedValue(response);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return {
    client: new ASRClient({ transport }),
    requestBody: () => (request.mock.calls[0]![0] as { body: Record<string, unknown> }).body,
  };
}

function makeASRClientWithHeaders(submitResponse: Record<string, unknown>): {
  client: ASRClient;
  submitHeaders: () => Record<string, string> | undefined;
} {
  const request = vi.fn().mockResolvedValue(submitResponse);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return {
    client: new ASRClient({ transport }),
    submitHeaders: () =>
      (request.mock.calls[0]![0] as { headers?: Record<string, string> }).headers,
  };
}

function makeDeps(overrides: Partial<ASRServiceDeps> = {}): ASRServiceDeps {
  return {
    parser: makeParser(),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: makeResolver(),
    registry: new MappingRegistry(),
    assetPolicy: makeAssetPolicy(),
    taskService: makeTaskService([]).taskService,
    client: makeASRClient({ output: { task_id: 't' } }).client,
    envelope: new InvocationEnvelope(),
    context: () => ({ site: 'qianwen', account: 'QIANWEN_API_KEY' }),
    transcriptFetcher: makeTranscriptFetcher(),
    ...overrides,
  };
}

describe('ASRService.buildRequest — tier 0 / tier 1', () => {
  it('resolves a local audio file into Qwen messages with the default model', async () => {
    const service = new ASRService(
      makeDeps({
        assetPolicy: makeAssetPolicy('https://mock-media.test.qianwenai.com/meeting.wav'),
      }),
    );
    const { model, body } = await service.buildRequest({ source: 'meeting.mp3' });

    expect(model).toBe(DEFAULT_ASR_MODEL);
    expect(body.model).toBe(DEFAULT_ASR_MODEL);
    expect(body.input).toEqual({
      messages: [
        {
          role: 'user',
          content: [{ audio: 'https://mock-media.test.qianwenai.com/meeting.wav' }],
        },
      ],
    });
    expect(body.parameters).toEqual({ format: 'mp3' });
  });

  it('passes a remote http URL straight through into Qwen messages', async () => {
    const service = new ASRService(makeDeps());
    const { body } = await service.buildRequest({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
    });
    expect(body.input).toEqual({
      messages: [
        { role: 'user', content: [{ audio: 'https://mock-media.test.qianwenai.com/a.wav' }] },
      ],
    });
    expect(body.parameters).toEqual({ format: 'wav' });
  });

  it('honors an explicit fun --model and builds file_urls', async () => {
    const service = new ASRService(makeDeps());
    const { model, body } = await service.buildRequest({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
    });
    expect(model).toBe('fun-asr');
    expect(body.model).toBe('fun-asr');
    expect(body.input).toEqual({ file_urls: ['https://mock-media.test.qianwenai.com/a.wav'] });
  });
});

describe('ASRService.buildRequest — tier 2 --language', () => {
  it('builds parameters.asr_options.language for the Qwen default', async () => {
    const service = new ASRService(makeDeps());
    const { body } = await service.buildRequest({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      language: 'zh',
    });
    expect(body.parameters).toEqual({ asr_options: { language: 'zh' }, format: 'wav' });
  });

  it('builds parameters.language_hints for the fun family', async () => {
    const service = new ASRService(makeDeps());
    const { body } = await service.buildRequest({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
      language: 'zh',
    });
    expect(body.parameters).toEqual({ language_hints: ['zh'] });
  });
});

describe('ASRService.buildRequest — tier 3 passthrough and errors', () => {
  it('passes a native --request body through and defaults empty parameters', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({
      model: 'fun-asr',
      input: { file_urls: ['https://mock-media.test.qianwenai.com/x.wav'] },
    });
    const { model, body } = await service.buildRequest({ request: raw });

    expect(model).toBe('fun-asr');
    expect(body.input).toEqual({ file_urls: ['https://mock-media.test.qianwenai.com/x.wav'] });
    expect(body.parameters).toEqual({});
  });

  it('preserves native parameters passed via --request', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({
      model: 'fun-asr',
      input: { file_urls: ['https://mock-media.test.qianwenai.com/x.wav'] },
      parameters: { channel_id: [0], diarization_enabled: true, speaker_count: 2 },
    });
    const { body } = await service.buildRequest({ request: raw });
    expect(body.parameters).toEqual({
      channel_id: [0],
      diarization_enabled: true,
      speaker_count: 2,
    });
  });

  it('infers parameters.format from the audio URL inside a Qwen --request body', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({
      model: DEFAULT_ASR_MODEL,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ audio: 'https://mock-media.test.qianwenai.com/meeting.mp3' }],
          },
        ],
      },
      parameters: {},
    });
    const { body } = await service.buildRequest({ request: raw });
    expect(body.parameters).toEqual({ format: 'mp3' });
  });

  it('keeps an explicit parameters.format in a Qwen --request body', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({
      model: DEFAULT_ASR_MODEL,
      input: {
        messages: [
          { role: 'user', content: [{ audio: 'https://mock-media.test.qianwenai.com/a.wav' }] },
        ],
      },
      parameters: { format: 'mp3' },
    });
    const { body } = await service.buildRequest({ request: raw });
    expect(body.parameters).toEqual({ format: 'mp3' });
  });

  it('does not inject format when a Qwen --request body carries no audio URL', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({
      model: DEFAULT_ASR_MODEL,
      input: { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
    });
    const { body } = await service.buildRequest({ request: raw });
    expect(body.parameters).toEqual({});
  });

  it('lets --model override the model inside a --request body', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({ model: 'fun-asr', input: { file_urls: ['u'] } });
    const { model, body } = await service.buildRequest({ request: raw, model: 'fun-asr-8k' });
    expect(model).toBe('fun-asr-8k');
    expect(body.model).toBe('fun-asr-8k');
  });

  it('rejects a source combined with request.input (exit 4)', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({ input: { file_urls: ['u'] } });
    await expect(
      service.buildRequest({ source: 'meeting.mp3', request: raw }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects when neither source nor --request is provided (exit 4)', async () => {
    const service = new ASRService(makeDeps());
    await expect(service.buildRequest({})).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects --language when a Qwen request already sets parameters.asr_options.language (exit 4)', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({ parameters: { asr_options: { language: 'en' } } });
    await expect(
      service.buildRequest({
        source: 'https://mock-media.test.qianwenai.com/a.wav',
        language: 'zh',
        request: raw,
      }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects --language when a fun request already sets parameters.language_hints (exit 4)', async () => {
    const service = new ASRService(makeDeps());
    const raw = JSON.stringify({ model: 'fun-asr', parameters: { language_hints: ['en'] } });
    await expect(
      service.buildRequest({
        source: 'https://mock-media.test.qianwenai.com/a.wav',
        language: 'zh',
        request: raw,
      }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe('ASRService.generate — async submit + wait', () => {
  it('submits, waits to succeeded, and returns the normalized envelope', async () => {
    const submit = { output: { task_id: 'at-1', task_status: 'PENDING' } };
    const succeeded = {
      request_id: 'q-1',
      output: {
        task_id: 'at-1',
        task_status: 'SUCCEEDED',
        results: [{ url: 'https://mock-media.test.qianwenai.com/result.json' }],
      },
    };
    const service = new ASRService(
      makeDeps({
        client: makeASRClient(submit).client,
        taskService: makeTaskService([succeeded]).taskService,
      }),
    );

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
    });

    expect(outcome.completed).toBe(true);
    expect(outcome.envelope.data.task_status).toBe('SUCCEEDED');
    expect(outcome.envelope.data.urls).toEqual([
      'https://mock-media.test.qianwenai.com/result.json',
    ]);
  });

  it('attaches the full transcript when it is within the character limit', async () => {
    const submit = { output: { task_id: 'at-1', task_status: 'PENDING' } };
    const succeeded = {
      output: {
        task_id: 'at-1',
        task_status: 'SUCCEEDED',
        results: [{ url: 'https://mock-media.test.qianwenai.com/result.json' }],
      },
    };
    const service = new ASRService(
      makeDeps({
        client: makeASRClient(submit).client,
        taskService: makeTaskService([succeeded]).taskService,
        transcriptFetcher: makeTranscriptFetcher('你好，世界'),
      }),
    );

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
    });

    expect(outcome.envelope.data.text).toBe('你好，世界');
    expect(outcome.envelope.data.text_truncated).toBe(false);
    expect(outcome.envelope.data.transcription_url).toBe(
      'https://mock-media.test.qianwenai.com/result.json',
    );
  });

  it('truncates the transcript to 200 characters and flags it', async () => {
    const long = '字'.repeat(250);
    const submit = { output: { task_id: 'at-1', task_status: 'PENDING' } };
    const succeeded = {
      output: {
        task_id: 'at-1',
        task_status: 'SUCCEEDED',
        results: [{ url: 'https://mock-media.test.qianwenai.com/result.json' }],
      },
    };
    const service = new ASRService(
      makeDeps({
        client: makeASRClient(submit).client,
        taskService: makeTaskService([succeeded]).taskService,
        transcriptFetcher: makeTranscriptFetcher(long),
      }),
    );

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
    });

    expect([...(outcome.envelope.data.text as string)]).toHaveLength(200);
    expect(outcome.envelope.data.text_truncated).toBe(true);
    expect(outcome.envelope.data.text_limit).toBe(200);
  });

  it('falls back to the URL alone when the result fetch fails', async () => {
    const submit = { output: { task_id: 'at-1', task_status: 'PENDING' } };
    const succeeded = {
      output: {
        task_id: 'at-1',
        task_status: 'SUCCEEDED',
        results: [{ url: 'https://mock-media.test.qianwenai.com/result.json' }],
      },
    };
    const service = new ASRService(
      makeDeps({
        client: makeASRClient(submit).client,
        taskService: makeTaskService([succeeded]).taskService,
        transcriptFetcher: makeTranscriptFetcher(),
      }),
    );

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
    });

    expect(outcome.envelope.data.text).toBeUndefined();
    expect(outcome.envelope.data.urls).toEqual([
      'https://mock-media.test.qianwenai.com/result.json',
    ]);
  });

  it('throws the upstream reason when the task reaches a FAILED terminal state', async () => {
    const submit = { output: { task_id: 'at-2', task_status: 'PENDING' } };
    const failed = {
      request_id: 'q-2',
      output: {
        task_id: 'at-2',
        task_status: 'FAILED',
        code: 'InvalidParameter',
        message: 'unsupported audio codec',
      },
    };
    const service = new ASRService(
      makeDeps({
        client: makeASRClient(submit).client,
        taskService: makeTaskService([failed]).taskService,
      }),
    );

    await expect(
      service.generate({ source: 'https://mock-media.test.qianwenai.com/a.wav', model: 'fun-asr' }),
    ).rejects.toThrowError(/unsupported audio codec/);
  });

  it('returns the submission task id immediately when wait is disabled', async () => {
    const submit = { output: { task_id: 'at-2', task_status: 'PENDING' } };
    const { taskService, request } = makeTaskService([]);
    const service = new ASRService(makeDeps({ client: makeASRClient(submit).client, taskService }));

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
      wait: false,
    });

    expect(outcome.completed).toBe(false);
    expect(outcome.envelope.data.task_id).toBe('at-2');
    expect(outcome.envelope.data.task_status).toBe('PENDING');
    expect(request).not.toHaveBeenCalled();
  });

  it('reports completed=false with a follow-up hint on timeout', async () => {
    const submit = { output: { task_id: 'at-3', task_status: 'PENDING' } };
    const pending = { output: { task_id: 'at-3', task_status: 'RUNNING' } };
    const service = new ASRService(
      makeDeps({
        client: makeASRClient(submit).client,
        taskService: makeTaskService([pending, pending, pending]).taskService,
      }),
    );

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
      wait: true,
      timeoutMs: 1000,
      pollIntervalMs: 2000,
    });

    expect(outcome.completed).toBe(false);
    expect(outcome.envelope.data.task_id).toBe('at-3');
    expect(String(outcome.envelope.data.hint)).toContain('task get');
    expect(outcome.envelope.data.hint).toContain('at-3');
  });
});

describe('ASRService.generate — OSS resolve header propagation', () => {
  it('forwards the OSS resolve header (alongside the async header) for an oss:// audio source', async () => {
    const stub = makeASRClientWithHeaders({ output: { task_id: 'a-oss' } });
    const service = new ASRService(makeDeps({ client: stub.client }));

    await service.generate({
      source: 'oss://qwen-uploads/20260610/meeting.wav',
      model: 'fun-asr',
      wait: false,
    });

    const headers = stub.submitHeaders();
    expect(headers?.['X-DashScope-OssResourceResolve']).toBe('enable');
    expect(headers?.['X-DashScope-Async']).toBe('enable');
  });

  it('omits the resolve header for a public-URL audio source', async () => {
    const stub = makeASRClientWithHeaders({ output: { task_id: 'a-url' } });
    const service = new ASRService(makeDeps({ client: stub.client }));

    await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      model: 'fun-asr',
      wait: false,
    });

    const headers = stub.submitHeaders();
    expect(headers?.['X-DashScope-OssResourceResolve']).toBeUndefined();
    expect(headers?.['X-DashScope-Async']).toBe('enable');
  });
});

describe('ASRService.generate — Qwen synchronous recognition', () => {
  const succeeded = {
    request_id: 'q-sync',
    output: {
      sentence: {
        begin_time: 600,
        channel_id: 0,
        end_time: 3760,
        sentence_end: true,
        sentence_id: 1,
        language: 'zh',
        emotion: 'neutral',
        text: 'hello world，这里是阿里巴巴语音实验室。',
      },
      text: 'hello world，这里是阿里巴巴语音实验室。',
    },
    usage: { duration: 4 },
  };

  it('calls the sync generate boundary and returns the transcript text', async () => {
    const stub = makeSyncASRClient(succeeded);
    const service = new ASRService(makeDeps({ client: stub.client }));

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
    });

    expect(outcome.completed).toBe(true);
    expect(outcome.envelope.meta.model).toBe(DEFAULT_ASR_MODEL);
    expect(outcome.envelope.data.text).toBe('hello world，这里是阿里巴巴语音实验室。');
    expect(outcome.envelope.data.language).toBe('zh');
    expect(outcome.envelope.data.emotion).toBe('neutral');
    expect(stub.requestBody().input).toEqual({
      messages: [
        { role: 'user', content: [{ audio: 'https://mock-media.test.qianwenai.com/a.wav' }] },
      ],
    });
    expect(stub.requestBody().parameters).toEqual({ format: 'wav' });
  });

  it('reads the transcript from an OpenAI-compatible choices message', async () => {
    const stub = makeSyncASRClient({
      request_id: 'q-oai',
      output: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              annotations: [{ language: 'en', type: 'audio_info', emotion: 'happy' }],
              content: [{ text: 'hello world' }],
            },
          },
        ],
      },
    });
    const service = new ASRService(makeDeps({ client: stub.client }));

    const outcome = await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.mp3',
    });

    expect(outcome.envelope.data.text).toBe('hello world');
    expect(outcome.envelope.data.language).toBe('en');
    expect(outcome.envelope.data.emotion).toBe('happy');
  });

  it('passes --language and inferred format through parameters', async () => {
    const stub = makeSyncASRClient(succeeded);
    const service = new ASRService(makeDeps({ client: stub.client }));

    await service.generate({
      source: 'https://mock-media.test.qianwenai.com/a.wav',
      language: 'zh',
    });

    expect(stub.requestBody().parameters).toEqual({
      asr_options: { language: 'zh' },
      format: 'wav',
    });
  });
});
