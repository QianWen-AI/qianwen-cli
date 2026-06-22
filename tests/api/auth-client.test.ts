/**
 * Unit tests for AuthClient (src/api/auth-client.ts).
 *
 * AuthClient handles credential management:
 *   - Device Flow authorization (init + poll loop → token)
 *   - Authentication status check
 *   - Logout (token revocation + local credential cleanup)
 *   - Network ping (connectivity diagnostic)
 *   - CLI version check (authOptional)
 *
 * AuthClient internally uses BaseClient.request() to avoid circular
 * dependency with ApiClient. Tests mock the fetch layer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetch } from '../helpers/http-mock.js';
import type { RecordedRequest } from '../helpers/http-mock.js';
import type { DeviceFlowInitResponse, DeviceFlowPollResponse } from '../../src/types/auth.js';

// ────────────────────────────────────────────────────────────────────
// Module-level mocks
// ────────────────────────────────────────────────────────────────────

vi.mock('../../src/auth/credentials.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCredentials: vi.fn(() => ({
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: 'mock-token-for-auth-test',
      credentials: {
        access_token: 'mock-token-for-auth-test',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        user: { email: 'user@test.qianwen.com', aliyunId: 'auth-uid' },
      },
    })),
    isTokenExpired: vi.fn(() => false),
    tryExtractUserFromToken: vi.fn(() => null),
    storeCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
  };
});

vi.mock('../../src/config/manager.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveConfig: vi.fn(() => ({
      'api.endpoint': 'https://mock-api.test.qianwen.com',
      'auth.endpoint': 'https://mock-auth.test.qianwen.com',
    })),
  };
});

let activeMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  if (activeMock) {
    activeMock.restore();
    activeMock = null;
  }
});

// ────────────────────────────────────────────────────────────────────
// Device Flow — normal flow (init → poll → token)
// ────────────────────────────────────────────────────────────────────

describe('AuthClient.authorizeDeviceFlow — normal flow', () => {
  it('initiates device flow and returns verification URL + user code', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => ({
        Success: true,
        Data: {
          Token: 'encrypt-token-abc',
          VerificationUrl: 'https://mock-auth.test.qianwen.com/device?code=ABCDEF',
          ExpiresIn: 600,
          Interval: 5,
        },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient();
    const result = await client.authorizeDeviceFlow();
    expect(result.verification_url).toContain('mock-auth.test.qianwen.com');
    expect(result.token).toBe('encrypt-token-abc');
    expect(result.expires_in).toBe(600);
  });

  it('polls until status becomes "complete" and returns credentials', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => ({
        Success: true,
        Data: {
          Status: 'complete',
          Credentials: {
            AccessToken: 'new-token-xyz',
            ExpireTime: '2026-12-31T23:59:59Z',
            User: { Email: 'u@test.qianwen.com', AliyunId: 'uid-new' },
          },
        },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient();
    const pollResult = await client.pollDeviceFlow('tk', 1);
    expect(pollResult.status).toBe('complete');
    expect(pollResult.credentials?.access_token).toBe('new-token-xyz');
  });
});

// ────────────────────────────────────────────────────────────────────
// Device Flow — timeout / expired
// ────────────────────────────────────────────────────────────────────

describe('AuthClient.authorizeDeviceFlow — timeout and expiry', () => {
  it('returns expired_token status when poll reports token expired', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => ({
        Success: true,
        Data: { Status: 'expired_token' },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient();
    const result = await client.pollDeviceFlow('expired-tk', 5);
    expect(result.status).toBe('expired_token');
    expect(result.credentials).toBeUndefined();
  });

  it('returns access_denied status when user denies authorization', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => ({
        Success: true,
        Data: { Status: 'access_denied' },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient();
    const result = await client.pollDeviceFlow('denied-tk', 5);
    expect(result.status).toBe('access_denied');
  });
});

// ────────────────────────────────────────────────────────────────────
// PKCE authorization code flow
// ────────────────────────────────────────────────────────────────────
//
// PKCE flow contract (per architecture design):
//   1. init  → CLI generates code_verifier locally (RFC 7636: 43–128 chars,
//              URL-safe alphabet [A-Z a-z 0-9 -._~]); derives code_challenge
//              = base64url(SHA256(code_verifier)); sends code_challenge to
//              the server; server returns verification URL + encrypt token.
//              CLI keeps code_verifier in memory for the poll step.
//   2. poll  → CLI sends encrypt token + code_verifier; server returns
//              status ∈ { authorization_pending | complete | expired_token
//              | access_denied }. On `complete`, credentials payload is
//              returned for local persistence.

describe('AuthClient.authorizePKCE — init', () => {
  it('generates code_verifier and sends derived code_challenge with authorization URL response', async () => {
    let capturedUrl: string | undefined;
    activeMock = mockFetch({
      'cli/device/code': (req: RecordedRequest) => {
        capturedUrl = req.url;
        return {
          Success: true,
          Data: {
            Token: 'encrypt-token-pkce',
            VerificationUrl: 'https://mock-auth.test.qianwen.com/oauth/authorize?code=PKCE01',
            ExpiresIn: 600,
            Interval: 5,
          },
        };
      },
    });

    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result = await createAuthClient().authorizePKCE();

    // Verifier must be locally generated and surfaced for the poll step.
    expect(result.code_verifier).toBeDefined();
    const verifier = result.code_verifier as string;
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // RFC 7636 unreserved alphabet only.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);

    // Authorization URL is returned to the caller as-is.
    expect(result.verification_url).toContain('mock-auth.test.qianwen.com');
    expect(result.token).toBe('encrypt-token-pkce');

    // Server only ever sees the challenge — never the raw verifier.
    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).toBeDefined();
    expect(challenge).not.toBe(verifier);
    // base64url alphabet, no padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('AuthClient.authorizePKCE — poll', () => {
  it('returns credentials when polling reports complete status', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => ({
        Success: true,
        Data: {
          Status: 'complete',
          Credentials: {
            AccessToken: 'pkce-access-token',
            ExpireTime: '2026-12-31T23:59:59Z',
            User: { Email: 'pkce-user@test.qianwen.com', AliyunId: 'pkce-uid' },
          },
        },
      }),
    });

    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result = await createAuthClient().pollPKCE(
      'encrypt-token-pkce',
      1,
      'verifier-fixture-value-aaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(result.status).toBe('complete');
    expect(result.credentials?.access_token).toBe('pkce-access-token');
    expect(result.credentials?.user.aliyunId).toBe('pkce-uid');
  });

  it('returns expired_token status when authorization code lifetime elapses', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => ({
        Success: true,
        Data: { Status: 'expired_token' },
      }),
    });

    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result = await createAuthClient().pollPKCE(
      'expired-pkce-token',
      5,
      'verifier-fixture-value-aaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(result.status).toBe('expired_token');
    expect(result.credentials).toBeUndefined();
  });

  it('returns access_denied status when user rejects authorization in the browser', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => ({
        Success: true,
        Data: { Status: 'access_denied' },
      }),
    });

    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result = await createAuthClient().pollPKCE(
      'denied-pkce-token',
      5,
      'verifier-fixture-value-aaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(result.status).toBe('access_denied');
    expect(result.credentials).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Authentication status check
//
// Server verification targets the account REST endpoint, not the gateway
// envelope. The contract is:
//   GET {api.endpoint}/api/account/info.json
//   Authorization: Bearer <access_token>
//   30s timeout
// Response body shape: { data?: { aliyunId?: string; email?: string } }
//
// Three-state result:
//   2xx          → server_verified:true
//   non-2xx      → server_verified:false, warning 'Server verification failed (HTTP <s>)'
//   fetch reject → server_verified:false, warning 'Server unreachable: <msg>'
// ────────────────────────────────────────────────────────────────────

const ACCOUNT_REST_FRAGMENT = 'api/account/info.json';
const GATEWAY_FRAGMENT = 'data/v2/api.json';

function authHeaderValue(req: RecordedRequest): string | undefined {
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === 'authorization');
  return key ? req.headers[key] : undefined;
}

describe('AuthClient.getAuthStatus — call target (regression guard)', () => {
  it('issues GET to the account REST endpoint with a Bearer header and never hits the gateway', async () => {
    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: () => ({ data: { aliyunId: 'auth-uid' } }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().getAuthStatus();

    // The status check MUST target the account REST endpoint.
    const req = activeMock.lastRequest(ACCOUNT_REST_FRAGMENT);
    expect(req).toBeDefined();
    expect(req!.method).toBe('GET');
    expect(req!.url).toContain('/api/account/info.json');
    expect(authHeaderValue(req!)).toBe('Bearer mock-token-for-auth-test');

    // And it MUST NOT route through the gateway action pipeline. A regression
    // to `POST /data/v2/api.json` (GetAuthStatus action) turns this red.
    expect(activeMock.wasCalled(GATEWAY_FRAGMENT)).toBe(false);
  });

  it('builds the URL from api.endpoint host', async () => {
    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: () => ({ data: { aliyunId: 'auth-uid' } }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().getAuthStatus();
    const url = new URL(activeMock.lastRequest(ACCOUNT_REST_FRAGMENT)!.url);
    expect(url.host).toBe('mock-api.test.qianwen.com');
    expect(url.pathname).toBe('/api/account/info.json');
  });
});

describe('AuthClient.getAuthStatus — three-state contract', () => {
  it('returns server_verified=true and server-sourced user on a 2xx response', async () => {
    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: () => ({
        data: { aliyunId: 'server-uid', email: 'server@test.qianwen.com' },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const status = await createAuthClient().getAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.server_verified).toBe(true);
    expect(status.warning).toBeUndefined();
    expect(status.user?.aliyunId).toBe('server-uid');
    expect(status.token?.scopes).toContain('inference:read');
  });

  it('degrades to server_verified=false with an HTTP warning on a non-2xx response', async () => {
    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: { body: 'forbidden', init: { status: 403 } },
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const status = await createAuthClient().getAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.server_verified).toBe(false);
    expect(status.warning).toContain('HTTP 403');
  });

  it('degrades to server_verified=false with an unreachable warning when fetch rejects', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const { createAuthClient } = await import('../../src/api/auth-client.js');
      const status = await createAuthClient().getAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.server_verified).toBe(false);
      expect(status.warning).toContain('Server unreachable');
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('AuthClient.getAuthStatus — pre-request short circuits', () => {
  it('returns authenticated=false without issuing any request when no credentials are available', async () => {
    const credMod = await import('../../src/auth/credentials.js');
    vi.mocked(credMod.resolveCredentials).mockReturnValueOnce(null as never);

    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: () => ({ data: { aliyunId: 'auth-uid' } }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const status = await createAuthClient().getAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.server_verified).toBe(false);
    expect(activeMock.wasCalled(ACCOUNT_REST_FRAGMENT)).toBe(false);
  });

  it('returns authenticated=false without issuing any request when the token is expired', async () => {
    const credMod = await import('../../src/auth/credentials.js');
    vi.mocked(credMod.isTokenExpired).mockReturnValueOnce(true);

    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: () => ({ data: { aliyunId: 'auth-uid' } }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const status = await createAuthClient().getAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.server_verified).toBe(false);
    expect(activeMock.wasCalled(ACCOUNT_REST_FRAGMENT)).toBe(false);
  });
});

describe('AuthClient.getAuthStatus — user fallback chain', () => {
  it('falls back to credentials user when the server response carries no identity', async () => {
    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: () => ({ data: {} }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const status = await createAuthClient().getAuthStatus();
    expect(status.server_verified).toBe(true);
    // resolveCredentials mock supplies aliyunId 'auth-uid'.
    expect(status.user?.aliyunId).toBe('auth-uid');
  });

  it('falls back to the JWT-extracted user when both server and credentials lack an identity', async () => {
    const credMod = await import('../../src/auth/credentials.js');
    // Credentials without an embedded user, forcing the JWT fallback rung.
    vi.mocked(credMod.resolveCredentials).mockReturnValueOnce({
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: 'jwt-fallback-token',
      credentials: {
        access_token: 'jwt-fallback-token',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    } as never);
    vi.mocked(credMod.tryExtractUserFromToken).mockReturnValueOnce({
      email: 'jwt@test.qianwen.com',
      aliyunId: 'jwt-uid',
    });

    activeMock = mockFetch({
      [ACCOUNT_REST_FRAGMENT]: () => ({ data: {} }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const status = await createAuthClient().getAuthStatus();
    expect(status.user?.aliyunId).toBe('jwt-uid');
  });
});

// ────────────────────────────────────────────────────────────────────
// Logout
// ────────────────────────────────────────────────────────────────────

describe('AuthClient.logout', () => {
  it('sends logout request and clears local credentials', async () => {
    activeMock = mockFetch({
      'data/v2/api.json': () => ({ code: '200', data: { success: true } }),
    });
    const credMod = await import('../../src/auth/credentials.js');
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().logout();
    expect(credMod.deleteCredentials).toHaveBeenCalled();
  });

  it('clears local credentials even if server request fails', async () => {
    activeMock = mockFetch({
      'data/v2/api.json': { body: 'error', init: { status: 500 } },
    });
    const credMod = await import('../../src/auth/credentials.js');
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    // Should not throw — clears local creds regardless
    await createAuthClient().logout();
    expect(credMod.deleteCredentials).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// Ping (connectivity check)
// ────────────────────────────────────────────────────────────────────

describe('AuthClient.ping', () => {
  it('returns success=true when gateway is reachable', async () => {
    activeMock = mockFetch({
      'data/v2/api.json': () => ({ code: '200', data: { pong: true } }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result = await createAuthClient().ping();
    expect(result.success).toBe(true);
  });

  it('returns success=false with error info when gateway is unreachable', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;

    try {
      const { createAuthClient } = await import('../../src/api/auth-client.js');
      const result = await createAuthClient().ping();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('returns success=false when server responds with non-200', async () => {
    activeMock = mockFetch({
      'data/v2/api.json': { body: 'unavailable', init: { status: 503 } },
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result = await createAuthClient().ping();
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// checkVersion
// ────────────────────────────────────────────────────────────────────

describe('AuthClient.checkVersion', () => {
  it('returns latest version info from server', async () => {
    activeMock = mockFetch({
      'data/v2/api.json': () => ({
        code: '200',
        data: {
          latest_version: '1.2.0',
          download_url: 'https://mock-api.test.qianwen.com/download',
        },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result = await createAuthClient().checkVersion();
    expect(result.latest_version).toBe('1.2.0');
  });

  it('does not require authentication (uses authOptional)', async () => {
    const credMod = await import('../../src/auth/credentials.js');
    vi.mocked(credMod.resolveCredentials).mockReturnValueOnce(null as never);

    activeMock = mockFetch({
      'data/v2/api.json': () => ({
        code: '200',
        data: { latest_version: '1.2.0' },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    // Should not throw even without credentials
    const result = await createAuthClient().checkVersion();
    expect(result.latest_version).toBe('1.2.0');
  });

  it('gracefully handles server error without crashing', async () => {
    activeMock = mockFetch({
      'data/v2/api.json': { body: 'error', init: { status: 500 } },
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await expect(createAuthClient().checkVersion()).rejects.toThrow(/500|internal|error/i);
  });
});

// ────────────────────────────────────────────────────────────────────
// Device Flow REST contract — independent endpoints under authEndpoint
//
// Per architecture spec, device-flow init/poll do NOT traverse the gateway
// envelope (`/data/v2/api.json` + JSON body). They are independent REST
// routes whose parameters are passed via query string and whose responses
// are PascalCase `{Success, Data}` envelopes that must be normalized to
// the application's snake_case shape.
// ────────────────────────────────────────────────────────────────────

// Contract surface for the rewritten device-flow API. The poll endpoint
// must accept the PKCE code_verifier as a third positional argument so it
// can be propagated into the request URL's query string.
type DeviceFlowApi = {
  authorizeDeviceFlow(): Promise<DeviceFlowInitResponse>;
  pollDeviceFlow(
    token: string,
    intervalSec: number,
    codeVerifier: string,
  ): Promise<DeviceFlowPollResponse>;
};

const initPascalPayload = {
  Success: true,
  Data: {
    Token: 'encrypt-token-rest',
    VerificationUrl: 'https://mock-auth.test.qianwen.com/device?code=REST01',
    ExpiresIn: 600,
    Interval: 5,
  },
};

const pollCompletePascalPayload = {
  Success: true,
  Data: {
    Status: 'complete',
    Credentials: {
      AccessToken: 'access-token-rest',
      ExpireTime: '2026-12-31T23:59:59Z',
      User: { AliyunId: 'uid-rest', Email: 'rest-user@test.qianwen.com' },
    },
  },
};

describe('AuthClient.authorizeDeviceFlow — REST URL construction', () => {
  it('targets the authEndpoint host, never the apiEndpoint', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => initPascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().authorizeDeviceFlow();
    const req = activeMock.lastRequest('cli/device/code');
    expect(req).toBeDefined();
    expect(req!.url.startsWith('https://mock-auth.test.qianwen.com/')).toBe(true);
    expect(req!.url).not.toContain('mock-api.test.qianwen.com');
  });

  it('uses the /cli/device/code path', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => initPascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().authorizeDeviceFlow();
    const req = activeMock.lastRequest('cli/device/code')!;
    const parsed = new URL(req.url);
    expect(parsed.pathname).toBe('/cli/device/code');
  });

  it('passes client_id as a query string parameter', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => initPascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().authorizeDeviceFlow();
    const url = new URL(activeMock.lastRequest('cli/device/code')!.url);
    expect(url.searchParams.get('client_id')).toBeTruthy();
  });

  it('passes code_challenge and code_challenge_method=S256 in query string', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => initPascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().authorizeDeviceFlow();
    const url = new URL(activeMock.lastRequest('cli/device/code')!.url);
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    // base64url alphabet, no padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('issues POST with no request body', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => initPascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().authorizeDeviceFlow();
    const req = activeMock.lastRequest('cli/device/code')!;
    expect(req.method).toBe('POST');
    expect(req.body).toBeUndefined();
  });

  it('does not attach an Authorization header (unauthenticated endpoint)', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => initPascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await createAuthClient().authorizeDeviceFlow();
    const req = activeMock.lastRequest('cli/device/code')!;
    const hasAuth = Object.keys(req.headers).some((k) => k.toLowerCase() === 'authorization');
    expect(hasAuth).toBe(false);
  });
});

describe('AuthClient.pollDeviceFlow — REST URL construction', () => {
  const pollVerifier = 'fixture-verifier-abcdefghijklmnopqrstuvwxyz0123456789';

  it('uses the /cli/device/token path on authEndpoint host', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => pollCompletePascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient() as unknown as DeviceFlowApi;
    await client.pollDeviceFlow('encrypt-tk', 1, pollVerifier);
    const req = activeMock.lastRequest('cli/device/token')!;
    const parsed = new URL(req.url);
    expect(parsed.host).toBe('mock-auth.test.qianwen.com');
    expect(parsed.pathname).toBe('/cli/device/token');
  });

  it('passes client_id and token as query string parameters', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => pollCompletePascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient() as unknown as DeviceFlowApi;
    await client.pollDeviceFlow('encrypt-tk-xyz', 1, pollVerifier);
    const url = new URL(activeMock.lastRequest('cli/device/token')!.url);
    expect(url.searchParams.get('client_id')).toBeTruthy();
    expect(url.searchParams.get('token')).toBe('encrypt-tk-xyz');
  });

  it('passes code_verifier as a query string parameter', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => pollCompletePascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient() as unknown as DeviceFlowApi;
    await client.pollDeviceFlow('encrypt-tk', 1, pollVerifier);
    const url = new URL(activeMock.lastRequest('cli/device/token')!.url);
    expect(url.searchParams.get('code_verifier')).toBe(pollVerifier);
  });

  it('issues POST with no request body', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => pollCompletePascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient() as unknown as DeviceFlowApi;
    await client.pollDeviceFlow('encrypt-tk', 1, pollVerifier);
    const req = activeMock.lastRequest('cli/device/token')!;
    expect(req.method).toBe('POST');
    expect(req.body).toBeUndefined();
  });
});

describe('AuthClient — PascalCase response normalization', () => {
  const pollVerifier = 'fixture-verifier-abcdefghijklmnopqrstuvwxyz0123456789';

  it('normalizes init response Token/VerificationUrl/ExpiresIn/Interval to snake_case', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => initPascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const result: DeviceFlowInitResponse = await createAuthClient().authorizeDeviceFlow();
    expect(result.token).toBe('encrypt-token-rest');
    expect(result.verification_url).toBe('https://mock-auth.test.qianwen.com/device?code=REST01');
    expect(result.expires_in).toBe(600);
    expect(result.interval).toBe(5);
  });

  it('normalizes poll complete response credentials (AccessToken/ExpireTime/User) to snake_case', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => pollCompletePascalPayload,
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient() as unknown as DeviceFlowApi;
    const result = await client.pollDeviceFlow('tk', 1, pollVerifier);
    expect(result.status).toBe('complete');
    expect(result.credentials?.access_token).toBe('access-token-rest');
    expect(result.credentials?.expires_at).toBe('2026-12-31T23:59:59Z');
    expect(result.credentials?.user.aliyunId).toBe('uid-rest');
    expect(result.credentials?.user.email).toBe('rest-user@test.qianwen.com');
  });

  it('returns authorization_pending status when poll responds with pending', async () => {
    activeMock = mockFetch({
      'cli/device/token': () => ({
        Success: true,
        Data: { Status: 'authorization_pending' },
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    const client = createAuthClient() as unknown as DeviceFlowApi;
    const result = await client.pollDeviceFlow('tk', 1, pollVerifier);
    expect(result.status).toBe('authorization_pending');
    expect(result.credentials).toBeUndefined();
  });
});

describe('AuthClient — Device Flow REST error handling', () => {
  it('throws an Error containing the target URL when the network call fails', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ETIMEDOUT');
    }) as unknown as typeof fetch;
    try {
      const { createAuthClient } = await import('../../src/api/auth-client.js');
      await expect(createAuthClient().authorizeDeviceFlow()).rejects.toThrow(
        /cli\/device\/code|mock-auth\.test\.qianwen\.com/,
      );
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('throws an Error when the server returns a non-2xx status', async () => {
    activeMock = mockFetch({
      'cli/device/code': { body: 'unauthorized', init: { status: 401 } },
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await expect(createAuthClient().authorizeDeviceFlow()).rejects.toThrow();
  });

  it('throws an Error when the response payload reports {Success: false}', async () => {
    activeMock = mockFetch({
      'cli/device/code': () => ({
        Success: false,
        Message: 'invalid client_id',
      }),
    });
    const { createAuthClient } = await import('../../src/api/auth-client.js');
    await expect(createAuthClient().authorizeDeviceFlow()).rejects.toThrow();
  });
});
