/**
 * Unit tests for AssetPolicy — the shared local-file and temporary-upload
 * strategy used by every modality command that accepts media input.
 *
 * Per specification a public URL is forwarded as-is; a local file is either
 * inlined as Base64 or temporarily uploaded, according to the policy attached
 * to the matched mapping entry. A temporary upload yields an object-storage URL
 * that requires an explicit resolve header. The upload cache key must include
 * at least the site, the account, the model and a fingerprint of the file
 * content, so that the same bytes are not uploaded twice while entries from a
 * different site, account or model are never reused.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AssetPolicy,
  OSS_RESOLVE_HEADER,
  type AssetPolicyDeps,
} from '../../src/services/asset-policy.js';
import type { FilePolicy } from '../../src/types/invocation-params.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';

const CTX = { site: 'qianwen', account: 'acct-1', model: 'wan2.7-i2v' };
const UPLOAD_ONLY: FilePolicy = { allowBase64: false, allowTempUpload: true };
const BASE64_ONLY: FilePolicy = { allowBase64: true, allowTempUpload: false };
const NEITHER: FilePolicy = { allowBase64: false, allowTempUpload: false };

function makeDeps(overrides: Partial<AssetPolicyDeps> = {}): AssetPolicyDeps {
  return {
    readFileBytes: () => Buffer.from('image-bytes'),
    fileExists: () => true,
    uploadTemp: vi.fn().mockResolvedValue('oss://bucket/tmp/a.png'),
    readCache: () => null,
    writeCache: () => undefined,
    ...overrides,
  };
}

describe('AssetPolicy', () => {
  describe('public URL passthrough', () => {
    it('forwards an https URL unchanged', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve(
        'https://mock-api.test.qianwenai.com/a.png',
        CTX,
        UPLOAD_ONLY,
      );

      expect(asset.url).toBe('https://mock-api.test.qianwenai.com/a.png');
      expect(asset.delivery).toBe('public-url');
    });

    it('forwards an http URL unchanged', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve(
        'http://mock-api.test.qianwenai.com/a.png',
        CTX,
        UPLOAD_ONLY,
      );

      expect(asset.delivery).toBe('public-url');
    });

    it('does not upload when given a public URL', async () => {
      const uploadTemp = vi.fn().mockResolvedValue('oss://bucket/tmp/a.png');
      const policy = new AssetPolicy(makeDeps({ uploadTemp }));

      await policy.resolve('https://mock-api.test.qianwenai.com/a.png', CTX, UPLOAD_ONLY);

      expect(uploadTemp).not.toHaveBeenCalled();
    });

    it('does not read the filesystem when given a public URL', async () => {
      const readFileBytes = vi.fn().mockReturnValue(Buffer.from('x'));
      const policy = new AssetPolicy(makeDeps({ readFileBytes }));

      await policy.resolve('https://mock-api.test.qianwenai.com/a.png', CTX, UPLOAD_ONLY);

      expect(readFileBytes).not.toHaveBeenCalled();
    });

    it('attaches no extra headers for a public URL', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve(
        'https://mock-api.test.qianwenai.com/a.png',
        CTX,
        UPLOAD_ONLY,
      );

      expect(asset.extraHeaders).toBeUndefined();
    });

    it('forwards an already uploaded object-storage URL and keeps the resolve header', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve('oss://bucket/existing.png', CTX, UPLOAD_ONLY);

      expect(asset.url).toBe('oss://bucket/existing.png');
      expect(asset.extraHeaders).toEqual({ [OSS_RESOLVE_HEADER]: 'enable' });
    });
  });

  describe('temporary upload', () => {
    it('uploads a local file and returns the object-storage URL', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve('/tmp/a.png', CTX, UPLOAD_ONLY);

      expect(asset.url).toBe('oss://bucket/tmp/a.png');
      expect(asset.delivery).toBe('temp-upload');
    });

    it('passes the target model to the upload so the URL is bound to it', async () => {
      const uploadTemp = vi.fn().mockResolvedValue('oss://bucket/tmp/a.png');
      const policy = new AssetPolicy(makeDeps({ uploadTemp }));

      await policy.resolve('/tmp/a.png', CTX, UPLOAD_ONLY);

      expect(uploadTemp).toHaveBeenCalledWith({ path: '/tmp/a.png', model: 'wan2.7-i2v' });
    });

    it('requires the resolve header on an uploaded URL', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve('/tmp/a.png', CTX, UPLOAD_ONLY);

      expect(asset.extraHeaders).toEqual({ [OSS_RESOLVE_HEADER]: 'enable' });
    });

    it('reuses a cached upload instead of uploading again', async () => {
      const uploadTemp = vi.fn().mockResolvedValue('oss://bucket/fresh.png');
      const policy = new AssetPolicy(
        makeDeps({ uploadTemp, readCache: () => 'oss://bucket/cached.png' }),
      );

      const asset = await policy.resolve('/tmp/a.png', CTX, UPLOAD_ONLY);

      expect(asset.url).toBe('oss://bucket/cached.png');
      expect(uploadTemp).not.toHaveBeenCalled();
    });

    it('persists a fresh upload under the computed cache key', async () => {
      const writeCache = vi.fn();
      const policy = new AssetPolicy(makeDeps({ writeCache }));

      await policy.resolve('/tmp/a.png', CTX, UPLOAD_ONLY);

      expect(writeCache).toHaveBeenCalledTimes(1);
      const [, cachedUrl] = writeCache.mock.calls[0] as [string, string];
      expect(cachedUrl).toBe('oss://bucket/tmp/a.png');
    });

    it('stores the upload under the same key the lookup used', async () => {
      const readCache = vi.fn().mockReturnValue(null);
      const writeCache = vi.fn();
      const policy = new AssetPolicy(makeDeps({ readCache, writeCache }));

      await policy.resolve('/tmp/a.png', CTX, UPLOAD_ONLY);

      const [readKey] = readCache.mock.calls[0] as [string];
      const [writeKey] = writeCache.mock.calls[0] as [string, string];
      expect(writeKey).toBe(readKey);
    });
  });

  describe('base64 inlining', () => {
    it('inlines a local file when only base64 is allowed', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve('/tmp/a.png', CTX, BASE64_ONLY);

      expect(asset.delivery).toBe('base64');
    });

    it('does not upload when base64 is the selected delivery', async () => {
      const uploadTemp = vi.fn().mockResolvedValue('oss://bucket/tmp/a.png');
      const policy = new AssetPolicy(makeDeps({ uploadTemp }));

      await policy.resolve('/tmp/a.png', CTX, BASE64_ONLY);

      expect(uploadTemp).not.toHaveBeenCalled();
    });

    it('encodes the actual file bytes', async () => {
      const policy = new AssetPolicy(makeDeps({ readFileBytes: () => Buffer.from('hello-bytes') }));

      const asset = await policy.resolve('/tmp/a.png', CTX, BASE64_ONLY);

      expect(asset.url).toContain(Buffer.from('hello-bytes').toString('base64'));
    });

    it('prefers temporary upload when the policy allows both deliveries', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve('/tmp/a.png', CTX, {
        allowBase64: true,
        allowTempUpload: true,
      });

      expect(asset.delivery).toBe('temp-upload');
    });
  });

  describe('cache key isolation', () => {
    it('includes the site in the key', () => {
      const policy = new AssetPolicy(makeDeps());

      const a = policy.buildCacheKey(CTX, 'fp-1');
      const b = policy.buildCacheKey({ ...CTX, site: 'other-site' }, 'fp-1');

      expect(a).not.toBe(b);
    });

    it('includes the account in the key', () => {
      const policy = new AssetPolicy(makeDeps());

      const a = policy.buildCacheKey(CTX, 'fp-1');
      const b = policy.buildCacheKey({ ...CTX, account: 'acct-2' }, 'fp-1');

      expect(a).not.toBe(b);
    });

    it('includes the model in the key', () => {
      const policy = new AssetPolicy(makeDeps());

      const a = policy.buildCacheKey(CTX, 'fp-1');
      const b = policy.buildCacheKey({ ...CTX, model: 'tripo-p1.0' }, 'fp-1');

      expect(a).not.toBe(b);
    });

    it('includes the file fingerprint in the key', () => {
      const policy = new AssetPolicy(makeDeps());

      const a = policy.buildCacheKey(CTX, 'fp-1');
      const b = policy.buildCacheKey(CTX, 'fp-2');

      expect(a).not.toBe(b);
    });

    it('is stable for identical inputs', () => {
      const policy = new AssetPolicy(makeDeps());

      expect(policy.buildCacheKey(CTX, 'fp-1')).toBe(policy.buildCacheKey(CTX, 'fp-1'));
    });

    it('does not reuse an upload cached against a different model', async () => {
      const seen: string[] = [];
      const policy = new AssetPolicy(
        makeDeps({
          readCache: (key: string) => {
            seen.push(key);
            return null;
          },
        }),
      );

      await policy.resolve('/tmp/a.png', CTX, UPLOAD_ONLY);
      await policy.resolve('/tmp/a.png', { ...CTX, model: 'other-model' }, UPLOAD_ONLY);

      expect(seen[0]).not.toBe(seen[1]);
    });
  });

  describe('fingerprint', () => {
    it('produces the same fingerprint for identical bytes', () => {
      const policy = new AssetPolicy(makeDeps());

      expect(policy.fingerprint(Buffer.from('abc'))).toBe(policy.fingerprint(Buffer.from('abc')));
    });

    it('produces different fingerprints for different bytes', () => {
      const policy = new AssetPolicy(makeDeps());

      expect(policy.fingerprint(Buffer.from('abc'))).not.toBe(
        policy.fingerprint(Buffer.from('abd')),
      );
    });

    it('produces a non-empty fingerprint for empty content', () => {
      const policy = new AssetPolicy(makeDeps());

      expect(policy.fingerprint(Buffer.alloc(0)).length).toBeGreaterThan(0);
    });
  });

  describe('argument errors', () => {
    it('rejects a local path that does not exist', async () => {
      const policy = new AssetPolicy(makeDeps({ fileExists: () => false }));

      await expect(policy.resolve('/tmp/missing.png', CTX, UPLOAD_ONLY)).rejects.toBeInstanceOf(
        CliError,
      );
    });

    it('uses the argument exit code for a missing local file', async () => {
      const policy = new AssetPolicy(makeDeps({ fileExists: () => false }));

      try {
        await policy.resolve('/tmp/missing.png', CTX, UPLOAD_ONLY);
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('names the offending path in the missing-file message', async () => {
      const policy = new AssetPolicy(makeDeps({ fileExists: () => false }));

      try {
        await policy.resolve('/tmp/missing.png', CTX, UPLOAD_ONLY);
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).message).toContain('/tmp/missing.png');
      }
    });

    it('rejects a local file when neither delivery is permitted', async () => {
      const policy = new AssetPolicy(makeDeps());

      try {
        await policy.resolve('/tmp/a.png', CTX, NEITHER);
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('suggests supplying a public URL when no local delivery is permitted', async () => {
      const policy = new AssetPolicy(makeDeps());

      try {
        await policy.resolve('/tmp/a.png', CTX, NEITHER);
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).message).toContain('URL');
      }
    });

    it('still forwards a public URL when no local delivery is permitted', async () => {
      const policy = new AssetPolicy(makeDeps());

      const asset = await policy.resolve('https://mock-api.test.qianwenai.com/a.png', CTX, NEITHER);

      expect(asset.delivery).toBe('public-url');
    });
  });
});
