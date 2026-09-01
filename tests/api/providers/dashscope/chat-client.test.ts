/**
 * Unit tests for ChatClient — the chat-completions boundary over the shared
 * inference transport.
 *
 * Two behaviours are specified beyond plain request forwarding:
 *   1. Directed serialization: the sampling temperature must reach the upstream
 *      with a fractional form even when the user supplied a whole number, since
 *      the wire protocol rejects an integer there. No other field may be
 *      reshaped, including a same-named field at a deeper level.
 *   2. Stream normalization: server-sent events are reduced to a single event
 *      union, tolerating chunk boundaries that split a line and data lines that
 *      are not valid JSON.
 *
 * Only the transport is substituted; the client's own serialization and event
 * parsing run for real.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ChatClient,
  CHAT_COMPLETIONS_PATH,
  serializeChatBody,
} from '../../../../src/api/providers/dashscope/chat-client.js';
import type { DashScopeTransport } from '../../../../src/api/providers/dashscope/transport.js';
import type { ChatStreamEvent } from '../../../../src/types/chat.js';

/** A transport double capturing the outbound request. */
function makeTransport(overrides: Partial<DashScopeTransport> = {}): DashScopeTransport {
  return {
    request: vi.fn().mockResolvedValue({ id: 'resp-1' }),
    requestRaw: vi.fn(),
    ...overrides,
  } as unknown as DashScopeTransport;
}

/** Build a streaming Response whose body yields the given chunks verbatim. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * Build a streaming Response that stays open after emitting its chunks —
 * as if the server kept the connection alive past the sentinel — and
 * records whether the client cancels it.
 */
function openSseResponse(chunks: string[], onCancel: () => void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function openStreamingTransport(
  chunks: string[],
  onCancel: () => void,
): Promise<DashScopeTransport> {
  const requestRaw = vi.fn().mockResolvedValue(openSseResponse(chunks, onCancel));
  return makeTransport({ requestRaw } as unknown as Partial<DashScopeTransport>);
}

async function collect(events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Read the raw payload the client handed to the transport. */
function capturedRawBody(transport: DashScopeTransport): string {
  const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
  return (mock.mock.calls[0]![0] as { rawBody?: string }).rawBody!;
}

describe('serializeChatBody', () => {
  describe('directed temperature serialization', () => {
    it('renders a whole-number temperature with a fractional part', () => {
      expect(serializeChatBody({ temperature: 1 })).toBe('{"temperature":1.0}');
    });

    it('renders a zero temperature with a fractional part', () => {
      expect(serializeChatBody({ temperature: 0 })).toBe('{"temperature":0.0}');
    });

    it('normalizes a negative zero temperature to a fractional zero', () => {
      expect(serializeChatBody({ temperature: -0 })).toBe('{"temperature":0.0}');
    });

    it('leaves an already fractional temperature untouched', () => {
      expect(serializeChatBody({ temperature: 0.7 })).toBe('{"temperature":0.7}');
    });

    it('preserves the position of the temperature key among siblings', () => {
      expect(serializeChatBody({ model: 'qwen3.7-max', temperature: 2, stream: true })).toBe(
        '{"model":"qwen3.7-max","temperature":2.0,"stream":true}',
      );
    });
  });

  describe('non-interference with other fields', () => {
    it('does not reshape a nested temperature under a parameters block', () => {
      expect(serializeChatBody({ parameters: { temperature: 1 } })).toBe(
        '{"parameters":{"temperature":1}}',
      );
    });

    it('does not reshape a temperature nested under an unrelated parent', () => {
      expect(serializeChatBody({ a: { temperature: 1 } })).toBe('{"a":{"temperature":1}}');
    });

    it('leaves other whole-number fields as integers', () => {
      expect(serializeChatBody({ top_p: 1, n: 1, max_completion_tokens: 1024 })).toBe(
        '{"top_p":1,"n":1,"max_completion_tokens":1024}',
      );
    });

    it('leaves a whole-number field as an integer alongside a converted temperature', () => {
      expect(serializeChatBody({ temperature: 1, top_p: 1 })).toBe('{"temperature":1.0,"top_p":1}');
    });

    it('matches plain serialization when no temperature is present', () => {
      const body = { model: 'qwen3.7-max', messages: [{ role: 'user', content: 'hi' }] };

      expect(serializeChatBody(body)).toBe(JSON.stringify(body));
    });

    it('does not special-case a non-numeric temperature', () => {
      expect(serializeChatBody({ temperature: null })).toBe('{"temperature":null}');
    });

    it('preserves a deeply nested message structure verbatim', () => {
      const body = {
        temperature: 1,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'https://mock-api.test.qianwenai.com/a.png' },
              },
              { type: 'text', text: 'describe' },
            ],
          },
        ],
      };

      const parsed = JSON.parse(serializeChatBody(body)) as typeof body;
      expect(parsed.messages).toEqual(body.messages);
    });

    it('produces a payload that remains valid JSON', () => {
      const parsed = JSON.parse(serializeChatBody({ temperature: 3, model: 'm' })) as {
        temperature: number;
        model: string;
      };

      expect(parsed).toEqual({ temperature: 3, model: 'm' });
    });
  });
});

