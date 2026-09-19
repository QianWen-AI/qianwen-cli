/**
 * Unit tests for the WebSocket speech-synthesis client. A fake WebSocket is
 * injected to drive the DashScope realtime event sequence and assert the
 * duplex/out task lifecycle plus binary frame assembly and error handling.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TtsWebSocketClient } from '../../../../src/api/providers/dashscope/tts-ws-client.js';

class FakeSocket extends EventEmitter {
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  send = vi.fn((raw: string) => {
    this.sent.push(JSON.parse(raw));
  });
  close = vi.fn(() => {
    this.closed = true;
  });

  header(sent: number): Record<string, unknown> {
    return (this.sent[sent] as Record<string, unknown>).header as Record<string, unknown>;
  }
}

function makeClient(socket: FakeSocket): TtsWebSocketClient {
  return new TtsWebSocketClient({
    baseUrl: 'https://dashscope.aliyuncs.com',
    token: 'sk-test',
    userAgent: 'test-agent',
    connect: () => socket as unknown as never,
  });
}

function makeTokenPlanClient(socket: FakeSocket): TtsWebSocketClient {
  return new TtsWebSocketClient({
    baseUrl: 'https://dashscope.aliyuncs.com',
    token: 'sk-sp-test',
    userAgent: 'test-agent',
    connect: () => socket as unknown as never,
  });
}

function taskStarted(socket: FakeSocket): void {
  socket.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-started' } })), false);
}

function taskFinished(socket: FakeSocket, usage?: Record<string, unknown>): void {
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ header: { event: 'task-finished' }, payload: { usage } })),
    false,
  );
}

describe('TtsWebSocketClient', () => {
  it('sends a single run-task carrying text in out mode', async () => {
    const socket = new FakeSocket();
    const promise = makeClient(socket).synthesize({
      model: 'sambert-zhinan-v1',
      text: 'hello',
      parameters: { format: 'mp3' },
      streaming: 'out',
    });

    socket.emit('open');
    expect(socket.header(0).action).toBe('run-task');
    const payload = (socket.sent[0] as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.input).toEqual({ text: 'hello' });

    taskStarted(socket);
    expect(socket.sent).toHaveLength(1);

    socket.emit('message', new Uint8Array([1, 2, 3]).buffer, true);
    taskFinished(socket);

    const result = await promise;
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
    expect(result.format).toBe('mp3');
  });

  it('emits run-task then continue/finish carrying text in duplex mode', async () => {
    const socket = new FakeSocket();
    const promise = makeClient(socket).synthesize({
      model: 'cosyvoice-v3.5-flash',
      text: 'hi there',
      parameters: { voice: 'custom', format: 'wav' },
      streaming: 'duplex',
    });

    socket.emit('open');
    const runPayload = (socket.sent[0] as Record<string, unknown>).payload as Record<
      string,
      unknown
    >;
    expect(runPayload.input).toEqual({});

    taskStarted(socket);
    expect(socket.header(1).action).toBe('continue-task');
    expect(
      ((socket.sent[1] as Record<string, unknown>).payload as Record<string, unknown>).input,
    ).toEqual({ text: 'hi there' });
    expect(socket.header(2).action).toBe('finish-task');

    socket.emit('message', new Uint8Array([9]).buffer, true);
    taskFinished(socket, { characters: 8 });

    const result = await promise;
    expect(Array.from(result.audio)).toEqual([9]);
    expect(result.usage).toEqual({ characters: 8 });
  });

  it('rejects on task-failed with the server error message', async () => {
    const socket = new FakeSocket();
    const promise = makeClient(socket).synthesize({
      model: 'sambert-zhinan-v1',
      text: 'x',
      parameters: {},
      streaming: 'out',
    });

    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          header: { event: 'task-failed', error_message: 'boom', error_code: 'E1' },
        }),
      ),
      false,
    );

    await expect(promise).rejects.toThrow(/boom \(E1\)/);
    expect(socket.close).toHaveBeenCalled();
  });

  it('maps a token-plan model rejection to MODEL_NOT_SUPPORTED', async () => {
    const socket = new FakeSocket();
    const promise = makeTokenPlanClient(socket).synthesize({
      model: 'sambert-zhinan-v1',
      text: 'x',
      parameters: {},
      streaming: 'out',
    });

    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          header: {
            event: 'task-failed',
            error_message: 'Model not exist.',
            error_code: 'InvalidParameter',
          },
        }),
      ),
      false,
    );

    await expect(promise).rejects.toMatchObject({
      code: 'MODEL_NOT_SUPPORTED',
      detail: expect.stringContaining('Model not exist'),
    });
  });

  it('rejects when the connection closes before completion', async () => {
    const socket = new FakeSocket();
    const promise = makeClient(socket).synthesize({
      model: 'sambert-zhinan-v1',
      text: 'x',
      parameters: {},
      streaming: 'out',
    });

    socket.emit('open');
    socket.emit('close');

    await expect(promise).rejects.toThrow(/closed before synthesis completed/);
  });

  it('rejects when no audio frames arrive', async () => {
    const socket = new FakeSocket();
    const promise = makeClient(socket).synthesize({
      model: 'sambert-zhinan-v1',
      text: 'x',
      parameters: {},
      streaming: 'out',
    });

    socket.emit('open');
    taskStarted(socket);
    taskFinished(socket);

    await expect(promise).rejects.toThrow(/returned no audio/);
  });
});
