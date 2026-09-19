/**
 * Unit tests for TaskService — single-query normalization for `task get`, and
 * the reusable waitForTask orchestration consumed by async modality commands.
 *
 * Real InvocationEnvelope and AsyncWaiter (with a virtual clock) are injected;
 * only the TaskClient (HTTP) is substituted.
 */
import { describe, it, expect, vi } from 'vitest';
import { TaskService, type TaskServiceDeps } from '../../src/services/task-service.js';
import { AsyncWaiter } from '../../src/services/async-waiter.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { TaskClient } from '../../src/api/providers/dashscope/task-client.js';
import type { DashScopeTransport } from '../../src/api/providers/dashscope/transport.js';
import { TranscriptFetcher } from '../../src/services/transcript.js';

function transcriptFetcher(text?: string): TranscriptFetcher {
  return new TranscriptFetcher({
    fetchText: async () => {
      if (text === undefined) throw new Error('no transcript');
      return JSON.stringify({ transcripts: [{ text }] });
    },
  });
}

function realClient(responses: Array<Record<string, unknown>>): {
  client: TaskClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  for (const r of responses) request.mockResolvedValueOnce(r);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return { client: new TaskClient({ transport }), request };
}

function makeWaiter(): AsyncWaiter {
  let clock = 0;
  return new AsyncWaiter({
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  });
}

function makeDeps(overrides: Partial<TaskServiceDeps> = {}): TaskServiceDeps {
  return {
    client: realClient([{ output: {} }]).client,
    waiter: makeWaiter(),
    envelope: new InvocationEnvelope(),
    ...overrides,
  };
}

