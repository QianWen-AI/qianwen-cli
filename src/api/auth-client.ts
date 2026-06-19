/** Credential lifecycle and connectivity primitives. */
import { createHash, randomBytes } from 'node:crypto';

import {
  resolveCredentials,
  deleteCredentials,
  isTokenExpired,
  tryExtractUserFromToken,
} from '../auth/credentials.js';
import { getOrCreateClientId } from '../auth/client-id.js';
import { getEffectiveConfig } from '../config/manager.js';
import { site } from '../site.js';
import type {
  AuthStatus,
  Credentials,
  DeviceFlowInitResponse,
  DeviceFlowPollResponse,
  UserInfo,
} from '../types/auth.js';
import type { RawApiEnvelope } from '../types/api-envelope.js';

import { createBaseClient, type BaseClient } from './base-client.js';
import { buildRequest } from './request-adapter.js';
import { startRequest, endRequest, isEnabled } from './debug-buffer.js';

declare const __VERSION__: string;

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const AUTH_PRODUCT = 'qianwen-auth';

const ACTION = {
  LOGOUT: 'Logout',
  PING: 'Ping',
  VERSION: 'CheckVersion',
} as const;

const DEFAULT_TIMEOUT_MS = 60_000;
const AUTH_REQUEST_TIMEOUT_MS = 30_000;

// ────────────────────────────────────────────────────────────────────
// PKCE primitives (RFC 7636)
// ────────────────────────────────────────────────────────────────────

/**
 * Generate a 43-character base64url verifier from 32 random bytes.
 * Sits inside RFC 7636's 43–128 char window using only the unreserved
 * alphabet [A-Z a-z 0-9 -._~] (base64url is a strict subset).
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 challenge derivation per RFC 7636 §4.2 (S256). */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface PingResult {
  success: boolean;
  error?: string;
}

export interface VersionResult {
  latest_version: string;
  download_url?: string;
}

export interface AuthClient {
  /** Device flow init (no PKCE). */
  authorizeDeviceFlow(): Promise<DeviceFlowInitResponse>;
  /** Single-shot device-flow poll. The caller drives the polling cadence. */
  pollDeviceFlow(
    token: string,
    intervalSec?: number,
    codeVerifier?: string,
  ): Promise<DeviceFlowPollResponse>;

  /** PKCE init: locally generate verifier, send only the challenge. */
  authorizePKCE(): Promise<DeviceFlowInitResponse>;
  /** Single-shot PKCE poll. The caller passes the verifier preserved from init. */
  pollPKCE(
    token: string,
    intervalSec: number,
    codeVerifier: string,
  ): Promise<DeviceFlowPollResponse>;

  getAuthStatus(): Promise<AuthStatus>;
  logout(): Promise<void>;
  ping(): Promise<PingResult>;
  checkVersion(): Promise<VersionResult>;
}

