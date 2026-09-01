/**
 * Unit tests for ChatService — orchestration of tiers 0/1/2/3 into a native
 * chat request body, plus the non-streaming and streaming call paths.
 *
 * The service composes real base collaborators (request parsing, conflict
 * detection, envelope construction, mapping registry). Only the outermost
 * boundaries are substituted: the model resolver (network), the asset policy
 * (filesystem/upload), and the chat client (HTTP). The body assembly and the
 * response/stream normalization run for real.
 */
import { describe, it, expect, vi } from 'vitest';
import { ChatService, type ChatServiceDeps } from '../../src/services/chat-service.js';
import { RequestPayloadParser } from '../../src/services/request-payload-parser.js';
import { LayerConflictDetector } from '../../src/services/layer-conflict-detector.js';
import { InvocationEnvelope } from '../../src/services/invocation-envelope.js';
import { MappingRegistry } from '../../src/api/providers/mapping-registry.js';
import { registerChatMappings } from '../../src/services/chat-service.js';
import type { DefaultModelResolver } from '../../src/services/default-model-resolver.js';
import type { AssetPolicy } from '../../src/services/asset-policy.js';
import type { ChatClient } from '../../src/api/providers/dashscope/chat-client.js';
import type { ChatStreamEvent } from '../../src/types/chat.js';

function makeRegistry(): MappingRegistry {
  const registry = new MappingRegistry();
  registerChatMappings(registry);
  return registry;
}

function makeResolver(model: string): DefaultModelResolver {
  return {
    resolve: vi.fn(async (_q: unknown, flag?: string) => flag ?? model),
  } as unknown as DefaultModelResolver;
}

function makeAssetPolicy(url: string): AssetPolicy {
  return {
    resolve: vi.fn(async () => ({ url, delivery: 'public-url' as const })),
  } as unknown as AssetPolicy;
}

function makeOssAssetPolicy(url: string): AssetPolicy {
  return {
    resolve: vi.fn(async () => ({
      url,
      delivery: 'temp-upload' as const,
      extraHeaders: { 'X-DashScope-OssResourceResolve': 'enable' },
    })),
  } as unknown as AssetPolicy;
}

interface ClientStub {
  client: ChatClient;
  create: ReturnType<typeof vi.fn>;
  createStream: ReturnType<typeof vi.fn>;
}

function makeClient(response: Record<string, unknown>, events: ChatStreamEvent[] = []): ClientStub {
  const create = vi.fn().mockResolvedValue(response);
  const createStream = vi.fn(() => {
    async function* gen(): AsyncIterable<ChatStreamEvent> {
      for (const e of events) yield e;
    }
    return gen();
  });
  const client = { create, createStream } as unknown as ChatClient;
  return { client, create, createStream };
}

function makeService(overrides: Partial<ChatServiceDeps> = {}): ChatServiceDeps {
  return {
    parser: new RequestPayloadParser({
      readFile: () => {
        throw new Error('no file');
      },
      readStdin: () => '',
    }),
    conflictDetector: new LayerConflictDetector(),
    modelResolver: makeResolver('qwen3.7-max'),
    registry: makeRegistry(),
    assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/a.png'),
    envelope: new InvocationEnvelope(),
    client: makeClient({ id: 'resp-1' }).client,
    context: () => ({ site: 'qianwen', account: 'acct-1' }),
    ...overrides,
  };
}

