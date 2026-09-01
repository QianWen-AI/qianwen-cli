/** Provider abstraction shared by every modality command. */

import type {
  InvocationRequest,
  InvocationResponse,
  OutputModality,
  StreamChunk,
  TaskSubmitResult,
} from '../../types/model-invocation.js';

export interface ProviderConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface ProviderInvokeOptions {
  timeoutMs?: number;
  stream?: boolean;
}

export interface ProviderCapabilities {
  modalities: OutputModality[];
  streaming: boolean;
  asynchronous: boolean;
}

export interface ModelProvider {
  readonly name: string;
  capabilities(): ProviderCapabilities;
  invoke(request: InvocationRequest, options?: ProviderInvokeOptions): Promise<InvocationResponse>;
  invokeStream?(
    request: InvocationRequest,
    options?: ProviderInvokeOptions,
  ): AsyncIterable<StreamChunk>;
  submitTask?(
    request: InvocationRequest,
    options?: ProviderInvokeOptions,
  ): Promise<TaskSubmitResult>;
}
