import { TaskClient } from './task-client.js';
import type { DashScopeTransport } from './transport.js';
import { MODEL3D_GENERATION_PATH } from './endpoints.js';

export { MODEL3D_GENERATION_PATH };

export interface Model3dClientDeps {
  transport: DashScopeTransport;
}

export class Model3dClient {
  private readonly tasks: TaskClient;

  constructor(deps: Model3dClientDeps) {
    this.tasks = new TaskClient({ transport: deps.transport });
  }

  submit(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.tasks.submit(MODEL3D_GENERATION_PATH, body, extraHeaders);
  }
}
