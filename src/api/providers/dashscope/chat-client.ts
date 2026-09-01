/** Chat-completions boundary over the shared inference transport. */

import type { DashScopeTransport } from './transport.js';
import type { ChatStreamEvent } from '../../../types/chat.js';
import type { NormalizedError, TokenUsage } from '../../../types/model-invocation.js';
import { CHAT_COMPLETIONS_PATH } from './endpoints.js';

export { CHAT_COMPLETIONS_PATH };

export interface ChatClientDeps {
  transport: DashScopeTransport;
}

/** Serialize a chat body with a fractional top-level `temperature`. */
export function serializeChatBody(body: Record<string, unknown>): string {
  const temperature = body.temperature;
  const needsFractional =
    typeof temperature === 'number' &&
    Number.isFinite(temperature) &&
    Number.isInteger(temperature);

  if (!needsFractional) return JSON.stringify(body);

  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === 'temperature') {
      const normalized = Object.is(value, -0) ? 0 : (value as number);
      parts.push(`${JSON.stringify(key)}:${normalized.toFixed(1)}`);
    } else {
      parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
    }
  }
  return `{${parts.join(',')}}`;
}

function normalizeStreamError(record: Record<string, unknown>): NormalizedError | undefined {
  const raw = record.error;
  if (!raw || typeof raw !== 'object') return undefined;
  const err = raw as Record<string, unknown>;
  const message = typeof err.message === 'string' && err.message ? err.message : undefined;
  if (message === undefined) return undefined;
  const code = typeof err.code === 'string' && err.code ? err.code : 'UNKNOWN_ERROR';
  return { code, message };
}

function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const input = record.prompt_tokens;
  const output = record.completion_tokens;
  const total = record.total_tokens;
  if (typeof input !== 'number' || typeof output !== 'number' || typeof total !== 'number') {
    return undefined;
  }
  return { input, output, total };
}

export class ChatClient {
  constructor(private readonly deps: ChatClientDeps) {}

  async create(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.deps.transport.request<Record<string, unknown>>({
      path: CHAT_COMPLETIONS_PATH,
      method: 'POST',
      rawBody: serializeChatBody(body),
      ...(extraHeaders ? { headers: extraHeaders } : {}),
    });
  }

  async *createStream(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): AsyncIterable<ChatStreamEvent> {
    const response = await this.deps.transport.requestRaw({
      path: CHAT_COMPLETIONS_PATH,
      method: 'POST',
      rawBody: serializeChatBody(body),
      stream: true,
      ...(extraHeaders ? { headers: extraHeaders } : {}),
    });

    const stream = response.body;
    if (!stream) return;

    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = '';
    let sawId = false;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          const event = this.parseLine(line, sawId);
          if (event === 'done') {
            yield { type: 'done' };
            return;
          }
          if (event) {
            if (event.requestId !== undefined) sawId = true;
            yield event;
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }

      const tail = this.parseLine(buffer, sawId);
      if (tail === 'done') {
        yield { type: 'done' };
      } else if (tail) {
        yield tail;
      }
    } finally {
      // Cancel (not releaseLock) so the transport tears down its idle timer and aborts the connection.
      await reader.cancel('stream ended').catch(() => {});
    }
  }

  private parseLine(rawLine: string, sawId: boolean): ChatStreamEvent | 'done' | null {
    const line = rawLine.trimEnd();
    if (line.length === 0) return null;
    if (!line.startsWith('data:')) return null;

    const data = line.slice('data:'.length).trim();
    if (data.length === 0) return null;
    if (data === '[DONE]') return 'done';

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const record = parsed as Record<string, unknown>;

    const error = normalizeStreamError(record);
    if (error) return { type: 'error', error };

    const usage = normalizeUsage(record.usage);
    if (usage) return { type: 'usage', usage };

    const choices = record.choices;
    const firstChoice =
      Array.isArray(choices) && choices.length > 0 && choices[0] && typeof choices[0] === 'object'
        ? (choices[0] as Record<string, unknown>)
        : undefined;
    const delta =
      firstChoice && firstChoice.delta && typeof firstChoice.delta === 'object'
        ? (firstChoice.delta as Record<string, unknown>)
        : undefined;

    const finishReason =
      firstChoice && typeof firstChoice.finish_reason === 'string' && firstChoice.finish_reason
        ? (firstChoice.finish_reason as string)
        : undefined;

    const requestId =
      !sawId && typeof record.id === 'string' && record.id ? (record.id as string) : undefined;

    const model = typeof record.model === 'string' && record.model ? record.model : undefined;

    if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
      const event: ChatStreamEvent = { type: 'content', content: delta.content };
      if (finishReason !== undefined) event.finishReason = finishReason;
      if (requestId !== undefined) event.requestId = requestId;
      if (model !== undefined) event.model = model;
      return event;
    }

    if (
      delta &&
      typeof delta.reasoning_content === 'string' &&
      delta.reasoning_content.length > 0
    ) {
      const event: ChatStreamEvent = { type: 'reasoning', reasoning: delta.reasoning_content };
      if (finishReason !== undefined) event.finishReason = finishReason;
      if (requestId !== undefined) event.requestId = requestId;
      if (model !== undefined) event.model = model;
      return event;
    }

    if (finishReason !== undefined || requestId !== undefined || model !== undefined) {
      const event: ChatStreamEvent = { type: 'content', content: '' };
      if (finishReason !== undefined) event.finishReason = finishReason;
      if (requestId !== undefined) event.requestId = requestId;
      if (model !== undefined) event.model = model;
      return event;
    }

    return null;
  }
}
