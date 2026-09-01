import type { DashScopeTransport } from './transport.js';
import { MUSIC_GENERATION_PATH } from './endpoints.js';

export { MUSIC_GENERATION_PATH };
export const SSE_ENABLE_HEADER = 'X-DashScope-SSE';

export interface MusicClientDeps {
  transport: DashScopeTransport;
}

export interface MusicStreamEvent {
  audioData?: string;
  url?: string;
  requestId?: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
  extraInfo?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export class MusicClient {
  constructor(private readonly deps: MusicClientDeps) {}

  async generate(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.deps.transport.request<Record<string, unknown>>({
      path: MUSIC_GENERATION_PATH,
      method: 'POST',
      body,
      ...(extraHeaders ? { headers: extraHeaders } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  async *generateStream(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    timeoutMs?: number,
  ): AsyncIterable<MusicStreamEvent> {
    const response = await this.deps.transport.requestRaw({
      path: MUSIC_GENERATION_PATH,
      method: 'POST',
      body,
      headers: { ...extraHeaders, [SSE_ENABLE_HEADER]: 'enable' },
      stream: true,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    const stream = response.body;
    if (!stream) return;
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = '';

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const event = this.parseLine(line);
          if (event) yield event;
          newlineIndex = buffer.indexOf('\n');
        }
      }

      const tail = this.parseLine(buffer);
      if (tail) yield tail;
    } finally {
      reader.releaseLock();
    }
  }

  private parseLine(rawLine: string): MusicStreamEvent | null {
    const line = rawLine.trimEnd();
    if (line.length === 0 || !line.startsWith('data:')) return null;
    const data = line.slice('data:'.length).trim();
    if (data.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
    const record = asRecord(parsed);
    if (!record) return null;
    const output = asRecord(record.output);
    const audio = asRecord(output?.audio);
    const event: MusicStreamEvent = {};
    if (typeof record.request_id === 'string' && record.request_id.length > 0) {
      event.requestId = record.request_id;
    }
    if (audio && typeof audio.data === 'string' && audio.data.length > 0) {
      event.audioData = audio.data;
    }
    if (audio && typeof audio.url === 'string' && audio.url.length > 0) {
      event.url = audio.url;
    }
    if (output && typeof output.finish_reason === 'string') {
      event.finishReason = output.finish_reason;
    }
    const usage = asRecord(record.usage);
    if (usage) event.usage = usage;
    const extraInfo = asRecord(output?.extra_info);
    if (extraInfo) event.extraInfo = extraInfo;
    return event;
  }
}
