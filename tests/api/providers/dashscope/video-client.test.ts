/**
 * Unit tests for VideoClient — the async submit boundary for video synthesis.
 *
 * A real DashScopeTransport substitute is injected; the SUT's own submit path
 * assembly and mandatory async-header merge are exercised, not mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  VideoClient,
  VIDEO_SYNTHESIS_PATH,
} from '../../../../src/api/providers/dashscope/video-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';

function makeClient(response: Record<string, unknown> = { output: { task_id: 't-1' } }): {
  client: VideoClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn().mockResolvedValue(response);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return { client: new VideoClient({ transport }), request };
}

describe('VideoClient.submit', () => {
  it('posts the body to the video synthesis path', async () => {
    const { client, request } = makeClient();
    const body = { model: 'wan2.7-t2v', input: { prompt: 'sunset' }, parameters: {} };

    await client.submit(body);

    expect(request).toHaveBeenCalledTimes(1);
    const arg = request.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.path).toBe(VIDEO_SYNTHESIS_PATH);
    expect(arg.method).toBe('POST');
    expect(arg.body).toEqual(body);
  });

  it('forces the async-enable header last so callers cannot override it', async () => {
    const { client, request } = makeClient();

    await client.submit(
      { model: 'wan2.7-t2v' },
      { 'X-DashScope-Async': 'disable', 'X-Custom': 'keep' },
    );

    const arg = request.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(arg.headers['X-DashScope-Async']).toBe('enable');
    expect(arg.headers['X-Custom']).toBe('keep');
  });

  it('returns the upstream submission response verbatim', async () => {
    const upstream = { request_id: 'r-9', output: { task_id: 'task-42', task_status: 'PENDING' } };
    const { client } = makeClient(upstream);

    const result = await client.submit({ model: 'wan2.7-i2v' });

    expect(result).toEqual(upstream);
  });

  it('targets the documented DashScope video synthesis path constant', () => {
    expect(VIDEO_SYNTHESIS_PATH).toBe('/api/v1/services/aigc/video-generation/video-synthesis');
  });
});
