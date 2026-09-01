/** Shared types for the four-tier parameter model used by model-invocation commands. */

export type RequestSource = 'inline' | 'file' | 'stdin';

export interface ParsedRequest {
  body: Record<string, unknown>;
  source: RequestSource;
}

/** A convenience flag together with the native field paths it occupies. */
export interface Layer2Assignment {
  flag: string;
  paths: string[];
}

export interface ConflictReport {
  conflicts: Array<{ flag: string; path: string }>;
}

export interface SuccessEnvelope {
  // `model` echoes the model that actually served the request; `usage` is
  // modality-specific (chat reports *_tokens, image reports image_count/size,
  // TTS reports characters) so it stays an open record here.
  meta: { request_id?: string; model?: string; usage?: Record<string, unknown> };
  data: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    model?: string;
    hint?: string;
    exit_code: number;
  };
}

/** How a media input may reach the upstream model. */
export type AssetDelivery = 'public-url' | 'base64' | 'temp-upload';

export interface FilePolicy {
  allowBase64: boolean;
  allowTempUpload: boolean;
}

export interface UploadedAsset {
  url: string;
  delivery: AssetDelivery;
  extraHeaders?: Record<string, string>;
}
