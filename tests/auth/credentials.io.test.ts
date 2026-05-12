import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Credentials } from '../../src/types/auth.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

// ── Test environment ──────────────────────────────────────────────
let tmpDir: string;
let credPath: string;

// Mocks for keychain & crypto-store layers (so we don't touch the real OS)
const keychainState = {
  available: false,
  plaintext: false,
  data: null as string | null,
  writeOk: true,
  readbackEqual: true,
};

vi.mock('../../src/auth/keychain.js', () => ({
  isKeychainAvailable: () => keychainState.available,
  isPlaintextMode: () => keychainState.plaintext,
  readFromKeychain: () => keychainState.data,
  writeToKeychain: (json: string) => {
    if (!keychainState.writeOk) return false;
    keychainState.data = json;
    return true;
  },
  deleteFromKeychain: () => {
    keychainState.data = null;
    return true;
  },
  clearKeychainAvailableCache: () => {},
  KEYCHAIN_SERVICE: s.keychainService,
  KEYCHAIN_ACCOUNT: s.keychainAccount,
}));

// Encrypted store mocks: persist via a simple JSON file with an envelope marker.
const ENC_MARKER = '__ENC__';

vi.mock('../../src/auth/crypto-store.js', () => ({
  isEncryptedEnvelope: (s: string) => {
    try {
      const p = JSON.parse(s);
      return p && p[ENC_MARKER] === true;
    } catch {
      return false;
    }
  },
  writeEncryptedCredentials: (data: Record<string, unknown>, path: string) => {
    writeFileSync(path, JSON.stringify({ [ENC_MARKER]: true, payload: data }), 'utf-8');
  },
  readEncryptedCredentials: (path: string) => {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(require('fs').readFileSync(path, 'utf-8'));
      if (!parsed[ENC_MARKER]) return null;
      return parsed.payload;
    } catch {
      return null;
    }
  },
  writePlaintextCredentials: (data: Record<string, unknown>, path: string) => {
    writeFileSync(path, JSON.stringify(data), 'utf-8');
  },
}));

vi.mock('../../src/config/paths.js', () => ({
  getCredentialsPath: () => credPath,
}));

const {
  resolveCredentials,
  writeCredentials,
  deleteCredentials,
  readCredentials,
  getCurrentUser,
  tryExtractUserFromToken,
  ensureAuthenticated,
  clearCredentialsCache,
} = await import('../../src/auth/credentials.js');

