/** Async task boundary over the shared inference transport: submit, query, and normalize. */

import type { DashScopeTransport } from './transport.js';
import type { TaskStatus } from '../../../types/model-invocation.js';
import { TASK_QUERY_PATH_PREFIX } from './endpoints.js';

export { TASK_QUERY_PATH_PREFIX };
export const ASYNC_ENABLE_HEADER = 'X-DashScope-Async';

export interface TaskClientDeps {
  transport: DashScopeTransport;
}

const TERMINAL_FAILURE = new Set(['FAILED', 'CANCELED']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export class TaskClient {
  constructor(private readonly deps: TaskClientDeps) {}

  async submit(
    path: string,
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      [ASYNC_ENABLE_HEADER]: 'enable',
    };
    return this.deps.transport.request<Record<string, unknown>>({
      path,
      method: 'POST',
      body,
      headers,
    });
  }

  async get(taskId: string): Promise<Record<string, unknown>> {
    return this.deps.transport.request<Record<string, unknown>>({
      path: `${TASK_QUERY_PATH_PREFIX}${taskId}`,
      method: 'GET',
    });
  }

  extractTaskId(upstream: Record<string, unknown>): string | undefined {
    const output = asRecord(upstream.output);
    const fromOutput = output?.task_id;
    if (typeof fromOutput === 'string' && fromOutput.length > 0) return fromOutput;
    const topLevel = upstream.task_id;
    if (typeof topLevel === 'string' && topLevel.length > 0) return topLevel;
    return undefined;
  }

  normalizeStatus(upstream: Record<string, unknown>): TaskStatus {
    const output = asRecord(upstream.output);
    const raw = output?.task_status ?? upstream.task_status;
    if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
    const upper = raw.toUpperCase();
    if (upper === 'PENDING') return 'pending';
    if (upper === 'RUNNING') return 'running';
    if (upper === 'SUCCEEDED') return 'succeeded';
    if (TERMINAL_FAILURE.has(upper)) return 'failed';
    return 'unknown';
  }

  extractUrls(upstream: Record<string, unknown>): string[] {
    const output = asRecord(upstream.output);
    if (!output) return [];

    const results = output.results;
    if (Array.isArray(results)) {
      const urls: string[] = [];
      for (const item of results) {
        const record = asRecord(item);
        for (const candidate of [
          record?.url,
          record?.transcription_url,
          record?.pbr_model_url,
          record?.base_model_url,
          record?.rendered_image_url,
        ]) {
          if (typeof candidate === 'string' && candidate.length > 0) urls.push(candidate);
        }
      }
      if (urls.length > 0) return urls;
    }

    const videoUrl = output.video_url;
    if (typeof videoUrl === 'string' && videoUrl.length > 0) return [videoUrl];

    const transcriptionUrl = output.transcription_url;
    if (typeof transcriptionUrl === 'string' && transcriptionUrl.length > 0) {
      return [transcriptionUrl];
    }

    return [];
  }
}
