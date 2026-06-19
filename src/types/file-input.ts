/**
 * Type definitions for the multimodal file input pipeline used by the
 * `run` command: classification of a user-supplied resource string,
 * temporary upload policy descriptors, and the canonical post-upload
 * result projected back into a content block URL.
 */

export type FileResourceType = 'local' | 'http' | 'oss';

export type FileModality = 'image' | 'video' | 'audio';

/**
 * Raw policy payload returned by the temporary upload service. Field
 * naming mirrors the upstream JSON exactly so the structure can be
 * passed straight into multipart construction.
 */
export interface UploadPolicy {
  upload_host: string;
  upload_dir: string;
  key: string;
  OSSAccessKeyId: string;
  signature: string;
  policy: string;
  max_file_size_mb: number;
  expires_in: number;
  x_oss_object_acl?: string;
  x_oss_forbid_overwrite?: string;
}

/**
 * Result of a successful file upload. `ossUrl` is the canonical
 * `oss://{upload_dir}{filename}` form that downstream content blocks
 * embed verbatim.
 */
export interface UploadResult {
  ossUrl: string;
  filename: string;
  size: number;
}

/**
 * Inputs required to run an upload. The model id is forwarded to
 * `getPolicy` so the gateway can scope policies per model family.
 */
export interface OssUploadOptions {
  model: string;
  apiKey: string;
  endpoint?: string;
  userAgent?: string;
  signal?: AbortSignal;
}

/**
 * A resource entry produced by file-input pre-processing. Either an
 * already-public URL (http/oss) or the post-upload URL of a previously
 * local file. Each entry carries its detected modality so the
 * subsequent content-block builder can pick the right block shape.
 */
export interface FileResource {
  url: string;
  modality: FileModality;
  source: FileResourceType;
}

/**
 * Per-file upload progress event emitted by the file-input pipeline.
 * The command layer subscribes to render TTY feedback; non-interactive
 * callers may omit the callback entirely.
 */
export interface UploadProgress {
  phase: 'start' | 'done' | 'error';
  index: number;
  total: number;
  filename: string;
  size: number;
  ossUrl?: string;
  error?: string;
}

export type UploadProgressCallback = (progress: UploadProgress) => void;
