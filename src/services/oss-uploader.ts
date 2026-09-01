/** Temporary multimodal file upload via OSS multipart endpoint. */

import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { site, tokenPlanLocalUploadMessage } from '../site.js';
import { UPLOAD_POLICY_PATH } from '../api/providers/dashscope/endpoints.js';
import { isTokenPlanToken } from './endpoint-resolver.js';
import type { OssUploadOptions, UploadPolicy, UploadResult } from '../types/file-input.js';

/** Rejects local uploads for Token Plan keys, which accept media only as a URL. */
export function assertLocalUploadSupported(token: string | undefined): void {
  if (isTokenPlanToken(token)) {
    throw new CliError({
      code: 'LOCAL_UPLOAD_UNSUPPORTED',
      message: tokenPlanLocalUploadMessage(),
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
}

export interface OssUploaderDeps {
  fetchImpl?: typeof fetch;
  defaultEndpoint?: string;
}

export class OssUploader {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultEndpoint: string;

  constructor(deps: OssUploaderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.defaultEndpoint = deps.defaultEndpoint ?? site.dashscopeEndpoint;
  }

  /** Upload a local file and return the canonical `oss://` URL. */
  async upload(localPath: string, options: OssUploadOptions): Promise<UploadResult> {
    const filename = basename(localPath);
    let size: number;
    try {
      size = statSync(localPath).size;
    } catch {
      throw new CliError({
        code: 'FILE_NOT_FOUND',
        message: `File not accessible: ${localPath}`,
        exitCode: EXIT_CODES.INVALID_ARGUMENT,
      });
    }

    const policy = await this.getPolicy(options);

    const limitBytes = (policy.max_file_size_mb ?? 0) * 1024 * 1024;
    // A 0-byte limit is meaningful (the gateway uses it to forbid uploads
    // for the requested model), so the check fires whenever the file has
    // any content — even when `max_file_size_mb === 0`.
    if (size > limitBytes) {
      const sizeMb = (size / 1024 / 1024).toFixed(2);
      throw new CliError({
        code: 'FILE_TOO_LARGE',
        message:
          `File size exceeds limit: ${sizeMb} MB > ${policy.max_file_size_mb} MB ` +
          `(file: ${localPath})`,
        exitCode: EXIT_CODES.INVALID_ARGUMENT,
      });
    }

    // Derive the canonical object key from upload_dir + filename when
    // the policy did not pin a per-request key, mirroring the gateway's
    // own behaviour. Some products return an `upload_dir` whose final
    // segment is a per-request UUID without a trailing slash; concatenating
    // the filename verbatim then collapses the boundary and the gateway
    // rejects the resulting object key with "InvalidParameter: Failed to
    // download". `joinDirAndFilename` enforces exactly one separator.
    const effectiveKey =
      policy.key && policy.key.length > 0
        ? policy.key
        : joinDirAndFilename(policy.upload_dir, filename);
    const effectivePolicy: UploadPolicy = { ...policy, key: effectiveKey };

    await this.uploadToHost(localPath, effectivePolicy, options);

    const ossUrl = `oss://${stripLeadingSlash(effectiveKey)}`;
    return { ossUrl, filename, size };
  }

  /** Fetch and validate the upload policy from the gateway. */
  private async getPolicy(options: OssUploadOptions): Promise<UploadPolicy> {
    const endpoint = (options.endpoint ?? this.defaultEndpoint).replace(/\/+$/, '');
    const url = `${endpoint}${UPLOAD_POLICY_PATH}?action=getPolicy&model=${encodeURIComponent(
      options.model,
    )}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    };
    if (options.userAgent) headers['User-Agent'] = options.userAgent;

    let response: Response;
    try {
      const init: RequestInit = { method: 'GET', headers };
      if (options.signal) init.signal = options.signal;
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new CliError({
        code: 'POLICY_REQUEST_FAILED',
        message: `Failed to get upload policy: ${describeError(err)}`,
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CliError({
        code: 'POLICY_REQUEST_FAILED',
        message:
          `Failed to get upload policy (HTTP ${response.status})` +
          (text ? `: ${text.slice(0, 200)}` : ''),
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new CliError({
        code: 'POLICY_REQUEST_FAILED',
        message: `Failed to parse upload policy response: ${describeError(err)}`,
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }

    const policy = normalizePolicy(parsed);
    if (!policy) {
      throw new CliError({
        code: 'POLICY_REQUEST_FAILED',
        message: 'Upload policy response is missing required fields.',
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }
    return policy;
  }

  /** POST the local file to the upload host using the signed policy. */
  private async uploadToHost(
    localPath: string,
    policy: UploadPolicy,
    options: OssUploadOptions,
  ): Promise<void> {
    const filename = basename(localPath);
    const form = new FormData();
    form.append('key', policy.key);
    form.append('OSSAccessKeyId', policy.OSSAccessKeyId);
    form.append('policy', policy.policy);
    form.append('signature', policy.signature);
    form.append('success_action_status', '200');
    if (policy.x_oss_object_acl) {
      form.append('x-oss-object-acl', policy.x_oss_object_acl);
    }
    if (policy.x_oss_forbid_overwrite) {
      form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
    }

    let blob: Blob;
    try {
      blob = await readFileAsBlob(localPath);
    } catch (err) {
      throw new CliError({
        code: 'UPLOAD_FAILED',
        message: `Failed to read file for upload: ${describeError(err)}`,
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }
    form.append('file', blob, filename);

    let response: Response;
    try {
      const init: RequestInit = { method: 'POST', body: form };
      if (options.signal) init.signal = options.signal;
      if (options.userAgent) {
        init.headers = { 'User-Agent': options.userAgent };
      }
      response = await this.fetchImpl(policy.upload_host, init);
    } catch (err) {
      throw new CliError({
        code: 'UPLOAD_FAILED',
        message: `Failed to upload to OSS: ${describeError(err)}`,
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CliError({
        code: 'UPLOAD_FAILED',
        message:
          `Failed to upload to OSS (HTTP ${response.status})` +
          (text ? `: ${text.slice(0, 200)}` : ''),
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }
  }
}

/** Read a file's contents into a Blob for multipart upload. */
async function readFileAsBlob(path: string): Promise<Blob> {
  // Prefer the streaming path: createReadStream + chunked accumulation
  // keeps peak memory bounded for sizable inputs.
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const buffer = Buffer.concat(chunks);
  return new Blob([buffer]);
}

function normalizePolicy(raw: unknown): UploadPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  // Tolerate an outer envelope: real DashScope responses wrap the policy
  // in `{ data: { ... } }` while the documented shape is unwrapped.
  let r = raw as Record<string, unknown>;
  const inner = r.data;
  if (inner && typeof inner === 'object') {
    r = inner as Record<string, unknown>;
  }

  const upload_host = pickString(r.upload_host);
  const upload_dir = pickString(r.upload_dir);
  // `key` is optional: when absent it is derived as `${upload_dir}${filename}`
  // by the upload step.
  const key = pickString(r.key) ?? '';
  const OSSAccessKeyId = pickString(r.OSSAccessKeyId ?? r.ossaccesskeyid ?? r.oss_access_key_id);
  const signature = pickString(r.signature);
  const policy = pickString(r.policy);
  const x_oss_object_acl = pickString(r['x-oss-object-acl'] ?? r.x_oss_object_acl);
  const x_oss_forbid_overwrite = pickString(
    r['x-oss-forbid-overwrite'] ?? r.x_oss_forbid_overwrite,
  );
  if (!upload_host || !upload_dir || !OSSAccessKeyId || !signature || !policy) {
    return null;
  }
  return {
    upload_host,
    upload_dir,
    key,
    OSSAccessKeyId,
    signature,
    policy,
    max_file_size_mb: pickNumber(r.max_file_size_mb) ?? 0,
    expires_in: pickNumber(r.expires_in ?? r.expire_in_seconds) ?? 0,
    ...(x_oss_object_acl ? { x_oss_object_acl } : {}),
    ...(x_oss_forbid_overwrite ? { x_oss_forbid_overwrite } : {}),
  };
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function stripLeadingSlash(input: string): string {
  return input.startsWith('/') ? input.slice(1) : input;
}

/**
 * Join an OSS upload directory with a filename, guaranteeing exactly one
 * `/` separator regardless of whether the directory carries a trailing
 * slash. Leading slashes on the directory are stripped so the resulting
 * key is suitable for both the multipart `key` form field and the
 * `oss://...` URL projection.
 */
function joinDirAndFilename(dir: string, filename: string): string {
  const cleanDir = stripLeadingSlash(dir);
  if (cleanDir.length === 0) return filename;
  return cleanDir.endsWith('/') ? `${cleanDir}${filename}` : `${cleanDir}/${filename}`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
