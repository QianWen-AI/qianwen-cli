/**
 * Tests for AuthService.
 *
 * Strategy:
 *   - Mock the credentials module (resolveCredentials / isTokenExpired /
 *     tryExtractUserFromToken / deleteCredentials) so we can drive each branch
 *     deterministically.
 *   - Inject a stub AuthClient instead of mocking fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const credState = {
  resolved: null as null | {
    source: 'keychain' | 'encrypted_file';
    auth_mode: 'device_flow';
    access_token: string;
    credentials?: {
      access_token: string;
      expires_at: string;
      user: { email: string; aliyunId: string };
    };
  },
  isExpired: false,
  jwtUser: null as null | { email: string; aliyunId: string },
  deleteCalled: false,
};

vi.mock('../../src/auth/credentials.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCredentials: vi.fn(() => credState.resolved),
    isTokenExpired: vi.fn(() => credState.isExpired),
    tryExtractUserFromToken: vi.fn(() => credState.jwtUser),
    deleteCredentials: vi.fn(() => {
      credState.deleteCalled = true;
    }),
  };
});

import { AuthService } from '../../src/services/auth-service.js';
import type { AuthClient } from '../../src/api/auth-client.js';
import type {
  AuthStatus,
  DeviceFlowInitResponse,
  DeviceFlowPollResponse,
} from '../../src/types/auth.js';

interface AuthClientStub extends AuthClient {
  authorizeDeviceFlow: ReturnType<typeof vi.fn>;
  authorizePKCE: ReturnType<typeof vi.fn>;
  pollDeviceFlow: ReturnType<typeof vi.fn>;
  pollPKCE: ReturnType<typeof vi.fn>;
  getAuthStatus: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  checkVersion: ReturnType<typeof vi.fn>;
}

function makeAuthClient(): AuthClientStub {
  return {
    authorizeDeviceFlow: vi.fn(),
    authorizePKCE: vi.fn(),
    pollDeviceFlow: vi.fn(),
    pollPKCE: vi.fn(),
    getAuthStatus: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn(),
    checkVersion: vi.fn(),
  };
}

beforeEach(() => {
  credState.resolved = null;
  credState.isExpired = false;
  credState.jwtUser = null;
  credState.deleteCalled = false;
});

// ────────────────────────────────────────────────────────────────────
// getAuthStatus
// ────────────────────────────────────────────────────────────────────

describe('AuthService.getAuthStatus', () => {
  it('returns unauthenticated when there are no credentials on disk', async () => {
    const client = makeAuthClient();
    const svc = new AuthService(client);
    const out = await svc.getAuthStatus();
    expect(out).toEqual({ authenticated: false, server_verified: false });
    expect(client.getAuthStatus).not.toHaveBeenCalled();
  });

  it('returns unauthenticated when the token is expired', async () => {
    credState.resolved = {
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: '2020-01-01T00:00:00Z',
        user: { email: 'u@test.qianwen.com', aliyunId: 'a' },
      },
    };
    credState.isExpired = true;
    const client = makeAuthClient();
    const out = await new AuthService(client).getAuthStatus();
    expect(out).toEqual({ authenticated: false, server_verified: false });
    expect(client.getAuthStatus).not.toHaveBeenCalled();
  });

  it('proxies to the AuthClient when local checks pass', async () => {
    credState.resolved = {
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: '2030-01-01T00:00:00Z',
        user: { email: 'u@test.qianwen.com', aliyunId: 'a' },
      },
    };
    const remote: AuthStatus = {
      authenticated: true,
      server_verified: true,
      auth_mode: 'device_flow',
      user: { email: 'u@test.qianwen.com', aliyunId: 'a' },
    };
    const client = makeAuthClient();
    client.getAuthStatus.mockResolvedValue(remote);
    const out = await new AuthService(client).getAuthStatus();
    expect(out).toBe(remote);
  });

  it('falls back to local-credential view with a warning when the server is unreachable', async () => {
    credState.resolved = {
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: '2030-01-01T00:00:00Z',
        user: { email: 'me@test.qianwen.com', aliyunId: 'me' },
      },
    };
    const client = makeAuthClient();
    client.getAuthStatus.mockRejectedValue(new Error('Network request failed: ECONNREFUSED'));
    const out = await new AuthService(client).getAuthStatus();
    expect(out.authenticated).toBe(true);
    expect(out.server_verified).toBe(false);
    expect(out.warning).toContain('Server unreachable');
    expect(out.warning).toContain('ECONNREFUSED');
    expect(out.user?.email).toBe('me@test.qianwen.com');
  });

  it('falls back to JWT-extracted user when local credentials lack one', async () => {
    credState.resolved = {
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: '2030-01-01T00:00:00Z',
        user: { email: '', aliyunId: '' },
      },
    };
    credState.jwtUser = { email: 'jwt@test.qianwen.com', aliyunId: 'jwt-user' };
    const client = makeAuthClient();
    client.getAuthStatus.mockRejectedValue(new Error('boom'));
    const out = await new AuthService(client).getAuthStatus();
    expect(out.user?.email).toBe('jwt@test.qianwen.com');
  });
});

// ────────────────────────────────────────────────────────────────────
// loginInit / loginPoll
// ────────────────────────────────────────────────────────────────────

describe('AuthService.loginInit / loginPoll', () => {
  const initShared: DeviceFlowInitResponse = {
    token: 'enc-token',
    verification_url: 'https://login.test.qianwen.com/device',
    expires_in: 600,
    interval: 5,
  };

  it('selects PKCE in interactive TTY mode and stores the verifier for poll', async () => {
    const client = makeAuthClient();
    client.authorizePKCE.mockResolvedValue({ ...initShared, code_verifier: 'verifier-abc' });
    client.pollPKCE.mockResolvedValue({ status: 'authorization_pending' });
    const svc = new AuthService(client);

    const init = await svc.loginInit({ isInteractiveTty: true });
    expect(init.auth_mode).toBe('pkce');
    expect(init.code_verifier).toBe('verifier-abc');
    expect(client.authorizePKCE).toHaveBeenCalledTimes(1);
    expect(client.authorizeDeviceFlow).not.toHaveBeenCalled();

    await svc.loginPoll('enc-token', 5);
    expect(client.pollPKCE).toHaveBeenCalledWith('enc-token', 5, 'verifier-abc');
    expect(client.pollDeviceFlow).not.toHaveBeenCalled();
  });

  it('selects Device Flow when the TTY is non-interactive and clears the PKCE verifier', async () => {
    const client = makeAuthClient();
    client.authorizeDeviceFlow.mockResolvedValue(initShared);
    client.pollDeviceFlow.mockResolvedValue({ status: 'authorization_pending' });
    const svc = new AuthService(client);

    const init = await svc.loginInit({ isInteractiveTty: false });
    expect(init.auth_mode).toBe('device-flow');
    await svc.loginPoll('enc-token', 5);
    expect(client.pollDeviceFlow).toHaveBeenCalledWith('enc-token', 5);
  });

  it('honours an explicit verifier passed to loginPoll', async () => {
    const client = makeAuthClient();
    client.pollPKCE.mockResolvedValue({ status: 'authorization_pending' });
    const svc = new AuthService(client);
    await svc.loginPoll('enc', 7, 'override-verifier');
    expect(client.pollPKCE).toHaveBeenCalledWith('enc', 7, 'override-verifier');
  });
});

// ────────────────────────────────────────────────────────────────────
// logout
// ────────────────────────────────────────────────────────────────────

describe('AuthService.logout', () => {
  it('always deletes local credentials, even when server revocation fails', async () => {
    const client = makeAuthClient();
    client.logout.mockRejectedValue(new Error('server down'));
    const svc = new AuthService(client);
    await expect(svc.logout()).rejects.toThrow('server down');
    expect(credState.deleteCalled).toBe(true);
  });

  it('deletes local credentials on a successful server revocation', async () => {
    const client = makeAuthClient();
    const svc = new AuthService(client);
    await svc.logout();
    expect(credState.deleteCalled).toBe(true);
    expect(client.logout).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Deprecated forms (still in use by some callers)
// ────────────────────────────────────────────────────────────────────

// Deprecated wrappers (deviceFlowInit/Poll/setPkceVerifier) have been removed.
// All callers now use loginInit/loginPoll directly.