describe('ChatClient', () => {
  describe('endpoint', () => {
    it('targets the OpenAI-compatible chat completions path', () => {
      expect(CHAT_COMPLETIONS_PATH).toBe('/compatible-mode/v1/chat/completions');
    });
  });

  describe('create', () => {
    it('posts to the chat completions path', async () => {
      const transport = makeTransport();

      await new ChatClient({ transport }).create({ model: 'qwen3.7-max' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { path: string }).path).toBe(CHAT_COMPLETIONS_PATH);
    });

    it('issues the request as a POST', async () => {
      const transport = makeTransport();

      await new ChatClient({ transport }).create({ model: 'qwen3.7-max' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { method?: string }).method).toBe('POST');
    });

    it('sends the body through the pre-serialized channel', async () => {
      const transport = makeTransport();

      await new ChatClient({ transport }).create({ temperature: 1 });

      expect(capturedRawBody(transport)).toBe('{"temperature":1.0}');
    });

    it('does not populate the structured body channel', async () => {
      const transport = makeTransport();

      await new ChatClient({ transport }).create({ temperature: 1 });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      expect((mock.mock.calls[0]![0] as { body?: unknown }).body).toBeUndefined();
    });

    it('returns the upstream payload unchanged', async () => {
      const upstream = { id: 'resp-7', choices: [{ message: { content: 'hi' } }] };
      const transport = makeTransport({
        request: vi.fn().mockResolvedValue(upstream),
      } as unknown as Partial<DashScopeTransport>);

      const result = await new ChatClient({ transport }).create({ model: 'm' });

      expect(result).toEqual(upstream);
    });

    it('forwards caller-supplied extra headers', async () => {
      const transport = makeTransport();

      await new ChatClient({ transport }).create({ model: 'm' }, { 'X-Probe': 'enable' });

      const mock = transport.request as unknown as ReturnType<typeof vi.fn>;
      const headers = (mock.mock.calls[0]![0] as { headers?: Record<string, string> }).headers;
      expect(headers).toMatchObject({ 'X-Probe': 'enable' });
    });

    it('propagates a transport failure to the caller', async () => {
      const transport = makeTransport({
        request: vi.fn().mockRejectedValue(new Error('upstream refused')),
      } as unknown as Partial<DashScopeTransport>);

      await expect(new ChatClient({ transport }).create({ model: 'm' })).rejects.toThrow(
        'upstream refused',
      );
    });
  });
});

