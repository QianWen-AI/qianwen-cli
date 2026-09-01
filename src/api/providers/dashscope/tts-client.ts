/** Synchronous speech-synthesis boundary over the shared inference transport. */

import type { DashScopeTransport } from './transport.js';
import { MULTIMODAL_GENERATION_PATH, COSYVOICE_SYNTHESIS_PATH } from './endpoints.js';

export const SPEECH_SYNTHESIS_PATH = MULTIMODAL_GENERATION_PATH;
export { COSYVOICE_SYNTHESIS_PATH };

export interface TTSClientDeps {
  transport: DashScopeTransport;
}

export class TTSClient {
  constructor(private readonly deps: TTSClientDeps) {}

  async generate(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    path: string = SPEECH_SYNTHESIS_PATH,
  ): Promise<Record<string, unknown>> {
    return this.deps.transport.request<Record<string, unknown>>({
      path,
      method: 'POST',
      body,
      ...(extraHeaders ? { headers: extraHeaders } : {}),
    });
  }
}
