/**
 * Login flow orchestration layer.
 * Routes authentication through PKCE (default) or Device Flow (fallback)
 * based on the mode selected by AuthService.loginInit().
 * RFC 8628 protocol details are encapsulated in auth-client.ts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { createClient } from '../api/client.js';
import { writeCredentials } from './credentials.js';
import { getDeviceFlowPendingPath } from '../config/paths.js';
import type { LoginInitResponse } from '../types/auth.js';
import type { LoginInitResult, AuthMode } from '../services/auth-service.js';
import { suppressStdin } from '../utils/stdin-suppress.js';

/**
 * Random jitter to desynchronize concurrent polling.
 */
const POLL_JITTER_MS = 1000;

/** Hard cap (ms) for the random jitter window when server is unhealthy. */
const POLL_BACKOFF_CAP_MS = 30_000;

/** Cap on consecutive failures considered for backoff growth (2^MAX = 8x). */
const POLL_BACKOFF_MAX_N = 3;

/**
 * Poll with exponential backoff until deadline.
 */
function computeJitterWindowMs(intervalMs: number, failCount: number): number {
  if (failCount <= 0) return POLL_JITTER_MS;
  const exp = Math.min(failCount, POLL_BACKOFF_MAX_N);
  return Math.min(intervalMs * Math.pow(2, exp), POLL_BACKOFF_CAP_MS);
}

export interface LoginFlowCallbacks {
  onCodeReceived: (data: { verificationUrl: string; expiresIn: number }) => void;
  onPolling: () => void;
  onSuccess: (user: { email: string; aliyunId: string }) => void;
  onError: (error: string) => void;
  onExpired: () => void;
}

