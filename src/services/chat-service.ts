/** Orchestrates tiers 0/1/2/3 into a native chat body and drives the chat client. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { MappingRegistry, type MappingKey } from '../api/providers/mapping-registry.js';
import type { RequestPayloadParser } from './request-payload-parser.js';
import type { LayerConflictDetector } from './layer-conflict-detector.js';
import type { DefaultModelResolver } from './default-model-resolver.js';
import type { AssetPolicy } from './asset-policy.js';
import type { InvocationEnvelope } from './invocation-envelope.js';
import { withFieldRejectionHint } from './invocation-envelope.js';
import type { ChatClient } from '../api/providers/dashscope/chat-client.js';
import type { Layer2Assignment, SuccessEnvelope } from '../types/invocation-params.js';
import type { ChatContentPart, ChatStreamEvent } from '../types/chat.js';

const CHAT_COMMAND = 'chat create';
const CHAT_TASK_MODE = 'chat';

export interface ChatCreateInput {
  prompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  thinking?: boolean;
  image?: string;
  video?: string;
  request?: string;
}

export interface ChatServiceDeps {
  parser: RequestPayloadParser;
  conflictDetector: LayerConflictDetector;
  modelResolver: DefaultModelResolver;
  registry: MappingRegistry;
  assetPolicy: AssetPolicy;
  envelope: InvocationEnvelope;
  client: ChatClient;
  context: () => { site: string; account: string };
}

/** Register the sole OpenAI-compatible chat entry into a mapping registry. */
export function registerChatMappings(registry: MappingRegistry): void {
  registry.register({
    key: {
      command: CHAT_COMMAND,
      protocol: 'openai-compatible',
      modelFamily: 'qwen',
      taskMode: CHAT_TASK_MODE,
    },
    fieldTemplates: {
      '--temperature': 'temperature',
      '--max-tokens': 'max_completion_tokens',
      '--stream': 'stream',
      '--thinking': 'enable_thinking',
      '--image': 'messages[].content[].image_url',
      '--video': 'messages[].content[].video_url',
    },
    capabilities: { streaming: true, asynchronous: false },
    filePolicy: { allowBase64: false, allowTempUpload: true },
  });
}

function modelFamily(model: string): string {
  const match = /^[a-z]+/i.exec(model.trim());
  return (match ? match[0] : model).toLowerCase();
}

/** Normalize a candidate model string; empty / whitespace-only becomes undefined. */
function usableModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read a `model` field explicitly present on a request body (not truthy-coerced). */
function bodyModel(body: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(body, 'model') ? body.model : undefined;
}

