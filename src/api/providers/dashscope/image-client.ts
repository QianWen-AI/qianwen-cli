import type { DashScopeTransport } from './transport.js';
import { TaskClient } from './task-client.js';
import { MULTIMODAL_GENERATION_PATH, IMAGE_ASYNC_SYNTHESIS_PATH } from './endpoints.js';

export const IMAGE_SYNTHESIS_PATH = MULTIMODAL_GENERATION_PATH;
export { IMAGE_ASYNC_SYNTHESIS_PATH };

export interface ImageClientDeps {
  transport: DashScopeTransport;
}

export class ImageClient {
  private readonly tasks: TaskClient;

  constructor(private readonly deps: ImageClientDeps) {
    this.tasks = new TaskClient({ transport: deps.transport });
  }

  async generate(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.deps.transport.request<Record<string, unknown>>({
      path: IMAGE_SYNTHESIS_PATH,
      method: 'POST',
      body,
      ...(extraHeaders ? { headers: extraHeaders } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  submit(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.tasks.submit(IMAGE_ASYNC_SYNTHESIS_PATH, body, extraHeaders);
  }
}
