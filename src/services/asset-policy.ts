/** Decides how a media input reaches the upstream model: public URL, Base64, or temporary upload. */

import { createHash } from 'crypto';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import type { FilePolicy, UploadedAsset } from '../types/invocation-params.js';

export const OSS_RESOLVE_HEADER = 'X-DashScope-OssResourceResolve';

const OSS_HEADERS: Record<string, string> = { [OSS_RESOLVE_HEADER]: 'enable' };

export interface AssetContext {
  site: string;
  account: string;
  model: string;
}

export interface AssetPolicyDeps {
  readFileBytes: (path: string) => Buffer;
  fileExists: (path: string) => boolean;
  uploadTemp: (input: { path: string; model: string }) => Promise<string>;
  readCache: (cacheKey: string) => string | null;
  writeCache: (cacheKey: string, url: string) => void;
}

function invalid(message: string): CliError {
  return new CliError({
    code: 'INVALID_ASSET_INPUT',
    message,
    exitCode: EXIT_CODES.INVALID_ARGUMENT,
  });
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isObjectStorageUrl(value: string): boolean {
  return /^oss:\/\//i.test(value);
}

export class AssetPolicy {
  constructor(private readonly deps: AssetPolicyDeps) {}

  async resolve(input: string, ctx: AssetContext, policy: FilePolicy): Promise<UploadedAsset> {
    if (isHttpUrl(input)) {
      return { url: input, delivery: 'public-url' };
    }

    if (isObjectStorageUrl(input)) {
      return { url: input, delivery: 'public-url', extraHeaders: { ...OSS_HEADERS } };
    }

    if (!this.deps.fileExists(input)) {
      throw invalid(`Input file not found: ${input}`);
    }

    if (policy.allowTempUpload) {
      const bytes = this.deps.readFileBytes(input);
      const cacheKey = this.buildCacheKey(ctx, this.fingerprint(bytes));

      const cached = this.deps.readCache(cacheKey);
      if (cached) {
        return { url: cached, delivery: 'temp-upload', extraHeaders: { ...OSS_HEADERS } };
      }

      const uploaded = await this.deps.uploadTemp({ path: input, model: ctx.model });
      this.deps.writeCache(cacheKey, uploaded);
      return { url: uploaded, delivery: 'temp-upload', extraHeaders: { ...OSS_HEADERS } };
    }

    if (policy.allowBase64) {
      const bytes = this.deps.readFileBytes(input);
      return { url: bytes.toString('base64'), delivery: 'base64' };
    }

    throw invalid(
      `The target model does not accept local files for this input. Provide a public URL instead: ${input}`,
    );
  }

  buildCacheKey(ctx: AssetContext, fingerprint: string): string {
    return ['asset', ctx.site, ctx.account, ctx.model, fingerprint].join(':');
  }

  fingerprint(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
