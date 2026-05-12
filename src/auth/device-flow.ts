import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { createClient } from '../api/client.js';
import { writeCredentials } from './credentials.js';
import { getDeviceFlowPendingPath } from '../config/paths.js';
import type { DeviceFlowInitResponse } from '../types/auth.js';

/**
 * Base random jitter window (ms) added to each poll interval in NORMAL state.
 * Purpose: when many CLI instances start login concurrently (CI matrix /
 * agent fleet / multi-terminal), the server-advised `interval` is identical
 * for all of them, causing synchronized polling pulses. A 0~1s jitter
 * desynchronizes them with negligible UX impact.
 */
const POLL_JITTER_MS = 1000;

/** Hard cap (ms) for the random jitter window when server is unhealthy. */
const POLL_BACKOFF_CAP_MS = 30_000;

/** Cap on consecutive failures considered for backoff growth (2^MAX = 8x). */
const POLL_BACKOFF_MAX_N = 3;

/**
 * Compute the random jitter window (ms) for the next poll sleep.
 *
 * Final sleep = intervalMs + random(0, returnedWindow), preserving the
 * server-advised `intervalMs` as a hard lower bound (RFC 8628 §3.4).
 *
 * - Normal state (failCount<=0): returns POLL_JITTER_MS, just enough to
 *   desynchronize concurrent CLI instances on a healthy server.
 * - Error state (failCount>0): returns Full Jitter exponential backoff
 *   window = min(intervalMs * 2^failCount, POLL_BACKOFF_CAP_MS), giving
 *   the server room to recover during transient outages.
 *
 * Why Full Jitter (not Equal Jitter)? Equal Jitter has a non-zero lower
 * bound that re-synchronizes concurrent retries near that bound, weakening
 * desynchronization. Full Jitter (window starting at 0) maximizes the
 * spread across concurrent clients, optimal for server protection. See
 * AWS Architecture Blog "Exponential Backoff and Jitter".
 */
function computeJitterWindowMs(intervalMs: number, failCount: number): number {
  if (failCount <= 0) return POLL_JITTER_MS;
  const exp = Math.min(failCount, POLL_BACKOFF_MAX_N);
  return Math.min(intervalMs * Math.pow(2, exp), POLL_BACKOFF_CAP_MS);
}

export interface DeviceFlowCallbacks {
  onCodeReceived: (data: { verificationUrl: string; expiresIn: number }) => void;
  onPolling: () => void;
  onSuccess: (user: { email: string; aliyunId: string }) => void;
  onError: (error: string) => void;
  onExpired: () => void;
}

/**
 * Execute the Device Flow login process.
 *
 * 1. Request device code from auth server (with PKCE)
 * 2. Display code + URL to user via callbacks
 * 3. Poll for authorization completion
 * 4. On success, write credentials to local cache
 */
export async function executeDeviceFlow(callbacks: DeviceFlowCallbacks): Promise<boolean> {
  const client = await createClient();

  try {
    // Step 1: Initialize device flow (PKCE code_challenge included)
    const initResponse = await client.deviceFlowInit();

    // Step 2: Notify UI to display code
    callbacks.onCodeReceived({
      verificationUrl: initResponse.verification_url,
      expiresIn: initResponse.expires_in,
    });

    // Step 3: Poll for completion
    // Use time-based deadline instead of fixed attempt count — handles slow_down correctly
    const deadline = Date.now() + initResponse.expires_in * 1000;
    // Track current interval — may be increased by slow_down per RFC 8628
    let currentInterval = initResponse.interval;
    if (currentInterval <= 0) currentInterval = 5; // defensive fallback
    // Track consecutive transient failures for Full Jitter exponential backoff
    let failCount = 0;

    while (Date.now() < deadline) {
      // Sleep = interval + Full Jitter window (window grows on consecutive
      // failures, resets immediately on any successful poll response).
      const intervalMs = currentInterval * 1000;
      const jitterWindow = computeJitterWindowMs(intervalMs, failCount);
      await sleep(intervalMs + Math.floor(Math.random() * jitterWindow));
      callbacks.onPolling();

      try {
        const pollResponse = await client.deviceFlowPoll(initResponse.token);
        // Server reachable — restore normal cadence immediately
        failCount = 0;

        switch (pollResponse.status) {
          case 'complete':
            if (pollResponse.credentials) {
              // Step 4: Write credentials
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
  } catch (error) {
    callbacks.onError(error instanceof Error ? error.message : 'Device flow failed');
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Persisted state for two-stage login (--init-only / --complete). */
export interface DeviceFlowPendingState {
  token: string;
  verification_url: string;
  expires_in: number;
  interval: number;
  code_verifier?: string;
  /** ISO timestamp when the device code was issued */
  created_at: string;
}

/** Save pending device-flow state to disk after --init-only. */
export function writePendingState(init: DeviceFlowInitResponse): void {
  const filePath = getDeviceFlowPendingPath();
  mkdirSync(dirname(filePath), { recursive: true });
  const state: DeviceFlowPendingState = {
    token: init.token,
    verification_url: init.verification_url,
    expires_in: init.expires_in,
    interval: init.interval,
    code_verifier: init.code_verifier,
    created_at: new Date().toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/** Read and validate pending device-flow state. Returns null if missing or expired. */
export function readPendingState(): DeviceFlowPendingState | null {
  const filePath = getDeviceFlowPendingPath();
  if (!existsSync(filePath)) return null;
  try {
    const state: DeviceFlowPendingState = JSON.parse(readFileSync(filePath, 'utf-8'));
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
export async function executeDeviceFlowInitOnly(): Promise<DeviceFlowInitResponse> {
  const client = await createClient();
  const initResponse = await client.deviceFlowInit();
  writePendingState(initResponse);
  return initResponse;
}

/** Options for executeDeviceFlowComplete(). */
export interface DeviceFlowCompleteOptions {
  /** Maximum seconds to poll before giving up (default: 120). */
  timeoutSeconds?: number;
}

/**
 * Complete: poll a pending device-flow session until success/failure/timeout.
 *
 * Mirrors the logic of auto-login.cjs `pollForCompletion()`:
 *  - Reads pending state from disk
 *  - Restores PKCE verifier into the HTTP client
 *  - Computes effective timeout = min(callerTimeout, remainingExpiry)
 *  - Loops: sleep → poll → handle status
 *  - Handles slow_down (interval += 5), network errors (continue), etc.
 */
export async function executeDeviceFlowComplete(
  callbacks: DeviceFlowCallbacks,
  options?: DeviceFlowCompleteOptions,
): Promise<boolean> {
  const state = readPendingState();
  if (!state) {
    callbacks.onError('No pending device-flow session found. Run login without --complete first.');
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

  // Restore PKCE verifier from saved state
  if (state.code_verifier) {
    client.setPkceVerifier(state.code_verifier);
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Sleep = interval + Full Jitter window (window grows on consecutive
    // failures, resets immediately on any successful poll response).
    const intervalMs = interval * 1000;
    const jitterWindow = computeJitterWindowMs(intervalMs, failCount);
    await sleep(intervalMs + Math.floor(Math.random() * jitterWindow));
    callbacks.onPolling();

    // Progress to stderr every ~10 seconds
    if (attempt % Math.max(1, Math.round(10 / interval)) === 0) {
      process.stderr.write(`  Polling... attempt ${attempt}/${maxAttempts}\n`);
    }

    let pollResponse;
    try {
      pollResponse = await client.deviceFlowPoll(state.token);
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
}