function makeCreds(expiresInHours: number): Credentials {
  return {
    access_token: 'token-' + Math.random().toString(36).slice(2),
    expires_at: new Date(Date.now() + expiresInHours * 3600_000).toISOString(),
    user: { email: 'demo@qwen.dev', aliyunId: '12345' },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `${s.cliName}-creds-`));
  credPath = join(tmpDir, 'credentials');
  keychainState.available = false;
  keychainState.plaintext = false;
  keychainState.data = null;
  keychainState.writeOk = true;
  keychainState.readbackEqual = true;
  clearCredentialsCache();
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── resolveCredentials ─────────────────────────────────────────────
describe('resolveCredentials', () => {
  it('returns null when no keychain entry and no file', () => {
    expect(resolveCredentials()).toBeNull();
  });

  it('reads from keychain when available', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 'kc-token',
      expires_at: '2099-01-01T00:00:00Z',
      user: { email: 'kc@x.com', aliyunId: 'kc-1' },
    });

    const r = resolveCredentials();
    expect(r).not.toBeNull();
    expect(r!.source).toBe('keychain');
    expect(r!.access_token).toBe('kc-token');
    expect(r!.credentials!.user.email).toBe('kc@x.com');
  });

  it('falls back to encrypted file when keychain unavailable', () => {
    keychainState.available = false;
    // Manually create encrypted-envelope-shaped file
    writeFileSync(
      credPath,
      JSON.stringify({
        [ENC_MARKER]: true,
        payload: {
          access_token: 'enc-token',
          expires_at: '2099-01-01T00:00:00Z',
          user: { email: 'enc@x.com', aliyunId: 'enc-1' },
        },
      }),
      'utf-8',
    );

    const r = resolveCredentials();
    expect(r).not.toBeNull();
    expect(r!.source).toBe('encrypted_file');
    expect(r!.access_token).toBe('enc-token');
  });

  it('returns null when keychain JSON is invalid', () => {
    keychainState.available = true;
    keychainState.data = 'not json';
    expect(resolveCredentials()).toBeNull();
  });

  it('returns null when keychain JSON lacks access_token', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({ user: { email: 'x' } });
    expect(resolveCredentials()).toBeNull();
  });

  it('caches result across consecutive calls', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 't1',
      expires_at: '2099-01-01T00:00:00Z',
    });

    const r1 = resolveCredentials();
    keychainState.data = JSON.stringify({
      access_token: 't2',
      expires_at: '2099-01-01T00:00:00Z',
    });
    const r2 = resolveCredentials();

    expect(r1!.access_token).toBe('t1');
    // Cache hit returns the same access_token
    expect(r2!.access_token).toBe('t1');
  });

  it('refreshes after clearCredentialsCache', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 't1',
      expires_at: '2099-01-01T00:00:00Z',
    });
    expect(resolveCredentials()!.access_token).toBe('t1');

    clearCredentialsCache();
    keychainState.data = JSON.stringify({
      access_token: 't2',
      expires_at: '2099-01-01T00:00:00Z',
    });
    expect(resolveCredentials()!.access_token).toBe('t2');
  });

  it('refreshes when cached token has expired', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 'expired-token',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    // First resolve caches the expired credentials
    expect(resolveCredentials()!.access_token).toBe('expired-token');

    // Now switch to new fresh token; cache should detect expiry and re-read
    keychainState.data = JSON.stringify({
      access_token: 'fresh-token',
      expires_at: '2099-01-01T00:00:00Z',
    });
    expect(resolveCredentials()!.access_token).toBe('fresh-token');
  });

  it('normalizes legacy keychain user shape (Id/Email/Organization)', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 't',
      expires_at: '2099-01-01T00:00:00Z',
      user: { Id: 7, Email: 'legacy@x.com', Organization: 'org-7' },
    });

    const u = resolveCredentials()!.credentials!.user;
    expect(u.id).toBe(7);
    expect(u.email).toBe('legacy@x.com');
    expect(u.aliyunId).toBe('org-7');
  });
});

// ── writeCredentials ───────────────────────────────────────────────
describe('writeCredentials', () => {
  it('writes via keychain when available and readback matches', () => {
    keychainState.available = true;
    const creds = makeCreds(24);

    writeCredentials(creds);
    expect(keychainState.data).toBeTruthy();
    const stored = JSON.parse(keychainState.data!);
    expect(stored.access_token).toBe(creds.access_token);
    expect(stored.auth_mode).toBe('device_flow');
    expect(existsSync(credPath)).toBe(false); // No fallback file
  });

  it('falls back to encrypted file when keychain write fails', () => {
    keychainState.available = true;
    keychainState.writeOk = false;
    const creds = makeCreds(24);

    writeCredentials(creds);
    expect(existsSync(credPath)).toBe(true);
    const onDisk = JSON.parse(require('fs').readFileSync(credPath, 'utf-8'));
    expect(onDisk[ENC_MARKER]).toBe(true);
    expect(onDisk.payload.access_token).toBe(creds.access_token);
  });

  it('writes plaintext when QIANWEN_KEYRING=plaintext', () => {
    keychainState.plaintext = true;
    const creds = makeCreds(24);

    writeCredentials(creds);
    expect(existsSync(credPath)).toBe(true);
    const onDisk = JSON.parse(require('fs').readFileSync(credPath, 'utf-8'));
    expect(onDisk.access_token).toBe(creds.access_token);
    expect(onDisk[ENC_MARKER]).toBeUndefined();
  });

  it('writes encrypted file when keychain unavailable', () => {
    keychainState.available = false;
    const creds = makeCreds(24);

    writeCredentials(creds);
    expect(existsSync(credPath)).toBe(true);
    const onDisk = JSON.parse(require('fs').readFileSync(credPath, 'utf-8'));
    expect(onDisk[ENC_MARKER]).toBe(true);
  });
});

