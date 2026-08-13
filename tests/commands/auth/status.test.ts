import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';

const holder: { client: ApiClient } = { client: makeMockApiClient() };

const credResolveStub = vi.fn();

vi.mock('../../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  resolveCredentials: () => credResolveStub(),
}));

const { registerStatusCommand } = await import('../../../src/commands/auth/status.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
  credResolveStub.mockReset();
});

describe('auth status command', () => {
  it('not authenticated (JSON) → authenticated=false, exit 0', async () => {
    credResolveStub.mockReturnValue(null);
    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerStatusCommand(auth);
      },
      ['auth', 'status', '--format', 'json'],
    );
    // Status is a query: an unauthenticated result is still a successful
    // lookup — the state is reported in the payload and the process exits 0.
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.authenticated).toBe(false);
  });

  it('not authenticated (text) → "Not authenticated" message, exit 0', async () => {
    credResolveStub.mockReturnValue(null);
    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerStatusCommand(auth);
      },
      ['auth', 'status', '--format', 'text'],
    );
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Not authenticated');
  });

  it('authenticated + server OK (JSON) → returns full payload, exit 0', async () => {
    credResolveStub.mockReturnValue({
      access_token: 'token',
      auth_mode: 'oauth',
      source: 'keychain',
      credentials: {
        access_token: 'token',
        expires_at: '2026-12-31T00:00:00Z',
        user: { aliyunId: '12345', email: 'demo@qwen.dev' },
      },
    });
    holder.client = makeMockApiClient({
      getAuthStatus: async () =>
        ({
          authenticated: true,
          server_verified: true,
          user: { aliyunId: '12345', email: 'demo@qwen.dev' },
          token: { scopes: ['read', 'write'] },
        }) as any,
    });
    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerStatusCommand(auth);
      },
      ['auth', 'status', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.authenticated).toBe(true);
    expect(payload.server_verified).toBe(true);
    expect(payload.user.aliyunId).toBe('12345');
  });

  it('token expired (JSON) → authenticated=false, reason=token_expired, exit 0', async () => {
    credResolveStub.mockReturnValue({
      access_token: 'token',
      auth_mode: 'oauth',
      source: 'keychain',
      credentials: { access_token: 'token', expires_at: '2020-01-01T00:00:00Z' },
    });
    holder.client = makeMockApiClient({
      getAuthStatus: async () => ({
        authenticated: false,
        server_verified: false,
      }),
    });
    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerStatusCommand(auth);
      },
      ['auth', 'status', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.authenticated).toBe(false);
    expect(payload.reason).toBe('token_expired');
  });
});
