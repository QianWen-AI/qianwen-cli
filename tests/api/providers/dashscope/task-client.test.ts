/**
 * Unit tests for TaskClient — the async task boundary over the shared inference
 * transport: submit (X-DashScope-Async), single GET query, and response
 * normalization (task id, status, result URLs).
 *
 * Only the transport is substituted; the client's own request assembly and
 * normalization run for real.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TaskClient,
  TASK_QUERY_PATH_PREFIX,
  ASYNC_ENABLE_HEADER,
} from '../../../../src/api/providers/dashscope/task-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';

function makeTransport(response: Record<string, unknown> = {}): {
  transport: DashScopeTransport;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn().mockResolvedValue(response);
  return { transport: { request, requestRaw: vi.fn() } as unknown as DashScopeTransport, request };
}

describe('TaskClient — constants', () => {
  it('queries under the async task path prefix', () => {
    expect(TASK_QUERY_PATH_PREFIX).toBe('/api/v1/tasks/');
  });

  it('uses the DashScope async enable header name', () => {
    expect(ASYNC_ENABLE_HEADER).toBe('X-DashScope-Async');
  });
});

describe('TaskClient.submit', () => {
  it('posts the body to the given path', async () => {
    const { transport, request } = makeTransport({ output: { task_id: 't1' } });

    await new TaskClient({ transport }).submit('/api/v1/services/aigc/video/generation', {
      model: 'wan2.7-t2v',
    });

    const call = request.mock.calls[0]![0] as { path: string; method?: string; body?: unknown };
    expect(call.path).toBe('/api/v1/services/aigc/video/generation');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ model: 'wan2.7-t2v' });
  });

  it('injects the async enable header', async () => {
    const { transport, request } = makeTransport();

    await new TaskClient({ transport }).submit('/p', { model: 'm' });

    const headers = (request.mock.calls[0]![0] as { headers?: Record<string, string> }).headers;
    expect(headers).toMatchObject({ 'X-DashScope-Async': 'enable' });
  });

  it('merges caller headers but never lets them override the async header', async () => {
    const { transport, request } = makeTransport();

    await new TaskClient({ transport }).submit(
      '/p',
      { model: 'm' },
      {
        'X-Probe': 'on',
        'X-DashScope-Async': 'disable',
      },
    );

    const headers = (request.mock.calls[0]![0] as { headers?: Record<string, string> }).headers;
    expect(headers).toMatchObject({ 'X-Probe': 'on', 'X-DashScope-Async': 'enable' });
  });

  it('returns the upstream payload unchanged', async () => {
    const upstream = { request_id: 'r', output: { task_id: 't', task_status: 'PENDING' } };
    const { transport } = makeTransport(upstream);

    const result = await new TaskClient({ transport }).submit('/p', { model: 'm' });

    expect(result).toEqual(upstream);
  });
});

describe('TaskClient.get', () => {
  it('issues a GET to the task query path with the id appended', async () => {
    const { transport, request } = makeTransport({ output: {} });

    await new TaskClient({ transport }).get('abc-123');

    const call = request.mock.calls[0]![0] as { path: string; method?: string };
    expect(call.path).toBe('/api/v1/tasks/abc-123');
    expect(call.method).toBe('GET');
  });

  it('returns the upstream payload unchanged', async () => {
    const upstream = { output: { task_id: 'abc', task_status: 'SUCCEEDED' } };
    const { transport } = makeTransport(upstream);

    const result = await new TaskClient({ transport }).get('abc');

    expect(result).toEqual(upstream);
  });

  it('propagates a transport failure to the caller', async () => {
    const transport = {
      request: vi.fn().mockRejectedValue(new Error('boom')),
      requestRaw: vi.fn(),
    } as unknown as DashScopeTransport;

    await expect(new TaskClient({ transport }).get('x')).rejects.toThrow('boom');
  });
});

describe('TaskClient.extractTaskId', () => {
  it('prefers output.task_id', () => {
    const { transport } = makeTransport();
    expect(new TaskClient({ transport }).extractTaskId({ output: { task_id: 'a' } })).toBe('a');
  });

  it('falls back to a top-level task_id', () => {
    const { transport } = makeTransport();
    expect(new TaskClient({ transport }).extractTaskId({ task_id: 'b' })).toBe('b');
  });

  it('returns undefined when no task id is present', () => {
    const { transport } = makeTransport();
    expect(new TaskClient({ transport }).extractTaskId({ output: {} })).toBeUndefined();
  });
});

describe('TaskClient.normalizeStatus', () => {
  const cases: Array<[string, string]> = [
    ['PENDING', 'pending'],
    ['pending', 'pending'],
    ['RUNNING', 'running'],
    ['SUCCEEDED', 'succeeded'],
    ['FAILED', 'failed'],
    ['CANCELED', 'failed'],
  ];

  for (const [raw, expected] of cases) {
    it(`maps ${raw} to ${expected}`, () => {
      const { transport } = makeTransport();
      expect(new TaskClient({ transport }).normalizeStatus({ output: { task_status: raw } })).toBe(
        expected,
      );
    });
  }

  it('returns unknown when the status is missing', () => {
    const { transport } = makeTransport();
    expect(new TaskClient({ transport }).normalizeStatus({ output: {} })).toBe('unknown');
  });

  it('returns unknown for an unrecognized status', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).normalizeStatus({ output: { task_status: 'WEIRD' } }),
    ).toBe('unknown');
  });
});

describe('TaskClient.extractUrls', () => {
  it('reads output.results[].url', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).extractUrls({
        output: { results: [{ url: 'https://mock-api.test.qianwenai.com/a.mp4' }] },
      }),
    ).toEqual(['https://mock-api.test.qianwenai.com/a.mp4']);
  });

  it('reads Fun-ASR output.results[].transcription_url', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).extractUrls({
        output: {
          results: [
            {
              file_url: 'https://mock-media.test.qianwenai.com/input.wav',
              transcription_url: 'https://mock-api.test.qianwenai.com/transcription.json',
            },
          ],
        },
      }),
    ).toEqual(['https://mock-api.test.qianwenai.com/transcription.json']);
  });

  it('falls back to a string output.video_url', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).extractUrls({
        output: { video_url: 'https://mock-api.test.qianwenai.com/v.mp4' },
      }),
    ).toEqual(['https://mock-api.test.qianwenai.com/v.mp4']);
  });

  // Shape taken from the Tripo 3D API reference: a successful result carries the
  // mesh and its preview in the same record, so both must survive extraction.
  it('reads Tripo 3D output.results[].{pbr_model_url,rendered_image_url}', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).extractUrls({
        output: {
          results: [
            {
              pbr_model_url: 'https://mock-api.test.qianwenai.com/mesh.glb',
              rendered_image_url: 'https://mock-api.test.qianwenai.com/preview.webp',
            },
          ],
        },
      }),
    ).toEqual([
      'https://mock-api.test.qianwenai.com/mesh.glb',
      'https://mock-api.test.qianwenai.com/preview.webp',
    ]);
  });

  // Untextured Tripo output (pbr=false + texture=false) returns base_model_url.
  it('reads Tripo 3D output.results[].base_model_url for untextured meshes', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).extractUrls({
        output: { results: [{ base_model_url: 'https://mock-api.test.qianwenai.com/bare.glb' }] },
      }),
    ).toEqual(['https://mock-api.test.qianwenai.com/bare.glb']);
  });

  it('falls back to a string output.transcription_url', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).extractUrls({
        output: {
          transcription_url: 'https://mock-api.test.qianwenai.com/transcription.json',
        },
      }),
    ).toEqual(['https://mock-api.test.qianwenai.com/transcription.json']);
  });

  it('returns an empty list when no result urls exist', () => {
    const { transport } = makeTransport();
    expect(new TaskClient({ transport }).extractUrls({ output: {} })).toEqual([]);
    expect(new TaskClient({ transport }).extractUrls({})).toEqual([]);
  });

  it('skips non-string and empty url entries', () => {
    const { transport } = makeTransport();
    expect(
      new TaskClient({ transport }).extractUrls({
        output: {
          results: [{ url: '' }, { url: 5 }, { url: 'https://mock-api.test.qianwenai.com/ok.mp4' }],
        },
      }),
    ).toEqual(['https://mock-api.test.qianwenai.com/ok.mp4']);
  });
});
