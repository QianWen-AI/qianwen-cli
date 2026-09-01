/**
 * Integration test for the local-media temporary-upload wiring used by the
 * chat modality: AssetPolicy delegates a local file to OssUploader (which
 * performs getPolicy → OSS multipart POST → oss:// URL), and the resulting
 * oss:// URL flows back through AssetPolicy with the OSS resolve header.
 *
 * Mock boundary:
 *   - global fetch is stubbed (network). Both the getPolicy GET and the OSS
 *     multipart POST land on the same mock.
 *   - the local filesystem is REAL (OS tmpdir), so AssetPolicy's fingerprint
 *     read and OssUploader's statSync / streaming read are genuinely run.
 *   - AssetPolicy and OssUploader collaborate for real — neither's own
 *     orchestration is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetPolicy, OSS_RESOLVE_HEADER } from '../../src/services/asset-policy.js';
import { OssUploader } from '../../src/services/oss-uploader.js';

const mockFetch = vi.fn();
let workDir = '';

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  workDir = mkdtempSync(join(tmpdir(), 'qc-chat-up-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function makePolicyResponse(): Response {
  const body = {
    upload_host: 'https://qwen-cli-uploads.test.qianwenai.com',
    upload_dir: 'qwen-uploads/20260610/',
    key: '',
    OSSAccessKeyId: 'LTAI-mock',
    signature: 'sig==',
    policy: 'pol==',
    max_file_size_mb: 10,
    expires_in: 172800,
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: body }),
    text: async () => JSON.stringify({ data: body }),
  } as unknown as Response;
}

function makeUploadResponse(): Response {
  return {
    ok: true,
    status: 204,
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response;
}

function writeFile(name: string, size: number): string {
  const buf = new Uint8Array(size);
  const p = join(workDir, name);
  writeFileSync(p, buf);
  return p;
}

/**
 * Build an AssetPolicy wired exactly as the chat composition root wires it:
 * uploadTemp delegates to OssUploader.upload and returns its ossUrl.
 */
function makeWiredAssetPolicy(): AssetPolicy {
  const uploader = new OssUploader({
    defaultEndpoint: 'https://mock-dashscope.test.qianwenai.com',
  });
  return new AssetPolicy({
    readFileBytes: (path) => readFileSync(path),
    fileExists: (path) => existsSync(path) && statSync(path).isFile(),
    uploadTemp: async ({ path, model }) => {
      const result = await uploader.upload(path, {
        model,
        apiKey: 'sk-test',
        endpoint: 'https://mock-dashscope.test.qianwenai.com',
      });
      return result.ossUrl;
    },
    readCache: () => null,
    writeCache: () => {},
  });
}

describe('chat local-media upload wiring', () => {
  it('resolves a local file to an oss:// URL via OssUploader and tags temp-upload delivery', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockResolvedValueOnce(makeUploadResponse());
    const filePath = writeFile('test.png', 2048);
    const policy = makeWiredAssetPolicy();

    const asset = await policy.resolve(
      filePath,
      { site: 'qianwen', account: 'acct-1', model: 'qwen-vl-plus' },
      { allowBase64: false, allowTempUpload: true },
    );

    expect(asset.delivery).toBe('temp-upload');
    expect(asset.url).toMatch(/^oss:\/\/.+test\.png$/);
    expect(asset.extraHeaders?.[OSS_RESOLVE_HEADER]).toBe('enable');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not throw the not-available placeholder for a local file', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockResolvedValueOnce(makeUploadResponse());
    const filePath = writeFile('a.jpg', 16);
    const policy = makeWiredAssetPolicy();

    await expect(
      policy.resolve(
        filePath,
        { site: 'qianwen', account: 'acct-1', model: 'qwen-vl-plus' },
        { allowBase64: false, allowTempUpload: true },
      ),
    ).resolves.toMatchObject({ delivery: 'temp-upload' });
  });
});
