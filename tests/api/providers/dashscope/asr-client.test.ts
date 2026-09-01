/**
 * Unit tests for ASRClient — the async submit boundary for recorded-audio
 * transcription. A real DashScopeTransport substitute is injected; the SUT's
 * own submit path assembly and mandatory async-header merge are exercised.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ASRClient,
  ASR_TRANSCRIPTION_PATH,
  MULTIMODAL_GENERATION_PATH,
} from '../../../../src/api/providers/dashscope/asr-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';

function makeClient(response: Record<string, unknown> = { output: { task_id: 't-1' } }): {
  client: ASRClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn().mockResolvedValue(response);
  const transport = { request, requestRaw: vi.fn() } as unknown as DashScopeTransport;
  return { client: new ASRClient({ transport }), request };
}

describe('ASRClient.submit', () => {
  it('posts the body to the transcription path', async () => {
    const { client, request } = makeClient();
    const body = { model: 'fun-asr', input: { file_urls: ['u'] }, parameters: {} };

    await client.submit(body);

    expect(request).toHaveBeenCalledTimes(1);
    const arg = request.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.path).toBe(ASR_TRANSCRIPTION_PATH);
    expect(arg.method).toBe('POST');
    expect(arg.body).toEqual(body);
  });

  it('forces the async-enable header last so callers cannot override it', async () => {
    const { client, request } = makeClient();

    await client.submit(
      { model: 'fun-asr' },
      { 'X-DashScope-Async': 'disable', 'X-Custom': 'keep' },
    );

    const arg = request.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(arg.headers['X-DashScope-Async']).toBe('enable');
    expect(arg.headers['X-Custom']).toBe('keep');
  });

  it('returns the upstream submission response verbatim', async () => {
    const upstream = { request_id: 'r-9', output: { task_id: 'task-42', task_status: 'PENDING' } };
    const { client } = makeClient(upstream);

    const result = await client.submit({ model: 'fun-asr' });

    expect(result).toEqual(upstream);
  });

  it('targets the documented transcription path constant', () => {
    expect(ASR_TRANSCRIPTION_PATH).toBe('/api/v1/services/audio/asr/transcription');
  });
});

describe('ASRClient.generate', () => {
  it('posts the body to the multimodal-generation path without the async header', async () => {
    const { client, request } = makeClient();
    const body = {
      model: 'qwen-audio-3.0-asr-flash',
      input: { messages: [{ role: 'user', content: [{ audio: 'u' }] }] },
    };

    await client.generate(body);

    const arg = request.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.path).toBe(MULTIMODAL_GENERATION_PATH);
    expect(arg.method).toBe('POST');
    expect(arg.body).toEqual(body);
    expect(arg.headers).toBeUndefined();
  });

  it('forwards extra headers on the sync path', async () => {
    const { client, request } = makeClient();

    await client.generate({ model: 'qwen-audio-3.0-asr-flash' }, { 'X-Custom': 'keep' });

    const arg = request.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(arg.headers?.['X-Custom']).toBe('keep');
  });
});
