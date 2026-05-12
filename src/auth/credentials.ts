// ============================================================
// Credential Storage Center — layered write/read/migration
// Tier 1 (keychain available): keychain only
// Tier 2 (keychain unavailable): AES-256-GCM encrypted file
// QIANWEN_KEYRING=plaintext: plaintext file (debug mode)
// ============================================================

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { getCredentialsPath } from '../config/paths.js';
import {
  readFromKeychain,
  writeToKeychain,
  deleteFromKeychain,
  isKeychainAvailable,
  isPlaintextMode,
  clearKeychainAvailableCache,
} from './keychain.js';
import {
  writeEncryptedCredentials,
  readEncryptedCredentials,
  isEncryptedEnvelope,
  writePlaintextCredentials,
} from './crypto-store.js';
import type { Credentials, UserInfo } from '../types/auth.js';
import { authRequiredError, tokenExpiredError } from '../utils/errors.js';

/**
 * Resolved credential — unified result from layered credential resolution.
 */
// ─── resolveCredentials process-level in-memory cache ──────────────────────────
let _resolvedCache: ResolvedCredential | null | undefined;
let _cacheTimestamp: number = 0;

/** Cache TTL: 1 minute (ms). Re-reads from storage after expiry to detect external credential changes. */
const CREDENTIALS_CACHE_TTL_MS = 1 * 60 * 1000;

/**
 * Clear credential cache.
 * Called after credential changes (login/logout) to ensure subsequent reads refresh from storage.
 * Process-level cache — each CLI command execution is independent, no cross-command staleness issues.
 */
export function clearCredentialsCache(): void {
  _resolvedCache = undefined;
  _cacheTimestamp = 0;
  clearKeychainAvailableCache();
}

export interface ResolvedCredential {
  source: 'keychain' | 'encrypted_file';
  auth_mode: 'device_flow';
  access_token: string;
  credentials?: Credentials;
}

/**
 * Layered credential resolution:
 * Priority 1: keychain (only if available)
 * Priority 2: encrypted file
 * Priority 3: plaintext file migration (one-time)
 * Fallback: null
 */
export function resolveCredentials(): ResolvedCredential | null {
  // Return process-level cache (undefined = not cached, null = cached but no credentials)
  if (_resolvedCache !== undefined) {
    // TTL check: discard cache and re-read from storage if TTL exceeded (detect external logout, etc.)
    if (Date.now() - _cacheTimestamp > CREDENTIALS_CACHE_TTL_MS) {
      _resolvedCache = undefined;
      // REPL long-running process: cached token may expire during the session, needs re-resolution
    } else if (
      _resolvedCache !== null &&
      _resolvedCache.credentials &&
      isTokenExpired(_resolvedCache.credentials)
    ) {
      _resolvedCache = undefined;
    } else {
      return _resolvedCache;
    }
  }

  const result = _resolveCredentialsUncached();
  _resolvedCache = result;
  _cacheTimestamp = Date.now();
  return result;
}

/**
 * Actual credential resolution logic (uncached).
 */
function _resolveCredentialsUncached(): ResolvedCredential | null {
  // Priority 1: System Keychain (only if available)
  if (isKeychainAvailable()) {
    const keychainData = readFromKeychain();
    if (keychainData) {
      try {
        const parsed = JSON.parse(keychainData);
        if (parsed.access_token) {
          const creds: Credentials = {
            access_token: parsed.access_token,
            expires_at: parsed.expires_at ?? '',
            user: normalizeUserInfo(parsed.user),
          };
          return {
            source: 'keychain',
            auth_mode: 'device_flow',
            access_token: parsed.access_token,
            credentials: creds,
          };
        }
      } catch {
        // Invalid JSON in keychain, fall through
      }
    }
  }

  // Priority 2: Encrypted file
  const filePath = getCredentialsPath();
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8');

      if (isEncryptedEnvelope(content)) {
        const decrypted = readEncryptedCredentials(filePath);
        if (decrypted) {
          const creds = validateCredentials(decrypted);
          if (creds) {
            return {
              source: 'encrypted_file',
              auth_mode: 'device_flow',
              access_token: creds.access_token,
              credentials: creds,
            };
          }
        }
      }
    } catch {
      // Encrypted file read failed, fall through to migration
    }

    // Priority 3: Plaintext file migration (one-time)
    // If file exists but is not encrypted envelope format, it's an old plaintext file
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (!isEncryptedEnvelope(content)) {
        const creds = validateCredentials(JSON.parse(content));
        if (creds) {
          // Migrate to secure storage
          writeCredentials(creds);
          try {
            unlinkSync(filePath);
          } catch {
            /* ignore */
          }
          process.stderr.write('  Migrated plaintext credentials to secure storage.\n');

          // Re-resolve from the new storage
          const resolved = resolveCredentials();
          if (resolved) return resolved;
        }
      }
    } catch {
      // Invalid plaintext file, ignore
    }
  }

  return null;
}

