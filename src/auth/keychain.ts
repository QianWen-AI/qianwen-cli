// ============================================================
// System Keychain read/write module
// References the Python keyring library's behavior, using each platform's
// native CLI to access the OS keychain.
// macOS: security CLI (consistent with Python keyring's underlying impl)
// Linux: secret-tool (GNOME Secret Service / D-Bus)
// Windows: PowerShell CredentialManager module
//
// Availability detection is intentionally lightweight: it only checks whether
// the underlying CLI exists. Detecting "the CLI exists but the keychain agent
// is unreachable" (e.g. SSH/headless sessions on macOS, locked keychain) is
// handled at the storage layer (see writeCredentials in credentials.ts), which
// performs a write-then-readback verification and falls back to the encrypted
// file when the keychain silently fails.
//
// Supports the `${envPrefix}_KEYRING` environment variable to skip the keychain.
// ============================================================

import { spawnSync } from 'child_process';
import { platform } from 'os';
import { site } from '../site.js';

export const KEYCHAIN_SERVICE = site.keychainService;
export const KEYCHAIN_ACCOUNT = site.keychainAccount;

// Environment variable opt-out
const ENV_KEYRING = `${site.envPrefix}_KEYRING`;
const KEYRING_OPT_OUT_VALUES = ['no', '0', 'false', 'off', 'plaintext'];

/**
 * Check whether the QIANWEN_KEYRING environment variable requests skipping the keychain.
 */
function isKeyringOptedOut(): boolean {
  const val = process.env[ENV_KEYRING]?.trim().toLowerCase() ?? '';
  return KEYRING_OPT_OUT_VALUES.includes(val);
}

/**
 * Read the credentials JSON string from the system Keychain.
 * Returns null when no data exists or the keychain is unavailable.
 */