export interface CreateAuthClientOptions {
  baseClient?: BaseClient;
  timeoutMs?: number;
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers — Device Flow REST surface
// ────────────────────────────────────────────────────────────────────

function getAuthBaseUrl(): string {
  const endpoint = getEffectiveConfig()['auth.endpoint'] as string;
  return endpoint.replace(/\/+$/, '');
}

function getAuthUserAgent(): string {
  const version = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev';
  return `${site.userAgentPrefix}/${version}`;
}

/** Direct REST call for the auth surface. */
async function authRequest<T>(url: string): Promise<T> {
  const requestHeaders: Record<string, string> = { 'User-Agent': getAuthUserAgent() };
  const debugId = isEnabled() ? startRequest('POST', url, requestHeaders, null, 'auth') : -1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    if (debugId >= 0) endRequest(debugId, null, 'NetworkError', null, true);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${AUTH_REQUEST_TIMEOUT_MS / 1000}s\n  URL: ${url}`);
    }
    const baseMsg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? err.cause : undefined;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    const parts = [`Network request failed: ${baseMsg}`, `  URL: ${url}`];
    if (causeMsg) parts.push(`  Cause: ${causeMsg}`);
    const enriched = new Error(parts.join('\n'));
    if (err instanceof Error) enriched.cause = err;
    throw enriched;
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // ignore body read failure
    }
    if (debugId >= 0) {
      endRequest(debugId, response.status, response.statusText, body, true);
    }
    const truncated = body.length > 500 ? body.slice(0, 500) + '...(truncated)' : body;
    const parts = [`HTTP ${response.status}: ${response.statusText}`, `  URL: ${url}`];
    if (truncated) parts.push(`  Response: ${truncated}`);
    throw new Error(parts.join('\n'));
  }

  if (debugId >= 0) {
    endRequest(debugId, response.status, response.statusText, '(auth - body redacted)', false);
  }

  return (await response.json()) as T;
}

interface RawInitData {
  Token?: string;
  VerificationUrl?: string;
  ExpiresIn?: number;
  Interval?: number;
}

interface RawInitResponse {
  Success?: boolean;
  Data?: RawInitData;
}

async function postDeviceCode(codeChallenge: string | null): Promise<DeviceFlowInitResponse> {
  const baseUrl = getAuthBaseUrl();
  const clientId = getOrCreateClientId();
  let url = `${baseUrl}/cli/device/code?client_id=${encodeURIComponent(clientId)}`;
  if (codeChallenge) {
    url += `&code_challenge=${encodeURIComponent(codeChallenge)}` + `&code_challenge_method=S256`;
  }

  const raw = await authRequest<RawInitResponse>(url);
  if (raw.Success !== true || !raw.Data) {
    throw new Error('Device flow init failed: server returned Success=false');
  }
  const data = raw.Data;
  if (
    typeof data.Token !== 'string' ||
    typeof data.VerificationUrl !== 'string' ||
    typeof data.ExpiresIn !== 'number' ||
    typeof data.Interval !== 'number'
  ) {
    throw new Error('Device flow init failed: malformed response payload');
  }

  return {
    token: data.Token,
    verification_url: data.VerificationUrl,
    expires_in: data.ExpiresIn,
    interval: data.Interval,
  };
}

interface RawPollUserPascal {
  Id?: number;
  Email?: string;
  AliyunId?: string;
  Organization?: string;
}

interface RawPollUserSnake {
  id?: number;
  email?: string;
  aliyunId?: string;
  organization?: string;
}

interface RawPollResponse {
  // PascalCase shape
  Success?: boolean;
  Data?: {
    Status?: string;
    Credentials?: {
      AccessToken?: string;
      RefreshToken?: string;
      ExpireTime?: string;
      User?: RawPollUserPascal;
    };
  };
  // snake_case fallback shape (kept for forward compatibility)
  status?: string;
  credentials?: {
    access_token?: string;
    refresh_token?: string;
    expire_time?: string;
    user?: RawPollUserSnake;
  };
}

function normalizeUser(
  pascal: RawPollUserPascal | undefined,
  snake: RawPollUserSnake | undefined,
): UserInfo {
  if (pascal) {
    return {
      id: pascal.Id,
      email: pascal.Email ?? '',
      aliyunId: pascal.AliyunId ?? pascal.Organization ?? '',
    };
  }
  if (snake) {
    return {
      id: snake.id,
      email: snake.email ?? '',
      aliyunId: snake.aliyunId ?? snake.organization ?? '',
    };
  }
  return { email: '', aliyunId: '' };
}

async function postDeviceToken(
  token: string,
  codeVerifier?: string,
): Promise<DeviceFlowPollResponse> {
  const baseUrl = getAuthBaseUrl();
  const clientId = getOrCreateClientId();
  let url =
    `${baseUrl}/cli/device/token` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&token=${encodeURIComponent(token)}`;
  if (codeVerifier) {
    url += `&code_verifier=${encodeURIComponent(codeVerifier)}`;
  }

  let raw: RawPollResponse;
  try {
    raw = await authRequest<RawPollResponse>(url);
  } catch (err) {
    // Servers may surface terminal device-flow signals via HTTP error bodies.
    const message = err instanceof Error ? err.message : String(err);
    if (/expired/i.test(message)) return { status: 'expired_token' };
    if (/access_denied/i.test(message)) return { status: 'access_denied' };
    if (/slow_down/i.test(message)) return { status: 'slow_down' };
    throw err;
  }

  const rawStatus = (raw.Data?.Status ?? raw.status ?? 'authorization_pending').toLowerCase();
  const status = rawStatus as DeviceFlowPollResponse['status'];

  if (status !== 'complete') {
    return { status };
  }

  const credPascal = raw.Data?.Credentials;
  const credSnake = raw.credentials;
  const accessToken = credPascal?.AccessToken ?? credSnake?.access_token;
  const expireTime = credPascal?.ExpireTime ?? credSnake?.expire_time;

  if (!accessToken) {
    return { status: 'complete' };
  }

  const credentials: Credentials = {
    access_token: accessToken,
    expires_at: expireTime ?? '',
    user: normalizeUser(credPascal?.User, credSnake?.user),
  };
  return { status: 'complete', credentials };
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers — gateway-bound maintenance endpoints
// ────────────────────────────────────────────────────────────────────

type AuthMode = 'required' | 'optional' | 'none';

interface AuthCallOptions {
  authMode: AuthMode;
}

async function callAuthApi<T>(
  base: BaseClient,
  action: string,
  params: Record<string, unknown>,
  options: AuthCallOptions,
): Promise<T> {
  const adapted = buildRequest('A', {
    product: AUTH_PRODUCT,
    action,
    params,
    authOptional: options.authMode !== 'required',
  });
  const raw = await base.request<RawApiEnvelope<T>>({
    url: adapted.url,
    method: 'POST',
    headers: adapted.headers,
    body: adapted.body,
    authMode: options.authMode,
    context: 'auth',
  });
  if (raw.code !== '200') {
    throw new Error(`Auth gateway error: ${raw.message ?? raw.code}`);
  }
  return raw.data as T;
}

function userFromCredentials(creds: Credentials | null | undefined): UserInfo | undefined {
  if (!creds) return undefined;
  return creds.user;
}

// ────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────

export function createAuthClient(opts?: CreateAuthClientOptions): AuthClient {
  const base =
    opts?.baseClient ?? createBaseClient({ timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  return {
    async authorizeDeviceFlow(): Promise<DeviceFlowInitResponse> {
      // Device-flow init derives a PKCE pair locally and embeds the
      // SHA-256 challenge in the query string (RFC 7636). The verifier is
      // returned to the caller so the subsequent poll can complete the
      // exchange — the auth server retains no session state for it.
      const verifier = generateCodeVerifier();
      const challenge = deriveCodeChallenge(verifier);
      const result = await postDeviceCode(challenge);
      return { ...result, code_verifier: verifier };
    },

    async pollDeviceFlow(token, _intervalSec, codeVerifier): Promise<DeviceFlowPollResponse> {
      return postDeviceToken(token, codeVerifier);
    },

    async authorizePKCE(): Promise<DeviceFlowInitResponse> {
      const verifier = generateCodeVerifier();
      const challenge = deriveCodeChallenge(verifier);
      const result = await postDeviceCode(challenge);
      return { ...result, code_verifier: verifier };
    },

    async pollPKCE(token, _intervalSec, codeVerifier): Promise<DeviceFlowPollResponse> {
      return postDeviceToken(token, codeVerifier);
    },

    async getAuthStatus(): Promise<AuthStatus> {
      const resolved = resolveCredentials();
      if (!resolved) {
        return { authenticated: false, server_verified: false };
      }
      if (resolved.credentials && isTokenExpired(resolved.credentials)) {
        return { authenticated: false, server_verified: false };
      }

      const accessToken = resolved.credentials?.access_token ?? '';
      const baseUrl = (getEffectiveConfig()['api.endpoint'] as string).replace(/\/+$/, '');
      const url = `${baseUrl}/api/account/info.json`;

      const token = {
        expires_at: resolved.credentials?.expires_at ?? 'unknown',
        scopes: ['inference:read', 'usage:read', 'config:write'],
      };
      const localUser =
        userFromCredentials(resolved.credentials) ??
        tryExtractUserFromToken(accessToken) ??
        undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        return {
          authenticated: true,
          server_verified: false,
          auth_mode: resolved.auth_mode,
          source: resolved.source,
          warning: `Server unreachable: ${message}`,
          user: localUser,
          token,
        };
      }

      if (!response.ok) {
        return {
          authenticated: true,
          server_verified: false,
          auth_mode: resolved.auth_mode,
          source: resolved.source,
          warning: `Server verification failed (HTTP ${response.status})`,
          user: localUser,
          token,
        };
      }

      const json = (await response.json()) as { data?: { aliyunId?: string; email?: string } };
      const serverUser: UserInfo | undefined =
        json.data?.aliyunId || json.data?.email
          ? { aliyunId: json.data.aliyunId ?? '', email: json.data.email ?? '' }
          : undefined;

      return {
        authenticated: true,
        server_verified: true,
        auth_mode: resolved.auth_mode,
        source: resolved.source,
        user: serverUser ?? localUser,
        token,
      };
    },

    async logout(): Promise<void> {
      // Best-effort server revocation — local cleanup must always run, even
      // when the network call fails or the user is already logged out.
      try {
        await callAuthApi(base, ACTION.LOGOUT, {}, { authMode: 'optional' });
      } catch {
        // intentional: server failures must not block local logout
      } finally {
        deleteCredentials();
      }
    },

    async ping(): Promise<PingResult> {
      try {
        await callAuthApi(base, ACTION.PING, {}, { authMode: 'optional' });
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async checkVersion(): Promise<VersionResult> {
      return callAuthApi<VersionResult>(base, ACTION.VERSION, {}, { authMode: 'optional' });
    },
  };
}