export async function executeLogin(callbacks: LoginFlowCallbacks): Promise<boolean> {
  const client = await createClient();

  try {
    const initResponse = await client.loginInit();

    callbacks.onCodeReceived({
      verificationUrl: initResponse.verification_url,
      expiresIn: initResponse.expires_in,
    });

    // Use time-based deadline instead of fixed attempt count — handles slow_down correctly
    const deadline = Date.now() + initResponse.expires_in * 1000;
    // Track current interval — may be increased by slow_down per RFC 8628
    let currentInterval = initResponse.interval;
    if (currentInterval <= 0) currentInterval = 5; // defensive fallback
    // Track consecutive transient failures for Full Jitter exponential backoff
    let failCount = 0;

    const stdin = suppressStdin();
    try {
      while (Date.now() < deadline) {
        // Sleep = interval + Full Jitter window (window grows on consecutive
        // failures, resets immediately on any successful poll response).
        const intervalMs = currentInterval * 1000;
        const jitterWindow = computeJitterWindowMs(intervalMs, failCount);
        await Promise.race([
          sleep(intervalMs + Math.floor(Math.random() * jitterWindow)),
          stdin.onAbort,
        ]);
        if (stdin.aborted()) break;
        callbacks.onPolling();

        try {
          const pollResponse = await client.loginPoll(initResponse.token);
          // Server reachable — restore normal cadence immediately
          failCount = 0;

          switch (pollResponse.status) {
            case 'complete':
              if (pollResponse.credentials) {
                writeCredentials(pollResponse.credentials);
                callbacks.onSuccess(pollResponse.credentials.user);
                return true;
              }
              break;

            case 'authorization_pending':
              // Continue polling at current interval
              continue;

            case 'slow_down':
              // Per RFC 8628 §3.5: increase polling interval by 5 seconds
              // and use the new interval for ALL subsequent polls
              currentInterval += 5;
              continue;

            case 'access_denied':
              callbacks.onError('Authorization was denied by the user.');
              return false;

            case 'expired_token':
              callbacks.onExpired();
              return false;
          }
        } catch (err) {
          // Check if the error indicates device code expiration
          const message = err instanceof Error ? err.message : String(err);
          if (/expired/i.test(message)) {
            callbacks.onExpired();
            return false;
          }
          if (/access_denied/i.test(message)) {
            callbacks.onError('Authorization was denied by the user.');
            return false;
          }
          // Transient network/5xx error — grow Full Jitter window for next sleep
          failCount += 1;
          continue;
        }
      }

      // Timed out
      callbacks.onExpired();
      return false;
    } finally {
      stdin.restore();
    }
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === 'repl.exit.intercepted') throw error;
    callbacks.onError(error instanceof Error ? error.message : 'Login flow failed');
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Persisted state for two-stage login (--init-only / --complete). */
export interface LoginPendingState {
  token: string;
  verification_url: string;
  expires_in: number;
  interval: number;
  code_verifier?: string;
  /** Mode used to acquire this pending session. Defaults to `device-flow` when absent for backwards compatibility with sessions created before the PKCE migration. */
  auth_mode?: AuthMode;
  /** ISO timestamp when the device code was issued */
  created_at: string;
}

/** Save pending login state to disk after --init-only. */
export function writePendingState(init: LoginInitResponse | LoginInitResult): void {
  const filePath = getDeviceFlowPendingPath();
  mkdirSync(dirname(filePath), { recursive: true });
  const state: LoginPendingState = {
    token: init.token,
    verification_url: init.verification_url,
    expires_in: init.expires_in,
    interval: init.interval,
    code_verifier: init.code_verifier,
    auth_mode: 'auth_mode' in init ? init.auth_mode : init.code_verifier ? 'pkce' : 'device-flow',
    created_at: new Date().toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/** Read and validate pending login state. Returns null if missing or expired. */
export function readPendingState(): LoginPendingState | null {
  const filePath = getDeviceFlowPendingPath();
  if (!existsSync(filePath)) return null;
  try {
    const state: LoginPendingState = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Backfill auth_mode for sessions written before the PKCE migration.
    if (!state.auth_mode) {
      state.auth_mode = state.code_verifier ? 'pkce' : 'device-flow';
    }
    // Check expiry
    const elapsed = (Date.now() - new Date(state.created_at).getTime()) / 1000;
    if (elapsed >= state.expires_in) {
      removePendingState();
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/** Remove pending state file after --complete finishes (success or failure). */
export function removePendingState(): void {
  const filePath = getDeviceFlowPendingPath();
  try {
    unlinkSync(filePath);
  } catch {
    // ignore if already deleted
  }
}

/**
 * Init-only: request device code, persist state, return init response.
 * Does NOT poll — caller exits immediately after outputting the result.
 */
export async function executeLoginInitOnly(): Promise<LoginInitResult> {
  const client = await createClient();
  const initResponse = await client.loginInit();
  writePendingState(initResponse);
  return initResponse;
}

/** Options for executeLoginComplete(). */
export interface LoginCompleteOptions {
  /** Maximum seconds to poll before giving up (default: 120). */
  timeoutSeconds?: number;
}

/**
 * Complete: poll a pending login session until success/failure/timeout.
 *
 *  - Reads pending state from disk
 *  - Restores PKCE verifier into the HTTP client
 *  - Computes effective timeout = min(callerTimeout, remainingExpiry)
 *  - Loops: sleep → poll → handle status
 *  - Handles slow_down (interval += 5), network errors (continue), etc.
 */
export async function executeLoginComplete(
  callbacks: LoginFlowCallbacks,
  options?: LoginCompleteOptions,
): Promise<boolean> {
  // Snapshot file presence before readPendingState() runs, since it deletes
  // the file on expiry before returning null — letting us tell the two apart.
  const pendingExisted = existsSync(getDeviceFlowPendingPath());
  const state = readPendingState();
  if (!state) {
    if (pendingExisted) {
      callbacks.onExpired();
    } else {
      callbacks.onError('No pending login session found. Run login without --complete first.');
    }
    return false;
  }

  const client = await createClient();

  // Check expiry
  const elapsed = (Date.now() - new Date(state.created_at).getTime()) / 1000;
  if (elapsed >= state.expires_in) {
    removePendingState();
    callbacks.onExpired();
    return false;
  }

  // Compute effective timeout: min(caller timeout, remaining device-code lifetime)
  const callerTimeout = options?.timeoutSeconds ?? 120;
  const remainingSec = Math.max(10, state.expires_in - elapsed);
  const effectiveTimeout = Math.min(callerTimeout, remainingSec);

  let interval = state.interval || 5;
  if (interval <= 0) interval = 5;
  const maxAttempts = Math.ceil(effectiveTimeout / interval);
  // Track consecutive transient failures for Full Jitter exponential backoff
  let failCount = 0;

  const stdin = suppressStdin();
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Sleep = interval + Full Jitter window (window grows on consecutive
      // failures, resets immediately on any successful poll response).
      const intervalMs = interval * 1000;
      const jitterWindow = computeJitterWindowMs(intervalMs, failCount);
      await Promise.race([
        sleep(intervalMs + Math.floor(Math.random() * jitterWindow)),
        stdin.onAbort,
      ]);
      if (stdin.aborted()) break;
      callbacks.onPolling();

      // Progress to stderr every ~10 seconds
      if (attempt % Math.max(1, Math.round(10 / interval)) === 0) {
        process.stderr.write(`  Polling... attempt ${attempt}/${maxAttempts}\n`);
      }

      let pollResponse;
      try {
        pollResponse = await client.loginPoll(state.token, interval, state.code_verifier);
        // Server reachable — restore normal cadence immediately
        failCount = 0;
      } catch {
        // Transient network/5xx error — grow Full Jitter window for next sleep
        failCount += 1;
        continue;
      }

      switch (pollResponse.status) {
        case 'complete':
          if (pollResponse.credentials) {
            writeCredentials(pollResponse.credentials);
            callbacks.onSuccess(pollResponse.credentials.user);
            removePendingState();
            return true;
          }
          // Unexpected: complete but no credentials
          callbacks.onError('Authorization completed but no credentials received.');
          removePendingState();
          return false;

        case 'authorization_pending':
          // Keep polling
          continue;

        case 'slow_down':
          // Per RFC 8628 §3.5: increase interval by 5 seconds
          interval += 5;
          continue;

        case 'access_denied':
          callbacks.onError('Authorization was denied by the user.');
          removePendingState();
          return false;

        case 'expired_token':
          callbacks.onExpired();
          removePendingState();
          return false;

        default:
          // Unknown status — continue polling
          continue;
      }
    }

    // Timed out
    callbacks.onExpired();
    removePendingState();
    return false;
  } finally {
    stdin.restore();
  }
}
