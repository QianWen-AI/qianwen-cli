/**
 * Unit tests for the asynchronous 3D-generation submit boundary.
 *
 * A real DashScopeTransport substitute is injected; the SUT's own submit path
 * assembly and mandatory async-header merge are exercised, not mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Model3dClient,
  MODEL3D_GENERATION_PATH,
} from '../../../../src/api/providers/dashscope/model3d-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';

function makeClient(response: Record<string, unknown> = { output: { task_id: 't-1' } }): {
  client: Model3dClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn().mockResolvedValue(response);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return { client: new Model3dClient({ transport }), request };
}

describe('Model3dClient.submit', () => {
  // Guards the documented route: Tripo 3D hangs off the `video-generation/`
  // namespace. The old `aigc/3d-generation/generation` value made every call
  // fail with "url error, please check url".
  it('targets the documented 3D-generation path constant', () => {
    expect(MODEL3D_GENERATION_PATH).toBe('/api/v1/services/aigc/video-generation/3d-generation');
  });

  it('posts the body to the 3D-generation path', async () => {
    const { client, request } = makeClient();
    const body = { model: 'Tripo/Tripo-P1.0', input: { prompt: 'chair' } };

    await client.submit(body);

    const arg = request.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.path).toBe(MODEL3D_GENERATION_PATH);
    expect(arg.method).toBe('POST');
    expect(arg.body).toEqual(body);
  });

  it('forces the async-enable header last so callers cannot override it', async () => {
    const { client, request } = makeClient();

    await client.submit(
      { model: 'Tripo/Tripo-P1.0' },
      { 'X-DashScope-Async': 'disable', 'X-Custom': 'keep' },
    );

    const arg = request.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(arg.headers['X-DashScope-Async']).toBe('enable');
    expect(arg.headers['X-Custom']).toBe('keep');
  });

  it('returns the upstream submission response verbatim', async () => {
    const upstream = { request_id: 'r-9', output: { task_id: 'task-42', task_status: 'PENDING' } };
    const { client } = makeClient(upstream);

    const result = await client.submit({ model: 'Tripo/Tripo-P1.0' });

    expect(result).toEqual(upstream);
  });
});
