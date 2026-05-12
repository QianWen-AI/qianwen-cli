import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

// ── Mocks ──────────────────────────────────────────────────────────
const spawnSyncMock = vi.fn();
const platformMock = vi.fn(() => 'darwin' as NodeJS.Platform);

vi.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock('os', () => ({
  platform: () => platformMock(),
}));

const {
  readFromKeychain,
  writeToKeychain,
  deleteFromKeychain,
  isKeychainAvailable,
  isPlaintextMode,
  clearKeychainAvailableCache,
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
} = await import('../../src/auth/keychain.js');

const ENV_KEYRING = `${s.envPrefix}_KEYRING`;
const ENV_BACKUP = process.env[ENV_KEYRING];

beforeEach(() => {
  spawnSyncMock.mockReset();
  platformMock.mockReturnValue('darwin');
  delete process.env[ENV_KEYRING];
  clearKeychainAvailableCache();
});

afterEach(() => {
  if (ENV_BACKUP === undefined) delete process.env[ENV_KEYRING];
  else process.env[ENV_KEYRING] = ENV_BACKUP;
});

// ── readFromKeychain ───────────────────────────────────────────────
describe('readFromKeychain', () => {
  it('macOS: returns trimmed stdout when security succeeds', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '  {"a":1}  \n' });

    const result = readFromKeychain();
    expect(result).toBe('{"a":1}');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      expect.any(Object),
    );
  });

  it('macOS: returns null when security exits non-zero', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    expect(readFromKeychain()).toBeNull();
  });

  it('macOS: returns null when stdout is empty', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' });
    expect(readFromKeychain()).toBeNull();
  });

  it('Linux: returns secret-tool stdout', () => {
    platformMock.mockReturnValue('linux');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'linux-secret\n' });

    const result = readFromKeychain();
    expect(result).toBe('linux-secret');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'secret-tool',
      ['lookup', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT],
      expect.any(Object),
    );
  });

  it('Linux: returns null on non-zero exit', () => {
    platformMock.mockReturnValue('linux');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    expect(readFromKeychain()).toBeNull();
  });

  it('Windows: returns powershell stdout', () => {
    platformMock.mockReturnValue('win32');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'win-secret  \n' });

    const result = readFromKeychain();
    expect(result).toBe('win-secret');
    const call = spawnSyncMock.mock.calls[0];
    expect(call[0]).toBe('powershell');
  });

  it('returns null on unsupported platform', () => {
    platformMock.mockReturnValue('aix' as NodeJS.Platform);
    expect(readFromKeychain()).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('returns null when spawnSync throws', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(readFromKeychain()).toBeNull();
  });
});

// ── writeToKeychain ────────────────────────────────────────────────
describe('writeToKeychain', () => {
  it('macOS: deletes then adds, returns true on success', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' });

    const result = writeToKeychain('{"token":"abc"}');
    expect(result).toBe(true);
    // Two calls: delete (status ignored) + add
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    const addCall = spawnSyncMock.mock.calls[1];
    expect(addCall[1]).toContain('add-generic-password');
    expect(addCall[1]).toContain('{"token":"abc"}');
  });

  it('macOS: returns false when add fails', () => {
    platformMock.mockReturnValue('darwin');
    // delete returns ok, add returns failure
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 1, stdout: '' });

    expect(writeToKeychain('x')).toBe(false);
  });

  it('Linux: passes JSON via stdin', () => {
    platformMock.mockReturnValue('linux');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' });

    expect(writeToKeychain('json-payload')).toBe(true);
    const call = spawnSyncMock.mock.calls[0];
    expect(call[0]).toBe('secret-tool');
    expect(call[2]).toMatchObject({ input: 'json-payload' });
  });

  it('Windows: encodes script and passes JSON via stdin', () => {
    platformMock.mockReturnValue('win32');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' });

    expect(writeToKeychain('windows-json')).toBe(true);
    const call = spawnSyncMock.mock.calls[0];
    expect(call[0]).toBe('powershell');
    expect(call[1]).toContain('-EncodedCommand');
    expect(call[2]).toMatchObject({ input: 'windows-json' });
  });

  it('returns false on unsupported platform', () => {
    platformMock.mockReturnValue('aix' as NodeJS.Platform);
    expect(writeToKeychain('x')).toBe(false);
  });

  it('returns false when spawnSync throws', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockImplementation(() => {
      throw new Error('exec failed');
    });
    expect(writeToKeychain('x')).toBe(false);
  });
});