/**
 * Normalize user info from keychain format to UserInfo interface.
 * Keychain may store {Id, Email, Organization} (Python keyring format)
 * while our UserInfo expects {id?, email, aliyunId}.
 * Backward compat: Organization maps to aliyunId for existing credentials.
 */
function normalizeUserInfo(raw: Record<string, unknown> | undefined): UserInfo {
  if (!raw) return { email: '', aliyunId: '' };
  return {
    id: (raw.Id ?? raw.id) as number | undefined,
    email: (raw.Email ?? raw.email ?? '') as string,
    aliyunId: (raw.AliyunId ??
      raw.aliyunId ??
      raw.Organization ??
      raw.organization ??
      '') as string,
  };
}

/**
 * Validate and cast a dict to Credentials.
 * Returns null if required fields are missing.
 */
function validateCredentials(data: Record<string, unknown>): Credentials | null {
  if (!data) return null;
  const access_token = data.access_token as string | undefined;
  const expires_at = data.expires_at as string | undefined;
  const user = data.user as Record<string, unknown> | undefined;

  if (!access_token || !expires_at) return null;

  return {
    access_token,
    expires_at,
    user: normalizeUserInfo(user),
  };
}

/**
 * Read stored credentials (supports both encrypted and plaintext formats).
 * Returns null if no credentials file or invalid.
 */
export function readCredentials(): Credentials | null {
  const path = getCredentialsPath();
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');

    // Encrypted envelope format
    if (isEncryptedEnvelope(content)) {
      const decrypted = readEncryptedCredentials(path);
      if (!decrypted) return null;
      return validateCredentials(decrypted);
    }

    // Old plaintext format
    const creds = validateCredentials(JSON.parse(content));
    return creds;
  } catch {
    return null;
  }
}

/**
 * Write credentials to the appropriate storage tier with automatic fallback.
 *
 * Strategy:
 *   1. QIANWEN_KEYRING=plaintext → plaintext file (debug mode)
 *   2. Keychain CLI present → try keychain, then verify by reading back.
 *      If the readback fails or returns a different value (i.e. the keychain
 *      silently failed — common in SSH/headless/locked-keychain scenarios),
 *      delete any partial entry and fall through to the encrypted file.
 *   3. Otherwise (or on keychain failure) → encrypted file.
 *
 * The write-then-readback pattern replaces the old startup-time probe and
 * gives correct behavior without paying the probe cost on every CLI invocation.
 */
export function writeCredentials(credentials: Credentials): void {
  // Clear cache to ensure subsequent reads reflect the new credentials
  clearCredentialsCache();

  const payload = JSON.stringify({ ...credentials, auth_mode: 'device_flow' });

  // Plaintext mode (debug)
  if (isPlaintextMode()) {
    writePlaintextCredentials({ ...credentials, auth_mode: 'device_flow' }, getCredentialsPath());
    return;
  }

  // Keychain attempt with write-then-readback verification
  if (isKeychainAvailable() && tryWriteToKeychainVerified(payload)) {
    return;
  }

  // Fallback: encrypted file
  const filePath = getCredentialsPath();
  writeEncryptedCredentials({ ...credentials, auth_mode: 'device_flow' }, filePath);
}

/**
 * Attempt to write to the keychain and verify by reading back.
 * Returns true only when the readback exactly matches the written payload —
 * this catches the common macOS failure mode where `security add-generic-password`
 * returns 0 but the value is not actually persisted (SSH session, locked
 * keychain, unreachable SecurityAgent).
 *
 * On verification failure, best-effort deletes any partial entry so the
 * encrypted-file fallback isn't shadowed by stale keychain data.
 */