describe('ChatService.buildRequest', () => {
  it('wraps a bare prompt into a single user message', async () => {
    const svc = new ChatService(makeService());

    const { body } = await svc.buildRequest({ prompt: 'explain quantum computing' });

    expect(body.messages).toEqual([{ role: 'user', content: 'explain quantum computing' }]);
  });

  it('resolves the model via the resolver and stamps it on the body', async () => {
    const svc = new ChatService(makeService({ modelResolver: makeResolver('qwen3.7-max') }));

    const { model, body } = await svc.buildRequest({ prompt: 'hi' });

    expect(model).toBe('qwen3.7-max');
    expect(body.model).toBe('qwen3.7-max');
  });

  it('honors an explicit --model over the default', async () => {
    const svc = new ChatService(makeService());

    const { model } = await svc.buildRequest({ prompt: 'hi', model: 'qwen3-vl-plus' });

    expect(model).toBe('qwen3-vl-plus');
  });

  it('maps --temperature onto the native temperature field', async () => {
    const svc = new ChatService(makeService());

    const { body } = await svc.buildRequest({ prompt: 'hi', temperature: 0.7 });

    expect(body.temperature).toBe(0.7);
  });

  it('maps --max-tokens onto max_completion_tokens and never max_tokens', async () => {
    const svc = new ChatService(makeService());

    const { body } = await svc.buildRequest({ prompt: 'hi', maxTokens: 1024 });

    expect(body.max_completion_tokens).toBe(1024);
    expect('max_tokens' in body).toBe(false);
  });

  it('writes stream:true only when --stream is set', async () => {
    const svc = new ChatService(makeService());

    const withStream = await svc.buildRequest({ prompt: 'hi', stream: true });
    const withoutStream = await svc.buildRequest({ prompt: 'hi' });

    expect(withStream.body.stream).toBe(true);
    expect('stream' in withoutStream.body).toBe(false);
  });

  it('writes enable_thinking true for --thinking and false for --no-thinking', async () => {
    const svc = new ChatService(makeService());

    const on = await svc.buildRequest({ prompt: 'hi', thinking: true });
    const off = await svc.buildRequest({ prompt: 'hi', thinking: false });
    const inherit = await svc.buildRequest({ prompt: 'hi' });

    expect(on.body.enable_thinking).toBe(true);
    expect(off.body.enable_thinking).toBe(false);
    expect('enable_thinking' in inherit.body).toBe(false);
  });
});

describe('ChatService.buildRequest — vision structuring', () => {
  it('builds an image_url content part alongside a text part for a vision model', async () => {
    const svc = new ChatService(
      makeService({ assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/a.png') }),
    );

    const { body } = await svc.buildRequest({
      prompt: 'describe this image',
      model: 'qwen3-vl-plus',
      image: './a.png',
    });

    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://mock-api.test.qianwenai.com/a.png' } },
          { type: 'text', text: 'describe this image' },
        ],
      },
    ]);
  });

  it('builds a video_url content part alongside a text part for a vision model', async () => {
    const svc = new ChatService(
      makeService({ assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/v.mp4') }),
    );

    const { body } = await svc.buildRequest({
      prompt: 'summarize',
      model: 'qwen3-vl-plus',
      video: './v.mp4',
    });

    const content = (body.messages as Array<{ content: unknown }>)[0].content as Array<{
      type: string;
    }>;
    expect(content).toContainEqual({
      type: 'video_url',
      video_url: { url: 'https://mock-api.test.qianwenai.com/v.mp4' },
    });
    expect(content).toContainEqual({ type: 'text', text: 'summarize' });
  });

  it('allows --image on an explicitly-named model without a vl token', async () => {
    const svc = new ChatService(
      makeService({ assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/a.png') }),
    );

    const { model, body } = await svc.buildRequest({
      prompt: 'what is in this image',
      model: 'qwen3.8-max',
      image: './a.png',
    });

    expect(model).toBe('qwen3.8-max');
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://mock-api.test.qianwenai.com/a.png' } },
          { type: 'text', text: 'what is in this image' },
        ],
      },
    ]);
  });

  it('allows --video on an explicitly-named model without a vl token', async () => {
    const svc = new ChatService(
      makeService({ assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/v.mp4') }),
    );

    const { model, body } = await svc.buildRequest({
      prompt: 'summarize',
      model: 'qwen-max',
      video: './v.mp4',
    });

    expect(model).toBe('qwen-max');
    const content = (body.messages as Array<{ content: unknown }>)[0].content as Array<{
      type: string;
    }>;
    expect(content).toContainEqual({
      type: 'video_url',
      video_url: { url: 'https://mock-api.test.qianwenai.com/v.mp4' },
    });
    expect(content).toContainEqual({ type: 'text', text: 'summarize' });
  });

  it('attaches --image for the resolved default model and defers capability to the backend', async () => {
    const assetPolicy = makeAssetPolicy('https://mock-api.test.qianwenai.com/a.png');
    const svc = new ChatService(
      makeService({ assetPolicy, modelResolver: makeResolver('qwen3.8-max') }),
    );

    const { model, body } = await svc.buildRequest({ prompt: 'hi', image: './a.png' });

    expect(model).toBe('qwen3.8-max');
    expect(assetPolicy.resolve as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const content = (body.messages as Array<{ content: unknown }>)[0].content as Array<{
      type: string;
    }>;
    expect(content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'https://mock-api.test.qianwenai.com/a.png' },
    });
    expect(content).toContainEqual({ type: 'text', text: 'hi' });
  });

  it('treats a model carried by --request as explicit and allows --image', async () => {
    const svc = new ChatService(
      makeService({
        parser: new RequestPayloadParser({
          readFile: () => {
            throw new Error('no file');
          },
          readStdin: () => '',
        }),
        assetPolicy: makeAssetPolicy('https://mock-api.test.qianwenai.com/a.png'),
      }),
    );

    const { model, body } = await svc.buildRequest({
      prompt: 'what is in this image',
      request: '{"model":"qwen3.8-max"}',
      image: './a.png',
    });

    expect(model).toBe('qwen3.8-max');
    const content = (body.messages as Array<{ content: unknown }>)[0].content as Array<{
      type: string;
    }>;
    expect(content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'https://mock-api.test.qianwenai.com/a.png' },
    });
    expect(content).toContainEqual({ type: 'text', text: 'what is in this image' });
  });
});