// ── deleteFromKeychain ─────────────────────────────────────────────
describe('deleteFromKeychain', () => {
  it('macOS: returns true when security succeeds', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' });

    expect(deleteFromKeychain()).toBe(true);
    const call = spawnSyncMock.mock.calls[0];
    expect(call[1]).toContain('delete-generic-password');
  });

  it('Linux: returns true on secret-tool clear success', () => {
    platformMock.mockReturnValue('linux');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' });
    expect(deleteFromKeychain()).toBe(true);
    expect(spawnSyncMock.mock.calls[0][1]).toContain('clear');
  });

  it('Windows: returns true on powershell success', () => {
    platformMock.mockReturnValue('win32');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' });
    expect(deleteFromKeychain()).toBe(true);
  });

  it('returns false on non-zero exit', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    expect(deleteFromKeychain()).toBe(false);
  });

  it('returns false when spawnSync throws', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(deleteFromKeychain()).toBe(false);
  });
});

// ── isKeychainAvailable ────────────────────────────────────────────
describe('isKeychainAvailable', () => {
  it('macOS: returns true when security spawn succeeds (no error)', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', error: undefined });
    expect(isKeychainAvailable()).toBe(true);
  });

  it('macOS: returns true even when security exits non-zero (only "spawn worked" matters)', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', error: undefined });
    expect(isKeychainAvailable()).toBe(true);
  });

  it('macOS: returns false when spawnSync returns an error object', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: null, stdout: '', error: new Error('ENOENT') });
    expect(isKeychainAvailable()).toBe(false);
  });

  it('Linux: returns true when secret-tool + dbus secrets registered', () => {
    platformMock.mockReturnValue('linux');
    spawnSyncMock
      // secret-tool --version
      .mockReturnValueOnce({ status: 0, stdout: 'secret-tool 0.20\n' })
      // dbus-send list names
      .mockReturnValueOnce({
        status: 0,
        stdout: 'string "org.freedesktop.secrets"\nstring "org.gnome.keyring"\n',
      });
    expect(isKeychainAvailable()).toBe(true);
  });

  it('Linux: returns false when secret-tool missing', () => {
    platformMock.mockReturnValue('linux');
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '' });
    expect(isKeychainAvailable()).toBe(false);
  });

  it('Linux: returns false when dbus-send does not list secrets', () => {
    platformMock.mockReturnValue('linux');
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: 'secret-tool 0.20\n' })
      .mockReturnValueOnce({ status: 0, stdout: 'string "org.gnome.keyring"\n' });
    expect(isKeychainAvailable()).toBe(false);
  });

  it('Windows: returns true when Get-StoredCredential cmdlet present', () => {
    platformMock.mockReturnValue('win32');
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: 'Get-StoredCredential\n' });
    expect(isKeychainAvailable()).toBe(true);
  });

  it('Windows: returns false when stdout empty', () => {
    platformMock.mockReturnValue('win32');
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: '   \n' });
    expect(isKeychainAvailable()).toBe(false);
  });

  it(`returns false when ${ENV_KEYRING}=plaintext (opt-out)`, () => {
    process.env[ENV_KEYRING] = 'plaintext';
    platformMock.mockReturnValue('darwin');
    expect(isKeychainAvailable()).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each(['no', '0', 'false', 'off'])(`opt-out via ${ENV_KEYRING}=%s`, (val) => {
    process.env[ENV_KEYRING] = val;
    expect(isKeychainAvailable()).toBe(false);
  });

  it('caches result across calls (process-level)', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', error: undefined });

    isKeychainAvailable();
    isKeychainAvailable();
    isKeychainAvailable();
    // Only one call: cached after first
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('clearKeychainAvailableCache forces re-check', () => {
    platformMock.mockReturnValue('darwin');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', error: undefined });

    isKeychainAvailable();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    clearKeychainAvailableCache();
    isKeychainAvailable();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('returns false on unsupported platform', () => {
    platformMock.mockReturnValue('aix' as NodeJS.Platform);
    expect(isKeychainAvailable()).toBe(false);
  });
});

// ── isPlaintextMode ────────────────────────────────────────────────
describe('isPlaintextMode', () => {
  it('returns true when env=plaintext', () => {
    process.env[ENV_KEYRING] = 'plaintext';
    expect(isPlaintextMode()).toBe(true);
  });

  it('returns false when env=no (opt-out but not plaintext mode)', () => {
    process.env[ENV_KEYRING] = 'no';
    expect(isPlaintextMode()).toBe(false);
  });

  it('returns false when env unset', () => {
    delete process.env[ENV_KEYRING];
    expect(isPlaintextMode()).toBe(false);
  });

  it('is case-insensitive', () => {
    process.env[ENV_KEYRING] = 'PLAINTEXT';
    expect(isPlaintextMode()).toBe(true);
  });
});
