/**
 * Type definitions for the temporary multimodal upload pipeline: the signed
 * upload policy returned by the gateway, the canonical post-upload result,
 * and the options required to run an upload.
 */

/**
 * Raw policy payload returned by the temporary upload service. Field naming
 * mirrors the upstream JSON exactly so the structure can be passed straight
 * into multipart construction.
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
 * `oss://{upload_dir}{filename}` form that downstream content blocks embed
 * verbatim.
 */
export interface UploadResult {
  ossUrl: string;
  filename: string;
  size: number;
}

/**
 * Inputs required to run an upload. The model id is forwarded to `getPolicy`
 * so the gateway can scope policies per model family.
 */
export interface OssUploadOptions {
  model: string;
  apiKey: string;
  endpoint?: string;
  userAgent?: string;
  signal?: AbortSignal;
}