describe('ChatService.buildRequest — tier 3 passthrough & conflicts', () => {
  it('passes a --request body through unchanged when no flags collide', async () => {
    const svc = new ChatService(makeService());

    const { body } = await svc.buildRequest({
      request: '{"messages":[{"role":"user","content":"hi"}],"presence_penalty":0.2}',
    });

    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.presence_penalty).toBe(0.2);
  });

  it('lets --model override request.model while keeping other keys', async () => {
    const svc = new ChatService(makeService());

    const { body } = await svc.buildRequest({
      model: 'qwen3-vl-plus',
      request: '{"model":"qwen3.7-max","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(body.model).toBe('qwen3-vl-plus');
  });

  it('rejects a prompt together with request.messages (exit 4)', async () => {
    const svc = new ChatService(makeService());

    await expect(
      svc.buildRequest({ prompt: 'hi', request: '{"messages":[{"role":"user","content":"x"}]}' }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects when neither a prompt nor a --request is supplied (exit 4)', async () => {
    const svc = new ChatService(makeService());

    await expect(svc.buildRequest({})).rejects.toMatchObject({ exitCode: 4 });
  });

  it('rejects a --temperature that duplicates a request temperature (exit 4)', async () => {
    const svc = new ChatService(makeService());

    await expect(
      svc.buildRequest({ prompt: 'hi', temperature: 0.7, request: '{"temperature":0.5}' }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('does not construct messages from the prompt when request already supplies them', async () => {
    const svc = new ChatService(makeService());

    const { body } = await svc.buildRequest({
      request:
        '{"messages":[{"role":"system","content":"be concise"},{"role":"user","content":"hi"}]}',
    });

    expect((body.messages as unknown[]).length).toBe(2);
  });
});

describe('ChatService.create — non-streaming envelope', () => {
  const upstream = {
    id: 'resp-42',
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    choices: [{ message: { role: 'assistant', content: 'hello' } }],
  };

  it('sends the assembled body to the client', async () => {
    const stub = makeClient(upstream);
    const svc = new ChatService(makeService({ client: stub.client }));

    await svc.create({ prompt: 'hi' });

    const sent = stub.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('forwards the OSS resolve header to the client when an asset requires it', async () => {
    const stub = makeClient(upstream);
    const svc = new ChatService(
      makeService({
        client: stub.client,
        assetPolicy: makeOssAssetPolicy('oss://qwen-uploads/20260610/a.png'),
      }),
    );

    await svc.create({ prompt: 'describe', model: 'qwen3-vl-plus', image: './a.png' });

    const headers = stub.create.mock.calls[0]![1] as Record<string, string> | undefined;
    expect(headers?.['X-DashScope-OssResourceResolve']).toBe('enable');
  });

  it('omits extra headers when no asset requires them', async () => {
    const stub = makeClient(upstream);
    const svc = new ChatService(makeService({ client: stub.client }));

    await svc.create({ prompt: 'hi' });

    const headers = stub.create.mock.calls[0]![1] as Record<string, string> | undefined;
    expect(headers).toBeUndefined();
  });

  it('maps the upstream id into meta.request_id', async () => {
    const stub = makeClient(upstream);
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect(env.meta.request_id).toBe('resp-42');
  });

  it('maps upstream usage into the *_tokens envelope usage', async () => {
    const stub = makeClient(upstream);
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect(env.meta.usage).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 30 });
  });

  it('reduces the upstream payload to content plus finish_reason', async () => {
    const stub = makeClient({
      ...upstream,
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    });
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect(env.data).toEqual({ content: 'hello', finish_reason: 'stop' });
  });

  it('reports the resolved model in meta.model', async () => {
    const stub = makeClient(upstream);
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect(env.meta.model).toBe('qwen3.7-max');
  });

  it('prefers the model echoed by the backend over the resolved one', async () => {
    const stub = makeClient({ ...upstream, model: 'qwen3.7-max-2026-08-01' });
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect(env.meta.model).toBe('qwen3.7-max-2026-08-01');
  });

  it('surfaces reasoning_content in data when the model returns it', async () => {
    const stub = makeClient({
      ...upstream,
      choices: [{ message: { content: 'answer', reasoning_content: 'thoughts' } }],
    });
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect(env.data.reasoning_content).toBe('thoughts');
    expect(env.data.content).toBe('answer');
  });

  it('joins multimodal content parts into a single content string', async () => {
    const stub = makeClient({
      ...upstream,
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        },
      ],
    });
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect(env.data.content).toBe('ab');
  });

  it('omits meta.request_id when the upstream has no id', async () => {
    const stub = makeClient({ choices: [] });
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect('request_id' in env.meta).toBe(false);
  });

  it('omits meta.usage when the upstream reports none', async () => {
    const stub = makeClient({ id: 'x', choices: [] });
    const svc = new ChatService(makeService({ client: stub.client }));

    const env = await svc.create({ prompt: 'hi' });

    expect('usage' in env.meta).toBe(false);
  });
});

describe('ChatService.createStream', () => {
  it('forces stream:true on the body it hands to the client', async () => {
    const stub = makeClient({}, [{ type: 'done' }]);
    const svc = new ChatService(makeService({ client: stub.client }));

    for await (const _ of svc.createStream({ prompt: 'hi' })) void _;

    const sent = stub.createStream.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.stream).toBe(true);
  });

  it('forwards the OSS resolve header to the streaming client when an asset requires it', async () => {
    const stub = makeClient({}, [{ type: 'done' }]);
    const svc = new ChatService(
      makeService({
        client: stub.client,
        assetPolicy: makeOssAssetPolicy('oss://qwen-uploads/20260610/v.mp4'),
      }),
    );

    for await (const _ of svc.createStream({
      prompt: 'summarize',
      model: 'qwen3-vl-plus',
      video: './v.mp4',
    }))
      void _;

    const headers = stub.createStream.mock.calls[0]![1] as Record<string, string> | undefined;
    expect(headers?.['X-DashScope-OssResourceResolve']).toBe('enable');
  });

  it('passes the client events through without filtering', async () => {
    const events: ChatStreamEvent[] = [
      { type: 'reasoning', reasoning: 'think' },
      { type: 'content', content: 'answer' },
      { type: 'done' },
    ];
    const stub = makeClient({}, events);
    const svc = new ChatService(makeService({ client: stub.client }));

    const seen: ChatStreamEvent[] = [];
    for await (const e of svc.createStream({ prompt: 'hi' })) seen.push(e);

    expect(seen).toEqual(events);
  });
});