export function readFromKeychain(): string | null {
  const os = platform();

  try {
    if (os === 'darwin') {
      // macOS: security find-generic-password -s <service> -a <account> -w
      // Use spawnSync to pass arguments separately, avoiding shell injection.
      const result = spawnSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      if (result.status !== 0) return null;
      const value = (result.stdout ?? '').trim();
      if (!value) return null;
      return value;
    }

    if (os === 'linux') {
      // Linux: secret-tool lookup (GNOME Secret Service)
      const result = spawnSync(
        'secret-tool',
        ['lookup', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      if (result.status !== 0) return null;
      const value = (result.stdout ?? '').trim();
      if (!value) return null;
      return value;
    }

    if (os === 'win32') {
      // Windows: read the generic credential from CredentialManager
      const script = `$cred = Get-StoredCredential -Target '${KEYCHAIN_SERVICE}:${KEYCHAIN_ACCOUNT}'; if ($cred) { $cred.GetNetworkCredential().Password }`;
      const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.status !== 0) return null;
      const value = (result.stdout ?? '').trim();
      if (!value) return null;
      return value;
    }

    return null;
  } catch {
    // Keychain unavailable or credential does not exist; silently return null
    return null;
  }
}

/**
 * Write the credentials JSON string into the system Keychain.
 * Returns true on success, false on failure.
 */
export function writeToKeychain(json: string): boolean {
  const os = platform();

  try {
    if (os === 'darwin') {
      // macOS: delete the old entry first (if any), then add a new one.
      // Pre-cleanup; ignore status (entry may not exist).
      spawnSync(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      // Use spawnSync to avoid shell injection risks; pass JSON as a separate argument
      const result = spawnSync(
        'security',
        ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', json],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return result.status === 0;
    }

    if (os === 'linux') {
      // Linux: secret-tool store (overwrites any existing entry).
      // Password is provided via stdin, not on the command line.
      const result = spawnSync(
        'secret-tool',
        [
          'store',
          `--label=${site.keychainService} credentials`,
          'service',
          KEYCHAIN_SERVICE,
          'account',
          KEYCHAIN_ACCOUNT,
        ],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], input: json },
      );
      return result.status === 0;
    }

    if (os === 'win32') {
      // Windows: store via CredentialManager
      // Use -EncodedCommand to avoid shell injection; pass JSON as a separate argument
      const script = `
        Remove-StoredCredential -Target '${KEYCHAIN_SERVICE}:${KEYCHAIN_ACCOUNT}' -ErrorAction SilentlyContinue
        $password = [Console]::In.ReadToEnd()
        New-StoredCredential -Target '${KEYCHAIN_SERVICE}:${KEYCHAIN_ACCOUNT}' -UserName '${KEYCHAIN_ACCOUNT}' -Password $password -Persistence LocalMachine
      `;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const result = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
        encoding: 'utf-8',
        input: json,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.status === 0;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Delete the credential from the system Keychain.
 * Returns true on successful deletion, false when no entry exists or on failure.
 */
export function deleteFromKeychain(): boolean {
  const os = platform();

  try {
    if (os === 'darwin') {
      // Use spawnSync to pass arguments separately, avoiding shell injection.
      const result = spawnSync(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return result.status === 0;
    }

    if (os === 'linux') {
      const result = spawnSync(
        'secret-tool',
        ['clear', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return result.status === 0;
    }

    if (os === 'win32') {
      const script = `Remove-StoredCredential -Target '${KEYCHAIN_SERVICE}:${KEYCHAIN_ACCOUNT}'`;
      const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.status === 0;
    }

    return false;
  } catch {
    return false;
  }
}

// ─── Linux D-Bus Secret Service detection ──────────────────────────

/**
 * Linux: the secret-tool binary may exist but the GNOME Secret Service daemon
 * may not be running. Check whether org.freedesktop.secrets is registered on
 * the D-Bus session bus.
 */
function linuxSecretServiceAvailable(): boolean {
  // 1. Check whether the secret-tool command exists
  const versionResult = spawnSync('secret-tool', ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (versionResult.status !== 0) return false;

  // 2. Check whether the Secret Service is registered on D-Bus
  const dbusResult = spawnSync(
    'dbus-send',
    [
      '--session',
      '--print-reply',
      '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus.ListNames',
    ],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 },
  );
  if (dbusResult.status !== 0) return false;
  return (dbusResult.stdout ?? '').includes('org.freedesktop.secrets');
}

/**
 * Check whether the system Keychain is *potentially* available.
 *
 * This is a lightweight check that only verifies whether the underlying CLI
 * exists. It intentionally does NOT verify that writes will actually persist
 * (e.g. macOS SecurityAgent reachability, Keychain unlocked state) — that
 * verification is performed at the storage layer via write-then-readback in
 * writeCredentials(), which automatically falls back to the encrypted file
 * when keychain writes silently fail.
 *
 * Platforms:
 *   macOS:   /usr/bin/security exists (cheap exec check)
 *   Linux:   secret-tool exists + D-Bus Secret Service registered
 *   Windows: Get-StoredCredential cmdlet available
 *   `${envPrefix}_KEYRING`=no|0|false|off|plaintext → skip the keychain
 */
// ─── Process-level cache for isKeychainAvailable ──────────────────────────
let _keychainAvailableCache: boolean | undefined;

/**
 * Clear the isKeychainAvailable cache (for use in credential change scenarios).
 */
export function clearKeychainAvailableCache(): void {
  _keychainAvailableCache = undefined;
}

export function isKeychainAvailable(): boolean {
  // Return cached result (process-level; the CLI checks only once per execution)
  if (_keychainAvailableCache !== undefined) return _keychainAvailableCache;

  // Environment variable opt-out
  if (isKeyringOptedOut()) {
    _keychainAvailableCache = false;
    return false;
  }

  const os = platform();

  try {
    if (os === 'darwin') {
      // macOS: only check that the security command can be spawned.
      // Actual write reachability is verified by writeCredentials() on each
      // login (write-then-readback), which auto-falls-back to the encrypted
      // file in SSH/headless/locked-keychain scenarios.
      const helpResult = spawnSync('security', ['-h'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // `security -h` prints usage to stderr and may exit non-zero on some
      // macOS versions; treat "spawn succeeded" (no error) as "command exists".
      const available = !helpResult.error;
      _keychainAvailableCache = available;
      return available;
    }

    if (os === 'linux') {
      _keychainAvailableCache = linuxSecretServiceAvailable();
      return _keychainAvailableCache;
    }

    if (os === 'win32') {
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-Command Get-StoredCredential -ErrorAction SilentlyContinue',
        ],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      // Get-Command returns non-zero (or empty stdout) when the cmdlet is missing.
      const found = result.status === 0 && (result.stdout ?? '').trim().length > 0;
      _keychainAvailableCache = found;
      return found;
    }

    _keychainAvailableCache = false;
    return false;
  } catch {
    _keychainAvailableCache = false;
    return false;
  }
}

/**
 * Check whether QIANWEN_KEYRING is set to plaintext (debug mode).
 */
export function isPlaintextMode(): boolean {
  return process.env[ENV_KEYRING]?.trim().toLowerCase() === 'plaintext';
}
