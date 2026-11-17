import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedCredential } from '../../src/auth/credentials.js';

const stores = vi.hoisted(() => ({
  isKeychainAvailable: vi.fn(() => true),
  isPlaintextMode: vi.fn(() => false),
  readFromKeychain: vi.fn<() => string | null>(),
  writeToKeychain: vi.fn(() => true),
  deleteFromKeychain: vi.fn(() => true),
  clearKeychainAvailableCache: vi.fn(),
  readEncryptedCredentials: vi.fn(() => null),
  writeEncryptedCredentials: vi.fn(),
  writePlaintextCredentials: vi.fn(),
  getCredentialsPath: vi.fn(() => `${process.cwd()}/.build-tmp/resolved-auth-unused`),
}));

vi.mock('../../src/auth/keychain.js', () => ({
  isKeychainAvailable: stores.isKeychainAvailable,
  isPlaintextMode: stores.isPlaintextMode,
  readFromKeychain: stores.readFromKeychain,
  writeToKeychain: stores.writeToKeychain,
  deleteFromKeychain: stores.deleteFromKeychain,
  clearKeychainAvailableCache: stores.clearKeychainAvailableCache,
  KEYCHAIN_SERVICE: 'synthetic-service',
  KEYCHAIN_ACCOUNT: 'synthetic-account',
}));
vi.mock('../../src/auth/crypto-store.js', () => ({
  isEncryptedEnvelope: vi.fn(() => false),
  readEncryptedCredentials: stores.readEncryptedCredentials,
  writeEncryptedCredentials: stores.writeEncryptedCredentials,
  writePlaintextCredentials: stores.writePlaintextCredentials,
}));
vi.mock('../../src/config/paths.js', () => ({ getCredentialsPath: stores.getCredentialsPath }));

import { clearCredentialsCache, ensureAuthenticated } from '../../src/auth/credentials.js';

function credential(expiresAt = '2099-01-01T00:00:00.000Z'): ResolvedCredential {
  const credentials = {
    access_token: ['synthetic', 'resolved', 'credential'].join('-'),
    expires_at: expiresAt,
    user: { email: 'fixture@test.qianwenai.com', aliyunId: 'synthetic-user' },
  };
  return {
    source: 'keychain',
    auth_mode: 'device_flow',
    access_token: credentials.access_token,
    credentials,
  };
}

function expectNoStorageAccess() {
  for (const mock of Object.values(stores)) expect(mock).not.toHaveBeenCalled();
}

beforeEach(() => {
  clearCredentialsCache();
  vi.clearAllMocks();
  stores.readFromKeychain.mockReturnValue(JSON.stringify(credential().credentials));
});

afterEach(() => {
  clearCredentialsCache();
  vi.restoreAllMocks();
});

describe('ensureAuthenticated with an already resolved credential', () => {
  it('accepts the supplied valid credential without reading or migrating storage', () => {
    const resolved = credential();
    const before = structuredClone(resolved);
    expect(ensureAuthenticated(resolved).access_token).toBe(resolved.access_token);
    expect(resolved).toEqual(before);
    expectNoStorageAccess();
  });

  it('rejects explicit null even when a valid credential is available in storage', () => {
    expect(() => ensureAuthenticated(null)).toThrowError(
      expect.objectContaining({ code: 'AUTH_REQUIRED', exitCode: 2 }),
    );
    expectNoStorageAccess();
  });

  it('rejects an expired supplied credential without replacing it from storage', () => {
    const resolved = credential('2000-01-01T00:00:00.000Z');
    expect(() => ensureAuthenticated(resolved)).toThrowError(
      expect.objectContaining({ code: 'TOKEN_EXPIRED', exitCode: 2 }),
    );
    expectNoStorageAccess();
  });

  it('preserves existing credential resolution when the argument is omitted', () => {
    expect(ensureAuthenticated().access_token).toBe(credential().access_token);
    expect(stores.readFromKeychain).toHaveBeenCalledOnce();
  });
});
