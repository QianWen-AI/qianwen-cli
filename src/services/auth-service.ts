/**
 * AuthService — orchestrates authentication workflows on top of AuthClient.
 *
 * Responsibilities:
 *   - Login (Device Flow or PKCE) with Device Flow fallback.
 *   - Auth status retrieval (server check + JWT-claim fallback when offline).
 *   - Logout (best-effort server revocation, always-on local cleanup).
 */
import {
  resolveCredentials,
  isTokenExpired,
  tryExtractUserFromToken,
  deleteCredentials,
} from '../auth/credentials.js';
import type {
  AuthStatus,
  Credentials,
  DeviceFlowInitResponse,
  DeviceFlowPollResponse,
} from '../types/auth.js';

import type { AuthClient } from '../api/auth-client.js';

/** Auth mode: PKCE preferred, Device Flow fallback. */
export type AuthMode = 'pkce' | 'device-flow';

export interface AuthModeContext {
  isInteractiveTty: boolean;
}

export interface LoginInitResult extends DeviceFlowInitResponse {
  auth_mode: AuthMode;
}

/** Simple mode selection: PKCE when interactive TTY, Device Flow otherwise. */
function selectAuthMode(ctx: AuthModeContext): AuthMode {
  return ctx.isInteractiveTty ? 'pkce' : 'device-flow';
}

export class AuthService {
  private pkceVerifier: string | null = null;

  constructor(private readonly authClient: AuthClient) {}

  async getAuthStatus(): Promise<AuthStatus> {
    const resolved = resolveCredentials();
    if (!resolved) {
      return { authenticated: false, server_verified: false };
    }
    if (resolved.credentials && isTokenExpired(resolved.credentials)) {
      return { authenticated: false, server_verified: false };
    }

    try {
      return await this.authClient.getAuthStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.localFallback(resolved.credentials, `Server unreachable: ${message}`);
    }
  }

  async loginInit(ctx?: AuthModeContext): Promise<LoginInitResult> {
    const mode = selectAuthMode(ctx ?? defaultContext());
    if (mode === 'pkce') {
      const result = await this.authClient.authorizePKCE();
      this.pkceVerifier = result.code_verifier ?? null;
      return { ...result, auth_mode: 'pkce' };
    }
    const result = await this.authClient.authorizeDeviceFlow();
    this.pkceVerifier = null;
    return { ...result, auth_mode: 'device-flow' };
  }

  async loginPoll(
    token: string,
    intervalSec = 5,
    verifier?: string,
  ): Promise<DeviceFlowPollResponse> {
    const effectiveVerifier = verifier ?? this.pkceVerifier ?? undefined;
    if (effectiveVerifier) {
      return this.authClient.pollPKCE(token, intervalSec, effectiveVerifier);
    }
    return this.authClient.pollDeviceFlow(token, intervalSec);
  }

  async logout(): Promise<void> {
    try {
      await this.authClient.logout();
    } finally {
      deleteCredentials();
    }
  }

  private localFallback(credentials: Credentials | null | undefined, warning: string): AuthStatus {
    if (!credentials) {
      return { authenticated: false, server_verified: false, warning };
    }

    let user = credentials.user ?? { email: '', aliyunId: '' };
    if (!user.email?.trim() && !user.aliyunId?.trim()) {
      const jwtUser = tryExtractUserFromToken(credentials.access_token);
      if (jwtUser) user = jwtUser;
    }

    return {
      authenticated: true,
      server_verified: false,
      auth_mode: 'device_flow',
      warning,
      user,
      token: {
        expires_at: credentials.expires_at ?? 'unknown',
        scopes: ['inference:read', 'usage:read', 'config:write'],
      },
    };
  }
}

function defaultContext(): AuthModeContext {
  return {
    isInteractiveTty: Boolean(process.stdout.isTTY && process.stdin.isTTY),
  };
}
