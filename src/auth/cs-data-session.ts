import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { clearCredentialsCache, resolveCredentials, isTokenExpired } from './credentials.js';
import { readEncryptedCredentials, writeEncryptedCredentials } from './crypto-store.js';
import { isPlaintextMode } from './keychain.js';
import { isCredentialToken } from './credential-token.js';
import { getCredentialsPath } from '../config/paths.js';
import { RequestTimeoutError } from '../api/base-client.js';
import { authRequiredError, configError, tokenExpiredError } from '../utils/errors.js';
import type { CsDataContext, Credentials } from '../types/auth.js';

export interface CsDataSession {
  credentials: Credentials;
  key: string;
  token?: string;
}

type IssueToken = (session: CsDataSession, signal: AbortSignal) => Promise<string>;
interface PendingIssue {
  controller: AbortController;
  users: number;
  promise: Promise<CsDataSession>;
}
const pendingIssues = new Map<string, PendingIssue>();

export function checkCsDataSignal(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('cs-data request aborted', 'AbortError');
}

export function awaitCsDataOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      try {
        checkCsDataSignal(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        try {
          checkCsDataSignal(signal);
          resolve(value);
        } catch (error) {
          reject(error);
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export function createCsDataBudget(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(
    () => controller.abort(new RequestTimeoutError(timeoutMs, 'cs-data request')),
    timeoutMs,
  );
  return {
    controller,
    signal: controller.signal,
    remaining: () => Math.max(0, deadline - Date.now()),
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    },
  };
}

function readSession(context: CsDataContext): CsDataSession {
  if (isPlaintextMode())
    throw configError('cs-data credentials require encrypted storage; disable plaintext mode.');
  // Bypass the normal one-minute cache when checking an in-flight request's owner.
  clearCredentialsCache();
  const credentials = resolveCredentials()?.credentials;
  if (!credentials) throw authRequiredError();
  if (!Number.isFinite(Date.parse(credentials.expires_at)) || isTokenExpired(credentials))
    throw tokenExpiredError();
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        credentials.access_token,
        credentials.expires_at,
        context.issuer,
        context.gateway,
        context.environment,
        context.region,
        context.site,
      ]),
    )
    .digest('hex');
  return { credentials, key };
}

export function currentCsDataSession(
  context: CsDataContext,
  expected: CsDataSession,
  signal: AbortSignal,
): CsDataSession {
  checkCsDataSignal(signal);
  const current = readSession(context);
  if (current.key !== expected.key) throw authRequiredError();
  return { ...current, token: expected.token };
}

function readCachedToken(key: string): string | undefined {
  // Keep the existing on-disk suffix so renaming this channel preserves cached sessions.
  const cached = readEncryptedCredentials(`${getCredentialsPath()}.console`);
  return cached?.key === key && isCredentialToken(cached.token) ? cached.token : undefined;
}

function saveCachedToken(key: string, token: string): void {
  const path = `${getCredentialsPath()}.console`;
  const temporary = `${path}.${randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Only this disposable cache is replaced; a late refresh never writes root credentials.
    writeEncryptedCredentials({ key, token }, temporary);
    renameSync(temporary, path);
  } catch {
    throw configError('Unable to save cs-data token cache.');
  } finally {
    for (const file of [temporary, `${temporary}.tmp`]) {
      try {
        unlinkSync(file);
      } catch {
        /* Missing or abandoned encrypted cache files are harmless. */
      }
    }
  }
}

export function invalidateCsDataCredential(expected: CsDataSession): void {
  if (!expected.token || readCachedToken(expected.key) !== expected.token) return;
  try {
    unlinkSync(`${getCredentialsPath()}.console`);
  } catch {
    /* The next refresh replaces this cache. */
  }
}

export async function acquireCsDataSession(
  context: CsDataContext,
  issue: IssueToken,
  signal: AbortSignal,
  remainingMs: number,
  rejected?: CsDataSession,
): Promise<{ session: CsDataSession; fresh: boolean }> {
  checkCsDataSignal(signal);
  if (remainingMs <= 0) throw new RequestTimeoutError(0, 'cs-data request');
  const session = rejected ? currentCsDataSession(context, rejected, signal) : readSession(context);
  const cached = readCachedToken(session.key);
  if (cached && cached !== rejected?.token)
    return { session: { ...session, token: cached }, fresh: false };
  let pending = pendingIssues.get(session.key);
  if (!pending || pending.controller.signal.aborted) {
    const budget = createCsDataBudget(undefined, remainingMs);
    const controller = budget.controller;
    const created: PendingIssue = { controller, users: 0, promise: Promise.resolve(session) };
    created.promise = Promise.resolve()
      .then(async () => {
        currentCsDataSession(context, session, controller.signal);
        const token = await awaitCsDataOperation(
          issue(session, controller.signal),
          controller.signal,
        );
        if (!isCredentialToken(token))
          throw configError('Token issuance returned an invalid credential.');
        currentCsDataSession(context, session, controller.signal);
        saveCachedToken(session.key, token);
        return { ...session, token };
      })
      .finally(() => {
        budget.dispose();
        if (pendingIssues.get(session.key) === created) pendingIssues.delete(session.key);
      });
    pendingIssues.set(session.key, created);
    pending = created;
  }
  pending.users += 1;
  try {
    const acquired = await awaitCsDataOperation(pending.promise, signal);
    return { session: currentCsDataSession(context, acquired, signal), fresh: true };
  } finally {
    pending.users -= 1;
    if (pending.users === 0) pending.controller.abort();
  }
}