function tryWriteToKeychainVerified(payload: string): boolean {
  if (!writeToKeychain(payload)) return false;

  const readback = readFromKeychain();
  if (readback === payload) return true;

  // Silent failure or partial write — clean up so we don't leave a
  // half-written entry that subsequent reads might pick up.
  try {
    deleteFromKeychain();
  } catch {
    /* best-effort cleanup */
  }
  return false;
}

/**
 * Delete credentials from keychain and file (logout).
 */
export function deleteCredentials(): boolean {
  // Clear cache to ensure subsequent reads reflect credential deletion
  clearCredentialsCache();

  // 1. Delete from keychain (silent failure is acceptable)
  deleteFromKeychain();

  // 2. Delete credential file (encrypted or plaintext)
  const path = getCredentialsPath();
  if (!existsSync(path)) return false;

  unlinkSync(path);
  return true;
}

/**
 * Check if access token is expired.
 */
export function isTokenExpired(credentials: Credentials): boolean {
  const expiresAt = new Date(credentials.expires_at);
  return expiresAt <= new Date();
}

/**
 * Check if token is about to expire (within specified minutes).
 */
export function isTokenExpiringSoon(credentials: Credentials, withinMinutes: number = 5): boolean {
  const expiresAt = new Date(credentials.expires_at);
  const threshold = new Date(Date.now() + withinMinutes * 60 * 1000);
  return expiresAt <= threshold;
}

/**
 * Get remaining time until token expires, formatted as human readable.
 * E.g., "23h 45m", "45m", "expired"
 */
export function getTokenRemainingTime(credentials: Credentials): string {
  const expiresAt = new Date(credentials.expires_at);
  const now = new Date();
  const diffMs = expiresAt.getTime() - now.getTime();

  if (diffMs <= 0) return 'expired';

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainMins = minutes % 60;
    return `${hours}h ${remainMins}m`;
  }
  return `${minutes}m`;
}

/**
 * Get current user info from credentials, or null if not logged in.
 */
export function getCurrentUser(): UserInfo | null {
  const resolved = resolveCredentials();
  if (!resolved?.credentials) return null;
  return resolved.credentials.user;
}

/**
 * Try to extract user info from a JWT access_token by decoding its payload.
 * Returns null if the token is not a valid JWT or has no user claims.
 * No verification is performed — this is purely for display purposes.
 */
export function tryExtractUserFromToken(accessToken: string): UserInfo | null {
  if (!accessToken) return null;
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null; // Not a JWT
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    const email = (payload.email ?? payload.upn ?? payload.preferred_username ?? '') as string;
    const aliyunId = (payload.aliyun_id ?? payload.aliyunId ?? payload.sub ?? '') as string;
    if (email || aliyunId) {
      return { email, aliyunId };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure user has valid (non-expired) credentials.
 * If token is expired, throw auth error (no refresh mechanism).
 */
export function ensureAuthenticated(): Credentials {
  const resolved = resolveCredentials();

  if (!resolved) {
    throw authRequiredError();
  }

  if (!resolved.credentials) {
    throw authRequiredError();
  }

  if (isTokenExpired(resolved.credentials)) {
    throw tokenExpiredError();
  }

  warnIfTokenExpiringSoon(resolved.credentials);

  return resolved.credentials;
}

/**
 * Warn on stderr if token expires within 4 hours (PRD §6.4).
 * Only outputs in TTY mode; non-TTY (Agent) stays silent to keep stdout clean.
 */
export function warnIfTokenExpiringSoon(credentials: Credentials): void {
  const EXPIRY_WARNING_HOURS = 4;

  if (!process.stderr.isTTY) return;

  const expiresAt = new Date(credentials.expires_at);
  const now = new Date();
  const diffMs = expiresAt.getTime() - now.getTime();
  const thresholdMs = EXPIRY_WARNING_HOURS * 60 * 60 * 1000;

  if (diffMs > 0 && diffMs <= thresholdMs) {
    const remaining = getTokenRemainingTime(credentials);
    process.stderr.write(`  ⚠ Token expires in ${remaining} · run auth login to refresh\n`);
  }
}
