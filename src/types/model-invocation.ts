/** Shared types for model invocation across text, image, video, audio, and 3D modalities. */

export type OutputModality = 'text' | 'image' | 'video' | 'audio' | 'model3d' | 'music';

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export type CredentialSource = 'flag' | 'env' | 'config';

export interface ResolvedInvocationCredential {
  token: string;
  source: CredentialSource;
}

/** Upstream failure reduced to a stable shape; the message is passed through verbatim. */
export interface NormalizedError {
  code: string;
  message: string;
}

export interface InvocationRequest {
  model: string;
  /** Fully-formed native request body forwarded without field renaming. */
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface InvocationResponse {
  requestId?: string;
  usage?: TokenUsage;
  data: Record<string, unknown>;
}

export interface StreamChunk {
  type: 'content' | 'reasoning' | 'usage' | 'error' | 'done';
  content?: string;
  reasoning?: string;
  usage?: TokenUsage;
  error?: NormalizedError;
  finishReason?: string;
  requestId?: string;
  /** Model echoed by the backend on the first chunk, when present. */
  model?: string;
}

export interface TaskSubmitResult {
  taskId: string;
  requestId?: string;
  model?: string;
}

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';

export interface TaskStatusResult {
  taskId: string;
  status: TaskStatus;
  requestId?: string;
  /** Result artifact URLs, present once the task succeeds. */
  urls?: string[];
  error?: NormalizedError;
  raw: Record<string, unknown>;
}