describe('TaskService.get', () => {
  it('queries the client once and normalizes the status into data', async () => {
    const { client, request } = realClient([
      {
        request_id: 'q-1',
        output: {
          task_id: 'abc',
          task_status: 'SUCCEEDED',
          results: [{ url: 'https://mock-api.test.qianwenai.com/out.mp4' }],
        },
      },
    ]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('abc');

    expect(request).toHaveBeenCalledTimes(1);
    expect((env.data as { task_status: string }).task_status).toBe('SUCCEEDED');
    expect((env.data as { type: string }).type).toBe('video');
    expect((env.data as { video_url: string }).video_url).toBe(
      'https://mock-api.test.qianwenai.com/out.mp4',
    );
    expect('urls' in env.data).toBe(false);
  });

  it('exposes only the normalized PRD fields, dropping the raw upstream output', async () => {
    const upstream = {
      request_id: 'q-2',
      output: { task_id: 'abc', task_status: 'RUNNING', extra: 'keep-me' },
    };
    const { client } = realClient([upstream]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('abc');

    expect('output' in env.data).toBe(false);
    expect('request_id' in env.data).toBe(false);
    expect(env.data).toEqual({ task_id: 'abc', task_status: 'RUNNING' });
  });

  it('normalizes a Fun-ASR transcription result URL and infers its task type', async () => {
    const transcriptionUrl = 'https://mock-api.test.qianwenai.com/transcription.json';
    const { client } = realClient([
      {
        output: {
          task_id: 'asr-1',
          task_status: 'SUCCEEDED',
          results: [{ transcription_url: transcriptionUrl }],
        },
      },
    ]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('asr-1');

    expect(env.data.type).toBe('transcription');
    expect(env.data.transcription_url).toBe(transcriptionUrl);
    expect('urls' in env.data).toBe(false);
  });

  it('attaches a truncated transcript preview for a succeeded transcription', async () => {
    const transcriptionUrl = 'https://mock-api.test.qianwenai.com/transcription.json';
    const { client } = realClient([
      {
        output: {
          task_id: 'asr-2',
          task_status: 'SUCCEEDED',
          results: [{ transcription_url: transcriptionUrl }],
        },
      },
    ]);
    const svc = new TaskService(
      makeDeps({ client, transcriptFetcher: transcriptFetcher('字'.repeat(250)) }),
    );

    const env = await svc.get('asr-2');

    expect([...(env.data.text as string)]).toHaveLength(200);
    expect(env.data.text_truncated).toBe(true);
    expect(env.data.text_limit).toBe(200);
  });

  it('leaves non-transcription tasks untouched by the transcript fetcher', async () => {
    const { client } = realClient([
      {
        output: {
          task_id: 'v-9',
          task_status: 'SUCCEEDED',
          results: [{ url: 'https://mock-api.test.qianwenai.com/out.mp4' }],
        },
      },
    ]);
    const svc = new TaskService(
      makeDeps({ client, transcriptFetcher: transcriptFetcher('should not be used') }),
    );

    const env = await svc.get('v-9');

    expect(env.data.text).toBeUndefined();
  });

  it('maps the query request_id into meta.request_id', async () => {
    const { client } = realClient([{ request_id: 'q-3', output: { task_status: 'PENDING' } }]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('abc');

    expect(env.meta.request_id).toBe('q-3');
  });

  it('omits meta.request_id when the query has none', async () => {
    const { client } = realClient([{ output: { task_status: 'PENDING' } }]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('abc');

    expect('request_id' in env.meta).toBe(false);
  });

  it('never reports token usage for task queries', async () => {
    const { client } = realClient([{ request_id: 'q', output: { task_status: 'PENDING' } }]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('abc');

    expect('usage' in env.meta).toBe(false);
  });

  it('lifts output.usage (product metering) into meta.usage when present', async () => {
    const { client } = realClient([
      {
        output: {
          task_id: 'v-1',
          task_status: 'SUCCEEDED',
          results: [{ url: 'https://mock-api.test.qianwenai.com/out.mp4' }],
          usage: { output_video_duration: 10, ratio: '16:9', SR: 720, video_count: 1 },
        },
      },
    ]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('v-1');

    expect(env.meta.usage).toEqual({
      output_video_duration: 10,
      ratio: '16:9',
      SR: 720,
      video_count: 1,
    });
  });

  it('omits meta.usage when output.usage is absent or empty', async () => {
    const { client } = realClient([
      { output: { task_id: 'v-2', task_status: 'SUCCEEDED', usage: {} } },
    ]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('v-2');

    expect('usage' in env.meta).toBe(false);
  });

  it('rejects an empty task id with exit 4 without querying', async () => {
    const { client, request } = realClient([{ output: {} }]);
    const svc = new TaskService(makeDeps({ client }));

    await expect(svc.get('   ')).rejects.toMatchObject({ exitCode: 4 });
    expect(request).not.toHaveBeenCalled();
  });

  it('downloads model3d assets and attaches them for a succeeded task', async () => {
    const { client } = realClient([
      {
        output: {
          task_id: 'm-1',
          task_status: 'SUCCEEDED',
          results: [
            {
              pbr_model_url: 'https://mock-api.test.qianwenai.com/model.glb?auth=1',
              rendered_image_url: 'https://mock-api.test.qianwenai.com/preview.webp?auth=2',
            },
          ],
        },
      },
    ]);
    const download = vi.fn(async (data: Record<string, unknown>, out?: string) => [
      {
        type: 'model',
        url: 'https://mock-api.test.qianwenai.com/model.glb?auth=1',
        path: `${out ?? '.'}/model.glb`,
      },
      {
        type: 'preview',
        url: 'https://mock-api.test.qianwenai.com/preview.webp?auth=2',
        path: `${out ?? '.'}/preview.webp`,
      },
    ]);
    const svc = new TaskService(
      makeDeps({
        client,
        assetDownloader: { supports: (t) => t === 'model3d', download },
      }),
    );

    const env = await svc.get('m-1', 'out');

    expect(download).toHaveBeenCalledTimes(1);
    expect(env.data.type).toBe('model3d');
    expect(env.data.files).toEqual([
      {
        type: 'model',
        url: 'https://mock-api.test.qianwenai.com/model.glb?auth=1',
        path: 'out/model.glb',
      },
      {
        type: 'preview',
        url: 'https://mock-api.test.qianwenai.com/preview.webp?auth=2',
        path: 'out/preview.webp',
      },
    ]);
    expect('artifacts' in env.data).toBe(false);
    expect('urls' in env.data).toBe(false);
  });

  it('skips the asset downloader for unsupported task types', async () => {
    const { client } = realClient([
      {
        output: {
          task_id: 'v-1',
          task_status: 'SUCCEEDED',
          results: [{ url: 'https://mock-api.test.qianwenai.com/out.mp4' }],
        },
      },
    ]);
    const download = vi.fn();
    const svc = new TaskService(
      makeDeps({
        client,
        assetDownloader: { supports: (t) => t === 'model3d', download },
      }),
    );

    const env = await svc.get('v-1');

    expect(download).not.toHaveBeenCalled();
    expect('artifacts' in env.data).toBe(false);
  });
});

describe('TaskService.waitForTask', () => {
  const submitted = {
    request_id: 's-1',
    output: { task_id: 'job-1', task_status: 'PENDING' },
  };

  it('returns immediately from the submit payload when wait is false', async () => {
    const { client, request } = realClient([]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.waitForTask(submitted, {
      wait: false,
      timeoutMs: 900_000,
      pollIntervalMs: 2000,
    });

    expect(request).not.toHaveBeenCalled();
    expect((env.data as { task_id: string }).task_id).toBe('job-1');
    expect((env.data as { task_status: string }).task_status).toBe('PENDING');
  });

  it('polls until the task succeeds and normalizes the terminal response', async () => {
    const { client, request } = realClient([
      { output: { task_id: 'job-1', task_status: 'RUNNING' } },
      {
        output: {
          task_id: 'job-1',
          task_status: 'SUCCEEDED',
          results: [{ url: 'https://mock-api.test.qianwenai.com/done.mp4' }],
        },
      },
    ]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.waitForTask(submitted, {
      wait: true,
      timeoutMs: 60_000,
      pollIntervalMs: 2000,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect((env.data as { task_status: string }).task_status).toBe('SUCCEEDED');
    expect((env.data as { urls: string[] }).urls).toEqual([
      'https://mock-api.test.qianwenai.com/done.mp4',
    ]);
  });

  it('stops on a failed terminal state and normalizes it as failed', async () => {
    const { client } = realClient([{ output: { task_id: 'job-1', task_status: 'FAILED' } }]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.waitForTask(submitted, {
      wait: true,
      timeoutMs: 60_000,
      pollIntervalMs: 2000,
    });

    expect((env.data as { task_status: string }).task_status).toBe('FAILED');
  });

  it('returns the last running state without throwing when the wait times out', async () => {
    const running = { output: { task_id: 'job-1', task_status: 'RUNNING' } };
    const { client } = realClient([running, running, running, running, running]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.waitForTask(submitted, {
      wait: true,
      timeoutMs: 5000,
      pollIntervalMs: 2000,
    });

    expect((env.data as { task_status: string }).task_status).toBe('RUNNING');
    expect((env.data as { task_id: string }).task_id).toBe('job-1');
  });
});

describe('TaskService failure surfacing', () => {
  it('lifts output.code / output.message onto data for a failed task', async () => {
    const { client } = realClient([
      {
        output: {
          task_id: 'job-1',
          task_status: 'FAILED',
          code: 'InternalError.Timeout',
          message: 'The model timed out.',
        },
      },
    ]);
    const svc = new TaskService(makeDeps({ client }));

    const env = await svc.get('job-1');

    expect((env.data as { code: string }).code).toBe('InternalError.Timeout');
    expect((env.data as { message: string }).message).toBe('The model timed out.');
  });

  it('assertNotFailed throws the upstream reason for a FAILED envelope', async () => {
    const { client } = realClient([
      {
        output: {
          task_id: 'job-1',
          task_status: 'FAILED',
          code: 'InvalidParameter',
          message: 'ratio not supported',
        },
      },
    ]);
    const svc = new TaskService(makeDeps({ client }));
    const env = await svc.get('job-1');

    expect(() => svc.assertNotFailed(env)).toThrowError(/ratio not supported/);
  });

  it('assertNotFailed falls back to a generic reason when none is reported', async () => {
    const { client } = realClient([{ output: { task_id: 'job-1', task_status: 'FAILED' } }]);
    const svc = new TaskService(makeDeps({ client }));
    const env = await svc.get('job-1');

    expect(() => svc.assertNotFailed(env)).toThrowError(/failed/i);
  });

  it('assertNotFailed is a no-op for a succeeded task', async () => {
    const { client } = realClient([{ output: { task_id: 'job-1', task_status: 'SUCCEEDED' } }]);
    const svc = new TaskService(makeDeps({ client }));
    const env = await svc.get('job-1');

    expect(() => svc.assertNotFailed(env)).not.toThrow();
  });
});