describe('ChatClient.createStream', () => {
  function streamingTransport(chunks: string[]): {
    transport: DashScopeTransport;
    requestRaw: ReturnType<typeof vi.fn>;
  } {
    const requestRaw = vi.fn().mockResolvedValue(sseResponse(chunks));
    const transport = makeTransport({ requestRaw } as unknown as Partial<DashScopeTransport>);
    return { transport, requestRaw };
  }

  it('drives the raw transport channel rather than the JSON channel', async () => {
    const { transport, requestRaw } = streamingTransport(['data: [DONE]\n\n']);

    await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    const jsonMock = transport.request as unknown as ReturnType<typeof vi.fn>;
    expect(jsonMock).not.toHaveBeenCalled();
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('targets the chat completions path as a POST', async () => {
    const { transport, requestRaw } = streamingTransport(['data: [DONE]\n\n']);

    await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    const req = requestRaw.mock.calls[0]![0] as { path: string; method?: string };
    expect(req.path).toBe(CHAT_COMPLETIONS_PATH);
    expect(req.method).toBe('POST');
  });

  it('sends the stream body through the pre-serialized channel', async () => {
    const { transport, requestRaw } = streamingTransport(['data: [DONE]\n\n']);

    await collect(new ChatClient({ transport }).createStream({ temperature: 1, stream: true }));

    const req = requestRaw.mock.calls[0]![0] as { rawBody?: string; body?: unknown };
    expect(req.rawBody).toBe('{"temperature":1.0,"stream":true}');
    expect(req.body).toBeUndefined();
  });

  it('forwards caller-supplied extra headers', async () => {
    const { transport, requestRaw } = streamingTransport(['data: [DONE]\n\n']);

    await collect(new ChatClient({ transport }).createStream({ model: 'm' }, { 'X-Probe': 'on' }));

    const req = requestRaw.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(req.headers).toMatchObject({ 'X-Probe': 'on' });
  });

  it('flags the request as streaming so the transport arms its idle timer', async () => {
    const { transport, requestRaw } = streamingTransport(['data: [DONE]\n\n']);

    await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    const req = requestRaw.mock.calls[0]![0] as { stream?: boolean };
    expect(req.stream).toBe(true);
  });

  it('normalizes an upstream error payload into an error event', async () => {
    const { transport } = streamingTransport([
      'data: {"error":{"code":"RateLimit","message":"too many requests"}}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events).toContainEqual({
      type: 'error',
      error: { code: 'RateLimit', message: 'too many requests' },
    });
  });

  it('normalizes a content delta into a content event', async () => {
    const { transport } = streamingTransport([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events).toContainEqual({ type: 'content', content: 'Hello' });
  });

  it('normalizes a reasoning delta into a reasoning event', async () => {
    const { transport } = streamingTransport([
      'data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events).toContainEqual({ type: 'reasoning', reasoning: 'pondering' });
  });

  it('does not emit a content event for an empty content delta', async () => {
    const { transport } = streamingTransport(['data: {"choices":[{"delta":{"content":""}}]}\n\n']);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events.some((e) => e.type === 'content')).toBe(false);
  });

  it('attaches a finish reason to the event carrying it', async () => {
    const { transport } = streamingTransport([
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    const content = events.find((e) => e.type === 'content');
    expect(content?.finishReason).toBe('stop');
  });

  it('normalizes a trailing usage block into a usage event', async () => {
    const { transport } = streamingTransport([
      'data: {"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events).toContainEqual({
      type: 'usage',
      usage: { input: 11, output: 22, total: 33 },
    });
  });

  it('records the upstream identifier on the first emitted event', async () => {
    const { transport } = streamingTransport([
      'data: {"id":"chatcmpl-77","choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events[0]?.requestId).toBe('chatcmpl-77');
  });

  it('emits a done event and stops on the sentinel', async () => {
    const { transport } = streamingTransport([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"never"}}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(events.some((e) => e.type === 'content' && e.content === 'never')).toBe(false);
  });

  it('ignores a data line that is not valid JSON without throwing', async () => {
    const { transport } = streamingTransport([
      'data: not-json\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events).toContainEqual({ type: 'content', content: 'ok' });
  });

  it('ignores blank lines and SSE comment lines', async () => {
    const { transport } = streamingTransport([
      ': keep-alive\n\n',
      '\n',
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events).toEqual([{ type: 'content', content: 'x' }]);
  });

  it('buffers a data line split across chunk boundaries', async () => {
    const { transport } = streamingTransport([
      'data: {"choices":[{"delta":{"con',
      'tent":"joined"}}]}\n\n',
    ]);

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events).toContainEqual({ type: 'content', content: 'joined' });
  });

  it('cancels the underlying stream after the done sentinel', async () => {
    let cancelled = false;
    const transport = await openStreamingTransport(
      ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'],
      () => {
        cancelled = true;
      },
    );

    const events = await collect(new ChatClient({ transport }).createStream({ model: 'm' }));

    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(cancelled).toBe(true);
  });

  it('cancels the underlying stream when the consumer stops early', async () => {
    let cancelled = false;
    const transport = await openStreamingTransport(
      [
        'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
      ],
      () => {
        cancelled = true;
      },
    );

    for await (const event of new ChatClient({ transport }).createStream({ model: 'm' })) {
      if (event.type === 'content') break;
    }

    expect(cancelled).toBe(true);
  });
});
