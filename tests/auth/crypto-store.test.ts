import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

// Provide a deterministic 32-byte fingerprint to skip expensive hardware probes.
const FAKE_FINGERPRINT = crypto.createHash('sha256').update('test-fingerprint').digest();
const fingerprintMock = vi.fn(() => FAKE_FINGERPRINT);

vi.mock('child_process', () => ({
  // crypto-store uses execSync only inside fingerprint helpers; since we override
  // getFingerprintOrFallback below, this stub just keeps imports happy.
  execSync: vi.fn(() => ''),
}));

// Spy on the crypto-store's own export so we can swap fingerprint lookup.
// We re-import via vi.importActual to preserve real encrypt/decrypt internals.
vi.mock('../../src/auth/crypto-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/crypto-store.js')>(
    '../../src/auth/crypto-store.js',
  );
  return {
    ...actual,
    getFingerprintOrFallback: () => fingerprintMock(),
  };
});

const {
  isEncryptedEnvelope,
  writeEncryptedCredentials,
  readEncryptedCredentials,
  writePlaintextCredentials,
} = await import('../../src/auth/crypto-store.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `${s.cliName}-crypto-`));
  fingerprintMock.mockReturnValue(FAKE_FINGERPRINT);
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── isEncryptedEnvelope ────────────────────────────────────────────
describe('isEncryptedEnvelope', () => {
  it('returns true for valid envelope shape', () => {
    const env = {
      version: 1,
      salt: 'AAAA',
      nonce: 'BBBB',
      ciphertext: 'CCCC',
    };
    expect(isEncryptedEnvelope(JSON.stringify(env))).toBe(true);
  });

  it('returns false for malformed JSON', () => {
    expect(isEncryptedEnvelope('not json')).toBe(false);
    expect(isEncryptedEnvelope('{')).toBe(false);
  });

  it('returns false for plaintext credentials JSON', () => {
    const plain = { access_token: 'abc', expires_at: '2099-01-01T00:00:00Z' };
    expect(isEncryptedEnvelope(JSON.stringify(plain))).toBe(false);
  });

  it('returns false when version is wrong', () => {
    const env = { version: 99, salt: 'a', nonce: 'b', ciphertext: 'c' };
    expect(isEncryptedEnvelope(JSON.stringify(env))).toBe(false);
  });

  it('returns false when required fields are missing', () => {
    expect(isEncryptedEnvelope(JSON.stringify({ version: 1, salt: 'a', nonce: 'b' }))).toBe(false);
    expect(
      isEncryptedEnvelope(JSON.stringify({ version: 1, salt: 'a', ciphertext: 'c' })),
    ).toBe(false);
  });

  it('returns false for null', () => {
    expect(isEncryptedEnvelope('null')).toBe(false);
  });
});

// ── encrypt / decrypt round-trip ───────────────────────────────────
describe('writeEncryptedCredentials / readEncryptedCredentials', () => {
  it('round-trips a simple credentials object', () => {
    const filePath = join(tmpDir, 'credentials');
    const data = {
      access_token: 'abc-123',
      expires_at: '2099-01-01T00:00:00Z',
      user: { aliyunId: '12345', email: 'demo@qwen.dev' },
    };

    writeEncryptedCredentials(data, filePath);
    expect(existsSync(filePath)).toBe(true);

    const decrypted = readEncryptedCredentials(filePath);
    expect(decrypted).toEqual(data);
  });

  it('writes a recognizable envelope to disk', () => {
    const filePath = join(tmpDir, 'credentials');
    writeEncryptedCredentials({ x: 1 }, filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(isEncryptedEnvelope(content)).toBe(true);

    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.salt).toBe('string');
    expect(typeof parsed.nonce).toBe('string');
    expect(typeof parsed.ciphertext).toBe('string');
  });

  it('produces different ciphertexts for the same plaintext (random salt+nonce)', () => {
    const fileA = join(tmpDir, 'a');
    const fileB = join(tmpDir, 'b');
    writeEncryptedCredentials({ token: 'same' }, fileA);
    writeEncryptedCredentials({ token: 'same' }, fileB);

    const a = JSON.parse(readFileSync(fileA, 'utf-8'));
    const b = JSON.parse(readFileSync(fileB, 'utf-8'));
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
  });

  it('returns null when reading non-existent file', () => {
    expect(readEncryptedCredentials(join(tmpDir, 'missing'))).toBeNull();
  });

  it('returns null when file is plaintext (not envelope)', () => {
    const filePath = join(tmpDir, 'plain');
    writeFileSync(filePath, JSON.stringify({ access_token: 'x' }), 'utf-8');
    expect(readEncryptedCredentials(filePath)).toBeNull();
  });

  it('returns null when ciphertext is corrupted (decryption fails)', () => {
    const filePath = join(tmpDir, 'credentials');
    writeEncryptedCredentials({ token: 'secret' }, filePath);

    // Tamper with the ciphertext so AES-GCM auth tag verification fails
    const env = JSON.parse(readFileSync(filePath, 'utf-8'));
    const buf = Buffer.from(env.ciphertext, 'base64');
    buf[0] = buf[0] ^ 0xff; // flip first byte
    env.ciphertext = buf.toString('base64');
    writeFileSync(filePath, JSON.stringify(env), 'utf-8');

    expect(readEncryptedCredentials(filePath)).toBeNull();
  });

  it('returns null when envelope version is unsupported', () => {
    const filePath = join(tmpDir, 'credentials');
    writeEncryptedCredentials({ token: 'secret' }, filePath);

    const env = JSON.parse(readFileSync(filePath, 'utf-8'));
    env.version = 99;
    // Manually write so isEncryptedEnvelope still passes only when version matches —
    // here version=99 means isEncryptedEnvelope returns false → readEncryptedCredentials returns null
    writeFileSync(filePath, JSON.stringify(env), 'utf-8');

    expect(readEncryptedCredentials(filePath)).toBeNull();
  });

  it('writes file with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const filePath = join(tmpDir, 'credentials');
    writeEncryptedCredentials({ x: 1 }, filePath);

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('cleans up .tmp file via atomic rename', () => {
    const filePath = join(tmpDir, 'credentials');
    writeEncryptedCredentials({ x: 1 }, filePath);
    expect(existsSync(filePath + '.tmp')).toBe(false);
  });
});

// ── writePlaintextCredentials ──────────────────────────────────────
describe('writePlaintextCredentials', () => {
  it('writes a JSON file readable as plain object', () => {
    const filePath = join(tmpDir, 'plain-cred');
    const data = { access_token: 'xyz', expires_at: '2099-01-01T00:00:00Z' };

    writePlaintextCredentials(data, filePath);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual(data);
    // Should NOT be an encrypted envelope
    expect(isEncryptedEnvelope(content)).toBe(false);
  });

  it('writes with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const filePath = join(tmpDir, 'plain-cred');
    writePlaintextCredentials({ x: 1 }, filePath);

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directory if missing', () => {
    const nestedPath = join(tmpDir, 'nested', 'sub', 'cred');
    writePlaintextCredentials({ x: 1 }, nestedPath);
    expect(existsSync(nestedPath)).toBe(true);
  });

  it('cleans up .tmp file via atomic rename', () => {
    const filePath = join(tmpDir, 'plain-cred');
    writePlaintextCredentials({ x: 1 }, filePath);
    expect(existsSync(filePath + '.tmp')).toBe(false);
  });
});
