/**
 * Unit tests for OssUploader — DashScope temporary-upload orchestration:
 *   getPolicy → multipart POST to upload_host → oss:// URL extraction.
 *
 * Mock boundary:
 *   - global fetch is stubbed (network dep). Both the getPolicy GET and the
 *     subsequent multipart upload POST land on the same mock so we can
 *     verify call order, URLs, and form payload composition.
 *   - The local filesystem is REAL, under an OS tmpdir per test, so the
 *     SUT's fs.statSync / streaming read is genuinely exercised.
 *   - The SUT's URL extraction, size-limit check and error mapping logic
 *     are NOT mocked — they are the unit under test.
 *
 * The SUT MUST be invoked via OssUploader.upload(); assertions read the
 * returned UploadResult plus the captured mock-fetch calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OssUploader, assertLocalUploadSupported } from '../../src/services/oss-uploader.js';

// ────────────────────────────────────────────────────────────────────
// Helpers / fixtures
// ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
let workDir = '';

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  workDir = mkdtempSync(join(tmpdir(), 'qc-oss-up-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

interface PolicyResponseShape {
  upload_host: string;
  upload_dir: string;
  key: string;
  OSSAccessKeyId: string;
  signature: string;
  policy: string;
  max_file_size_mb: number;
  expires_in: number;
  bucket?: string;
  'x-oss-object-acl'?: string;
  'x-oss-forbid-overwrite'?: string;
}

const DEFAULT_POLICY: PolicyResponseShape = {
  upload_host: 'https://qwen-cli-uploads.test.qianwenai.com',
  upload_dir: 'qwen-uploads/20260610/',
  key: 'qwen-uploads/20260610/photo_xxx.jpg',
  OSSAccessKeyId: 'LTAI-mock-access-key',
  signature: 'mock-signature-base64==',
  policy: 'mock-policy-base64==',
  max_file_size_mb: 10,
  expires_in: 172800,
  bucket: 'qwen-cli-uploads',
  'x-oss-object-acl': 'private',
  'x-oss-forbid-overwrite': 'true',
};

function makePolicyResponse(overrides: Partial<PolicyResponseShape> = {}): Response {
  const body = { ...DEFAULT_POLICY, ...overrides };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ data: body }),
    text: async () => JSON.stringify({ data: body }),
  } as unknown as Response;
}

function makeUploadResponse(status = 204): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 204 ? 'No Content' : 'OK',
    headers: new Headers(),
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response;
}

function makeFailedResponse(status: number, body = 'error'): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: async () => body,
    json: async () => ({ error: body }),
  } as unknown as Response;
}

function writeBinaryFile(name: string, sizeBytes: number): string {
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buf[i] = i & 0xff;
  const p = join(workDir, name);
  writeFileSync(p, buf);
  return p;
}

function buildUploader(): OssUploader {
  return new OssUploader();
}

// ────────────────────────────────────────────────────────────────────
// Happy path — getPolicy + multipart upload + oss:// extraction
// ────────────────────────────────────────────────────────────────────

describe('OssUploader.upload — happy path', () => {
  it('returns an oss:// URL together with the basename and size on success', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('photo.jpg', 2048);
    const uploader = buildUploader();

    const result = await uploader.upload(filePath, {
      model: 'qwen-vl-plus',
      apiKey: 'sk-test-token-001',
      endpoint: 'https://mock-dashscope.test.qianwenai.com',
    });

    expect(result.ossUrl).toMatch(/^oss:\/\/.+/);
    expect(result.filename).toBe('photo.jpg');
    expect(result.size).toBe(2048);
  });

  it('issues exactly two fetch calls: getPolicy then multipart upload', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('a.png', 16);
    const uploader = buildUploader();

    await uploader.upload(filePath, {
      model: 'qwen-vl-plus',
      apiKey: 'sk-x',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('first fetch targets getPolicy with the model id in the request URL', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('a.jpg', 8);
    const uploader = buildUploader();

    await uploader.upload(filePath, {
      model: 'qwen-vl-plus',
      apiKey: 'sk-x',
      endpoint: 'https://mock-dashscope.test.qianwenai.com',
    });

    const firstCall = mockFetch.mock.calls[0] as [string, RequestInit | undefined];
    const url = String(firstCall[0]);
    expect(url).toContain('getPolicy');
    expect(url).toContain('qwen-vl-plus');
  });

  it('forwards the apiKey as a bearer Authorization header on the getPolicy call', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('a.jpg', 8);
    const uploader = buildUploader();

    await uploader.upload(filePath, {
      model: 'qwen-vl-plus',
      apiKey: 'sk-bearer-42',
    });

    const firstCall = mockFetch.mock.calls[0] as [string, RequestInit | undefined];
    const init = firstCall[1] ?? {};
    const headerValue = readHeader(init.headers, 'authorization');
    expect(headerValue).toMatch(/Bearer\s+sk-bearer-42/i);
  });

  it('second fetch posts multipart/form-data to upload_host from the policy', async () => {
    const policy = makePolicyResponse({
      upload_host: 'https://qwen-cli-uploads.test.qianwenai.com',
    });
    mockFetch.mockResolvedValueOnce(policy).mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('clip.mp4', 32);
    const uploader = buildUploader();

    await uploader.upload(filePath, { model: 'wan-x-2.1', apiKey: 'sk-x' });

    const secondCall = mockFetch.mock.calls[1] as [string, RequestInit | undefined];
    const url = String(secondCall[0]);
    expect(url).toContain('qwen-cli-uploads.test.qianwenai.com');

    const init = secondCall[1] ?? {};
    expect(String(init.method ?? '').toUpperCase()).toBe('POST');

    // body must be either FormData or a string containing the multipart parts;
    // accept both since Node fetch normalises FormData internally.
    const body = init.body;
    expect(body).toBeDefined();
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('x-oss-object-acl')).toBe('private');
    expect(form.get('x-oss-forbid-overwrite')).toBe('true');
    expect(form.get('key')).toBeDefined();
    expect(form.get('OSSAccessKeyId')).toBeDefined();
    expect(form.get('policy')).toBeDefined();
    expect(form.get('signature')).toBeDefined();
  });

  it('returns an oss URL whose key segment matches the policy.key', async () => {
    const policy = makePolicyResponse({
      key: 'qwen-uploads/20260610/photo_abc.jpg',
    });
    mockFetch.mockResolvedValueOnce(policy).mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('photo.jpg', 8);
    const uploader = buildUploader();

    const result = await uploader.upload(filePath, {
      model: 'qwen-vl-plus',
      apiKey: 'sk-x',
    });

    expect(result.ossUrl).toContain('qwen-uploads/20260610/photo_abc.jpg');
  });

  it('inserts a separator when upload_dir lacks a trailing slash and key is empty', async () => {
    // Real-world DashScope responses for some products return an upload_dir
    // whose final segment is a per-request UUID without a trailing slash and
    // an empty `key`. The uploader must derive the key with exactly one `/`
    // between the directory and the filename, otherwise the gateway rejects
    // the resulting object key with `InvalidParameter: Failed to download`.
    const policy = makePolicyResponse({
      upload_dir: 'dashscope-instant/abc/2026-06-10/uuid-no-slash',
      key: '',
    });
    mockFetch.mockResolvedValueOnce(policy).mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('photo.png', 8);
    const uploader = buildUploader();

    const result = await uploader.upload(filePath, {
      model: 'wan2.7-i2v',
      apiKey: 'sk-x',
    });

    expect(result.ossUrl).toBe('oss://dashscope-instant/abc/2026-06-10/uuid-no-slash/photo.png');

    const secondCall = mockFetch.mock.calls[1] as [string, RequestInit | undefined];
    const form = (secondCall[1]?.body ?? new FormData()) as FormData;
    expect(form.get('key')).toBe('dashscope-instant/abc/2026-06-10/uuid-no-slash/photo.png');
  });

  it('does not duplicate the separator when upload_dir already ends with /', async () => {
    const policy = makePolicyResponse({
      upload_dir: 'qwen-uploads/20260610/',
      key: '',
    });
    mockFetch.mockResolvedValueOnce(policy).mockResolvedValueOnce(makeUploadResponse(204));

    const filePath = writeBinaryFile('clip.mp4', 8);
    const uploader = buildUploader();

    const result = await uploader.upload(filePath, {
      model: 'wan2.7-i2v',
      apiKey: 'sk-x',
    });

    expect(result.ossUrl).toBe('oss://qwen-uploads/20260610/clip.mp4');
  });
});

// ────────────────────────────────────────────────────────────────────
// File size limit enforcement (max_file_size_mb)
// ────────────────────────────────────────────────────────────────────

describe('OssUploader.upload — file size limit', () => {
  it('throws FILE_TOO_LARGE (exit 4) when the file exceeds max_file_size_mb', async () => {
    // Force the limit to 0 MB so any non-empty file violates it. This keeps
    // the test fast — no need to fabricate a 10MB file on disk.
    mockFetch.mockResolvedValueOnce(makePolicyResponse({ max_file_size_mb: 0 }));

    const filePath = writeBinaryFile('big.jpg', 4096);
    const uploader = buildUploader();

    let captured: unknown;
    try {
      await uploader.upload(filePath, { model: 'qwen-vl-plus', apiKey: 'sk-x' });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    const err = captured as { code?: string; exitCode?: number; message?: string };
    expect(err.code).toBe('FILE_TOO_LARGE');
    expect(err.exitCode).toBe(4);
  });

  it('does NOT issue the multipart upload call when size limit is violated', async () => {
    mockFetch.mockResolvedValueOnce(makePolicyResponse({ max_file_size_mb: 0 }));

    const filePath = writeBinaryFile('big.jpg', 4096);
    const uploader = buildUploader();

    await expect(
      uploader.upload(filePath, { model: 'qwen-vl-plus', apiKey: 'sk-x' }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });

    // Exactly one fetch — the getPolicy call — must have happened.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// getPolicy failures (network / non-2xx)
// ────────────────────────────────────────────────────────────────────

describe('OssUploader.upload — getPolicy failures', () => {
  it('throws POLICY_REQUEST_FAILED (exit 3) when getPolicy returns non-ok', async () => {
    mockFetch.mockResolvedValueOnce(makeFailedResponse(500, 'internal'));

    const filePath = writeBinaryFile('a.jpg', 8);
    const uploader = buildUploader();

    let captured: unknown;
    try {
      await uploader.upload(filePath, { model: 'qwen-vl-plus', apiKey: 'sk-x' });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    const err = captured as { code?: string; exitCode?: number };
    expect(err.code).toBe('POLICY_REQUEST_FAILED');
    expect(err.exitCode).toBe(3);
  });

  it('throws POLICY_REQUEST_FAILED (exit 3) when fetch itself rejects on getPolicy', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));

    const filePath = writeBinaryFile('a.jpg', 8);
    const uploader = buildUploader();

    await expect(
      uploader.upload(filePath, { model: 'qwen-vl-plus', apiKey: 'sk-x' }),
    ).rejects.toMatchObject({ code: 'POLICY_REQUEST_FAILED', exitCode: 3 });
  });

  it('does NOT initiate the multipart upload when getPolicy fails', async () => {
    mockFetch.mockResolvedValueOnce(makeFailedResponse(502));

    const filePath = writeBinaryFile('a.jpg', 8);
    const uploader = buildUploader();

    await expect(
      uploader.upload(filePath, { model: 'qwen-vl-plus', apiKey: 'sk-x' }),
    ).rejects.toThrow();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// OSS multipart upload failures
// ────────────────────────────────────────────────────────────────────

describe('OssUploader.upload — OSS upload failures', () => {
  it('throws UPLOAD_FAILED (exit 3) when the multipart POST returns non-ok', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockResolvedValueOnce(makeFailedResponse(403, 'AccessDenied'));

    const filePath = writeBinaryFile('a.jpg', 8);
    const uploader = buildUploader();

    let captured: unknown;
    try {
      await uploader.upload(filePath, { model: 'qwen-vl-plus', apiKey: 'sk-x' });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    const err = captured as { code?: string; exitCode?: number };
    expect(err.code).toBe('UPLOAD_FAILED');
    expect(err.exitCode).toBe(3);
  });

  it('throws UPLOAD_FAILED (exit 3) when the multipart POST fetch rejects', async () => {
    mockFetch
      .mockResolvedValueOnce(makePolicyResponse())
      .mockRejectedValueOnce(new Error('socket hang up'));

    const filePath = writeBinaryFile('a.jpg', 8);
    const uploader = buildUploader();

    await expect(
      uploader.upload(filePath, { model: 'qwen-vl-plus', apiKey: 'sk-x' }),
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED', exitCode: 3 });
  });
});

// ────────────────────────────────────────────────────────────────────
// Local helpers
// ────────────────────────────────────────────────────────────────────

function readHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }
  const rec = headers as Record<string, string>;
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) return rec[k];
  }
  return undefined;
}

describe('assertLocalUploadSupported', () => {
  it('throws INVALID_ARGUMENT for a Token Plan key and points to URL input', () => {
    try {
      assertLocalUploadSupported('sk-sp-abc123');
      throw new Error('expected assertLocalUploadSupported to throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'LOCAL_UPLOAD_UNSUPPORTED', exitCode: 4 });
      expect((err as Error).message).toMatch(/Token Plan/i);
      expect((err as Error).message).toMatch(/URL/i);
      expect((err as Error).message).toContain('无法上传本地文件');
    }
  });

  it('passes through for pay-as-you-go keys (sk- / sk-ws-) and undefined', () => {
    expect(() => assertLocalUploadSupported('sk-abc')).not.toThrow();
    expect(() => assertLocalUploadSupported('sk-ws-abc')).not.toThrow();
    expect(() => assertLocalUploadSupported(undefined)).not.toThrow();
  });
});
