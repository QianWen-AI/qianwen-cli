/** `chat create` — single-turn chat with tier 2 convenience flags and tier 3 passthrough. */

import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import {
  metaFooter,
  readString,
  renderInvocation,
  tokenSegment,
  emptyContentHint,
} from '../../output/invocation-view.js';
import { NdjsonWriter } from '../../output/ndjson.js';
import { handleError, CliError } from '../../utils/errors.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { createChatService } from '../../services/chat-runtime.js';
import type { ChatCreateInput } from '../../services/chat-service.js';
import type { ResolvedFormat } from '../../types/config.js';
import type { SuccessEnvelope } from '../../types/invocation-params.js';
import { theme } from '../../ui/theme.js';

function coerceTemperature(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid value "${raw}" for --temperature. Must be a number.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
  return value;
}

function coerceMaxTokens(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid value "${raw}" for --max-tokens. Must be a positive integer.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
  return value;
}

export function chatCreateAction(
  cmd: Command,
): (this: Command, prompt: string | undefined, options: Record<string, unknown>) => Promise<void> {
  return async function (
    this: Command,
    prompt: string | undefined,
    options: Record<string, unknown>,
  ) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      const input: ChatCreateInput = {};
      if (typeof prompt === 'string' && prompt.length > 0) input.prompt = prompt;
      if (typeof options.model === 'string') input.model = options.model;
      if (typeof options.temperature === 'string') {
        input.temperature = coerceTemperature(options.temperature);
      }
      if (typeof options.maxTokens === 'string') {
        input.maxTokens = coerceMaxTokens(options.maxTokens);
      }
      const stream = resolveStream(options.stream);
      if (stream) input.stream = true;
      if (typeof options.thinking === 'boolean') input.thinking = options.thinking;
      if (typeof options.image === 'string') input.image = options.image;
      if (typeof options.video === 'string') input.video = options.video;
      if (typeof options.request === 'string') input.request = options.request;

      ensureAuthenticated();
      const runtimeOptions: { apiKey?: string } = {};
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createChatService(runtimeOptions);

      if (stream) {
        await runStream(service, input, options.thinking === true, format);
        return;
      }

      const envelope = await service.create(input);
      renderEnvelope(envelope, format, options.thinking === true);
    } catch (error) {
      handleError(error, format);
    }
  };
}

/**
 * Resolve streaming: an explicit `--stream` wins; otherwise stream when
 * stdout is an interactive terminal.
 */
function resolveStream(flag: unknown): boolean {
  if (flag === true) return true;
  return Boolean(process.stdout.isTTY);
}

/**
 * Render a non-streaming chat result.
 * - json: the success envelope (meta + data) for Agent pipelines.
 * - text / table: the assistant's answer followed by a dim meta footer, per
 *   the PRD output examples. Thinking stays hidden unless --thinking is set.
 */
function renderEnvelope(
  envelope: SuccessEnvelope,
  format: ResolvedFormat,
  revealThinking: boolean,
): void {
  renderInvocation(envelope, format, (data, meta) => {
    const content = readString(data, 'content') ?? '';
    const reasoning = revealThinking ? readString(data, 'reasoning_content') : undefined;
    if (format !== 'json') {
      const hint = emptyContentHint(content, readString(data, 'finish_reason'));
      if (hint !== undefined) process.stderr.write(`${theme.warning(hint)}\n`);
    }
    return {
      body: reasoning !== undefined ? `${theme.dim(reasoning)}\n\n${content}` : content,
      footerExtras: [tokenSegment(meta.usage)],
    };
  });
}

async function runStream(
  service: ReturnType<typeof createChatService>,
  input: ChatCreateInput,
  revealThinking: boolean,
  format: ResolvedFormat,
): Promise<void> {
  const writer = new NdjsonWriter({ write: (line) => process.stdout.write(line) });
  let requestId: string | undefined;
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let sawContent = false;

  for await (const event of service.createStream(input)) {
    if (event.requestId !== undefined && requestId === undefined) requestId = event.requestId;
    if (event.model !== undefined && model === undefined) model = event.model;
    if (event.finishReason !== undefined) finishReason = event.finishReason;

    if (event.type === 'error') {
      if (format !== 'json') process.stdout.write('\n');
      throw new CliError({
        code: event.error?.code ?? 'UNKNOWN_ERROR',
        message: event.error?.message ?? 'Streaming failed',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    if (event.type === 'usage') {
      if (event.usage !== undefined) {
        usage = {
          input_tokens: event.usage.input,
          output_tokens: event.usage.output,
          total_tokens: event.usage.total,
        };
      }
      continue;
    }
    if (event.type === 'done') continue;
    if (event.type === 'reasoning' && !revealThinking) continue;
    // Per the PRD each streamed line carries the *incremental* text under
    // `delta`; concatenating deltas in order reproduces the full answer.
    const delta = event.type === 'reasoning' ? event.reasoning : event.content;
    if (delta === undefined || delta.length === 0) continue;
    if (event.type === 'content') sawContent = true;

    if (format === 'json') {
      writer.writeLine(event.type === 'reasoning' ? { delta, reasoning: true } : { delta });
    } else {
      // Human view: emit the incremental text as it arrives (typewriter
      // effect) rather than one JSON object per chunk.
      process.stdout.write(event.type === 'reasoning' ? theme.dim(delta) : delta);
    }
  }

  if (format === 'json') {
    const trailer: {
      request_id?: string;
      model?: string;
      finish_reason?: string;
      usage?: Record<string, unknown>;
    } = {};
    if (requestId !== undefined) trailer.request_id = requestId;
    if (model !== undefined) trailer.model = model;
    if (finishReason !== undefined) trailer.finish_reason = finishReason;
    if (usage !== undefined) trailer.usage = usage;
    writer.writeTrailer(trailer);
    return;
  }

  const hint = emptyContentHint(sawContent ? 'x' : '', finishReason);
  if (hint !== undefined) process.stderr.write(`${theme.warning(hint)}\n`);

  const footer = metaFooter(
    {
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      ...(model !== undefined ? { model } : {}),
    },
    [tokenSegment(usage)],
  );
  process.stdout.write(footer !== undefined ? `\n\n${theme.dim(footer)}\n` : '\n');
}

export function registerChatCreateCommand(parent: Command): Command {
  const create = parent
    .command('create [prompt]')
    .description('Create a single-turn chat completion')
    .option('--model <id>', 'Model to use (tier 1)')
    .option('--temperature <n>', 'Sampling temperature (tier 2)')
    .option('--max-tokens <n>', 'Total output token budget (tier 2)')
    .option('--stream', 'Stream the response (default on an interactive terminal)')
    .option('--thinking', 'Reveal the model reasoning')
    .option('--no-thinking', 'Hide the model reasoning')
    .option('--image <path-or-url>', 'Attach one image for vision models (tier 2)')
    .option('--video <path-or-url>', 'Attach one video for vision models (tier 2)')
    .option('--request <json|@file|->', 'Native request body passthrough (tier 3)')
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  create.action(chatCreateAction(create));
  return create;
}