function invalidArg(message: string): CliError {
  return new CliError({
    code: 'INVALID_ARGUMENT',
    message,
    exitCode: EXIT_CODES.INVALID_ARGUMENT,
  });
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  private mappingKey(model: string): MappingKey {
    return {
      command: CHAT_COMMAND,
      protocol: 'openai-compatible',
      modelFamily: modelFamily(model),
      taskMode: CHAT_TASK_MODE,
    };
  }

  private layer2Assignments(input: ChatCreateInput): Layer2Assignment[] {
    const assignments: Layer2Assignment[] = [];
    if (input.temperature !== undefined) {
      assignments.push({ flag: '--temperature', paths: ['temperature', 'parameters.temperature'] });
    }
    if (input.maxTokens !== undefined) {
      assignments.push({
        flag: '--max-tokens',
        paths: ['max_completion_tokens', 'parameters.max_completion_tokens'],
      });
    }
    if (input.stream !== undefined) {
      assignments.push({ flag: '--stream', paths: ['stream'] });
    }
    if (input.thinking !== undefined) {
      assignments.push({
        flag: '--thinking',
        paths: ['enable_thinking', 'parameters.enable_thinking'],
      });
    }
    if (input.image !== undefined || input.video !== undefined) {
      assignments.push({
        flag: input.image !== undefined ? '--image' : '--video',
        paths: ['messages'],
      });
    }
    return assignments;
  }

  async buildRequest(input: ChatCreateInput): Promise<{
    model: string;
    body: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
  }> {
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.length > 0;
    const hasRequest = typeof input.request === 'string' && input.request.length > 0;

    if (!hasPrompt && !hasRequest) {
      throw invalidArg('Provide a prompt or a --request body for chat create.');
    }

    let body: Record<string, unknown> = {};
    if (hasRequest) {
      const parsed = this.deps.parser.parse(input.request as string);
      body = { ...parsed.body };
    }

    body = this.deps.conflictDetector.applyModelOverride(body, input.model);

    const requestHasMessages = Object.prototype.hasOwnProperty.call(body, 'messages');
    if (hasPrompt && requestHasMessages) {
      throw invalidArg('A prompt cannot be combined with request.messages. Use one or the other.');
    }

    const explicitModel = usableModel(input.model) ?? usableModel(bodyModel(body));

    const model = await this.deps.modelResolver.resolve(
      { command: CHAT_COMMAND, taskMode: CHAT_TASK_MODE },
      explicitModel,
    );
    body.model = model;

    this.deps.conflictDetector.assertNoConflict(this.layer2Assignments(input), body);

    let extraHeaders: Record<string, string> | undefined;
    if (hasPrompt && !requestHasMessages) {
      const built = await this.buildMessages(input, model);
      body.messages = built.messages;
      extraHeaders = built.extraHeaders;
    }

    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) {
      if (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0) {
        throw invalidArg('--max-tokens must be a positive integer.');
      }
      body.max_completion_tokens = input.maxTokens;
    }
    if (input.stream === true) body.stream = true;
    if (input.thinking !== undefined) body.enable_thinking = input.thinking;

    return { model, body, ...(extraHeaders ? { extraHeaders } : {}) };
  }

  private async buildMessages(
    input: ChatCreateInput,
    model: string,
  ): Promise<{
    messages: Array<{ role: string; content: string | ChatContentPart[] }>;
    extraHeaders?: Record<string, string>;
  }> {
    const prompt = input.prompt as string;
    const hasMedia = input.image !== undefined || input.video !== undefined;

    if (!hasMedia) {
      return { messages: [{ role: 'user', content: prompt }] };
    }

    const entry = this.deps.registry.require(this.mappingKey(model));
    const ctx = this.deps.context();
    const parts: ChatContentPart[] = [];
    let extraHeaders: Record<string, string> | undefined;

    if (input.image !== undefined) {
      const asset = await this.deps.assetPolicy.resolve(
        input.image,
        { site: ctx.site, account: ctx.account, model },
        entry.filePolicy,
      );
      parts.push({ type: 'image_url', image_url: { url: asset.url } });
      if (asset.extraHeaders) {
        extraHeaders = { ...extraHeaders, ...asset.extraHeaders };
      }
    }
    if (input.video !== undefined) {
      const asset = await this.deps.assetPolicy.resolve(
        input.video,
        { site: ctx.site, account: ctx.account, model },
        entry.filePolicy,
      );
      parts.push({ type: 'video_url', video_url: { url: asset.url } });
      if (asset.extraHeaders) {
        extraHeaders = { ...extraHeaders, ...asset.extraHeaders };
      }
    }

    parts.push({ type: 'text', text: prompt });
    return {
      messages: [{ role: 'user', content: parts }],
      ...(extraHeaders ? { extraHeaders } : {}),
    };
  }

  async create(input: ChatCreateInput): Promise<SuccessEnvelope> {
    const { model, body, extraHeaders } = await this.buildRequest(input);
    const upstream = await withFieldRejectionHint(model, () =>
      this.deps.client.create(body, extraHeaders),
    );
    return this.deps.envelope.success(
      this.extractData(upstream),
      this.extractMeta(upstream, model),
    );
  }

  async *createStream(input: ChatCreateInput): AsyncIterable<ChatStreamEvent> {
    const { body, extraHeaders } = await this.buildRequest(input);
    body.stream = true;
    yield* this.deps.client.createStream(body, extraHeaders);
  }

  /**
   * Reduce the upstream OpenAI-compatible payload to the PRD's chat `data`
   * shape: the assistant text plus its finish reason. The raw upstream body is
   * intentionally not passed through — the envelope is the CLI's stable
   * contract, and callers that need native fields use `--request` + the API.
   */
  private extractData(upstream: Record<string, unknown>): Record<string, unknown> {
    const choices = upstream.choices;
    const first =
      Array.isArray(choices) && choices.length > 0 && choices[0] && typeof choices[0] === 'object'
        ? (choices[0] as Record<string, unknown>)
        : undefined;
    const message =
      first && first.message && typeof first.message === 'object'
        ? (first.message as Record<string, unknown>)
        : undefined;

    const data: Record<string, unknown> = { content: readContent(message?.content) };

    const reasoning = message?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      data.reasoning_content = reasoning;
    }

    const toolCalls = message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      data.tool_calls = toolCalls;
    }

    if (typeof first?.finish_reason === 'string') {
      data.finish_reason = first.finish_reason;
    }

    return data;
  }

  private extractMeta(
    upstream: Record<string, unknown>,
    model: string,
  ): {
    requestId?: string;
    model?: string;
    usage?: Record<string, unknown>;
  } {
    const meta: { requestId?: string; model?: string; usage?: Record<string, unknown> } = {};
    if (typeof upstream.id === 'string' && upstream.id.length > 0) {
      meta.requestId = upstream.id;
    }
    // Prefer the model echoed by the backend; fall back to the resolved model
    // so `meta.model` is always populated for the caller.
    meta.model = typeof upstream.model === 'string' && upstream.model ? upstream.model : model;
    const rawUsage = upstream.usage;
    if (rawUsage && typeof rawUsage === 'object') {
      const record = rawUsage as Record<string, unknown>;
      const input = record.prompt_tokens;
      const output = record.completion_tokens;
      const total = record.total_tokens;
      if (typeof input === 'number' && typeof output === 'number' && typeof total === 'number') {
        meta.usage = { input_tokens: input, output_tokens: output, total_tokens: total };
      }
    }
    return meta;
  }
}

/** Read message content that may be a plain string or multimodal parts. */
function readContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}