// ── deleteCredentials ──────────────────────────────────────────────
describe('deleteCredentials', () => {
  it('returns false when nothing to delete', () => {
    expect(deleteCredentials()).toBe(false);
  });

  it('returns true and unlinks file when file exists', () => {
    writeFileSync(credPath, '{}', 'utf-8');
    expect(deleteCredentials()).toBe(true);
    expect(existsSync(credPath)).toBe(false);
  });

  it('also clears keychain entry when present', () => {
    keychainState.data = '{"access_token":"x"}';
    writeFileSync(credPath, '{}', 'utf-8');
    deleteCredentials();
    expect(keychainState.data).toBeNull();
  });
});

// ── readCredentials ────────────────────────────────────────────────
describe('readCredentials', () => {
  it('returns null when file missing', () => {
    expect(readCredentials()).toBeNull();
  });

  it('reads encrypted file', () => {
    writeFileSync(
      credPath,
      JSON.stringify({
        [ENC_MARKER]: true,
        payload: {
          access_token: 'enc-x',
          expires_at: '2099-01-01T00:00:00Z',
          user: { email: 'a@b', aliyunId: 'c' },
        },
      }),
      'utf-8',
    );
    const r = readCredentials();
    expect(r!.access_token).toBe('enc-x');
  });

  it('reads plaintext file', () => {
    writeFileSync(
      credPath,
      JSON.stringify({
        access_token: 'plain-x',
        expires_at: '2099-01-01T00:00:00Z',
        user: { email: 'a@b', aliyunId: 'c' },
      }),
      'utf-8',
    );
    const r = readCredentials();
    expect(r!.access_token).toBe('plain-x');
  });

  it('returns null when validation fails (missing access_token)', () => {
    writeFileSync(credPath, JSON.stringify({ expires_at: 'x' }), 'utf-8');
    expect(readCredentials()).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    writeFileSync(credPath, '{not-json', 'utf-8');
    expect(readCredentials()).toBeNull();
  });
});

// ── getCurrentUser / tryExtractUserFromToken / ensureAuthenticated ─
describe('getCurrentUser', () => {
  it('returns null when not authenticated', () => {
    expect(getCurrentUser()).toBeNull();
  });

  it('returns user info when authenticated via keychain', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 't',
      expires_at: '2099-01-01T00:00:00Z',
      user: { email: 'u@x.com', aliyunId: 'a-1' },
    });
    const u = getCurrentUser();
    expect(u!.email).toBe('u@x.com');
    expect(u!.aliyunId).toBe('a-1');
  });
});

describe('tryExtractUserFromToken', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from('{"alg":"none"}').toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.sig`;
  }

  it('returns null for empty token', () => {
    expect(tryExtractUserFromToken('')).toBeNull();
  });

  it('returns null for non-JWT token', () => {
    expect(tryExtractUserFromToken('opaque-token')).toBeNull();
  });

  it('extracts email + aliyun_id from JWT', () => {
    const tok = makeJwt({ email: 'jwt@x.com', aliyun_id: 'jwt-1' });
    const u = tryExtractUserFromToken(tok);
    expect(u).toEqual({ email: 'jwt@x.com', aliyunId: 'jwt-1' });
  });

  it('falls back to upn / sub claims', () => {
    const tok = makeJwt({ upn: 'upn@x.com', sub: 'sub-1' });
    const u = tryExtractUserFromToken(tok);
    expect(u!.email).toBe('upn@x.com');
    expect(u!.aliyunId).toBe('sub-1');
  });

  it('returns null when no recognizable claims', () => {
    const tok = makeJwt({ unrelated: 'x' });
    expect(tryExtractUserFromToken(tok)).toBeNull();
  });

  it('returns null on invalid base64 payload', () => {
    expect(tryExtractUserFromToken('a.!!!.b')).toBeNull();
  });
});

describe('ensureAuthenticated', () => {
  it('throws AUTH_REQUIRED when no credentials', () => {
    expect(() => ensureAuthenticated()).toThrowError(/Not authenticated/);
  });

  it('throws TOKEN_EXPIRED when token has expired', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 't',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(() => ensureAuthenticated()).toThrowError(/Token expired/);
  });

  it('returns credentials when valid', () => {
    keychainState.available = true;
    keychainState.data = JSON.stringify({
      access_token: 'valid-token',
      expires_at: '2099-01-01T00:00:00Z',
      user: { email: 'a', aliyunId: 'b' },
    });
    const c = ensureAuthenticated();
    expect(c.access_token).toBe('valid-token');
  });
});
