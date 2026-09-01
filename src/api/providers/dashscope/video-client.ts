/** Asynchronous video-synthesis submit boundary over the shared inference transport. */

import { TaskClient } from './task-client.js';
import type { DashScopeTransport } from './transport.js';
import { VIDEO_SYNTHESIS_PATH } from './endpoints.js';

export { VIDEO_SYNTHESIS_PATH };

export interface VideoClientDeps {
  transport: DashScopeTransport;
}

export class VideoClient {
  private readonly tasks: TaskClient;

  constructor(deps: VideoClientDeps) {
    this.tasks = new TaskClient({ transport: deps.transport });
  }

  submit(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.tasks.submit(VIDEO_SYNTHESIS_PATH, body, extraHeaders);
  }
}
