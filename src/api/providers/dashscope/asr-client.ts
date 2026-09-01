/** Transcription boundary over the shared inference transport: async task submit and sync generation. */

import { TaskClient } from './task-client.js';
import type { DashScopeTransport } from './transport.js';
import { ASR_TRANSCRIPTION_PATH, MULTIMODAL_GENERATION_PATH } from './endpoints.js';

export { ASR_TRANSCRIPTION_PATH, MULTIMODAL_GENERATION_PATH };

export interface ASRClientDeps {
  transport: DashScopeTransport;
}

export class ASRClient {
  private readonly tasks: TaskClient;

  constructor(private readonly deps: ASRClientDeps) {
    this.tasks = new TaskClient({ transport: deps.transport });
  }

  submit(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.tasks.submit(ASR_TRANSCRIPTION_PATH, body, extraHeaders);
  }

  generate(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.deps.transport.request<Record<string, unknown>>({
      path: MULTIMODAL_GENERATION_PATH,
      method: 'POST',
      body,
      ...(extraHeaders ? { headers: extraHeaders } : {}),
    });
  }
}
