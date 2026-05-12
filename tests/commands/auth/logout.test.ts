import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';

const holder: { client: ApiClient } = { client: makeMockApiClient() };

const credResolveStub = vi.fn();
const credDeleteStub = vi.fn();

vi.mock('../../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  resolveCredentials: () => credResolveStub(),
  deleteCredentials: () => credDeleteStub(),
}));

const { registerLogoutCommand } = await import('../../../src/commands/auth/logout.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
  credResolveStub.mockReset();
  credDeleteStub.mockReset();
});

describe('auth logout command', () => {
  it('not logged in (JSON) → success=true with "Not logged in" message', async () => {
    credResolveStub.mockReturnValue(null);
    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerLogoutCommand(auth);
      },
      ['auth', 'logout', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.message).toBe('Not logged in');
    expect(credDeleteStub).not.toHaveBeenCalled();
  });

  it('not logged in (text) → prints "Not logged in"', async () => {
    credResolveStub.mockReturnValue(null);
    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerLogoutCommand(auth);
      },
      ['auth', 'logout', '--format', 'text'],
    );
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Not logged in');
  });

  it('logged in (JSON) → revokes session + deletes creds, returns success', async () => {
    credResolveStub.mockReturnValue({
      access_token: 'token',
      source: 'keychain',
      credentials: { access_token: 'token' },
    });
    const revokeMock = vi.fn(async () => true);
    holder.client = makeMockApiClient({ revokeSession: revokeMock });

    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerLogoutCommand(auth);
      },
      ['auth', 'logout', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.message).toBe('Logged out');
    expect(payload.source).toBe('keychain');
    expect(revokeMock).toHaveBeenCalled();
    expect(credDeleteStub).toHaveBeenCalled();
  });

  it('logged in but server revoke fails → still deletes locally, returns success', async () => {
    credResolveStub.mockReturnValue({
      access_token: 'token',
      source: 'file',
      credentials: { access_token: 'token' },
    });
    holder.client = makeMockApiClient({
      revokeSession: async () => {
        throw new Error('network down');
      },
    });
    const r = await runCommand(
      (program) => {
        const auth = program.command('auth');
        registerLogoutCommand(auth);
      },
      ['auth', 'logout', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(credDeleteStub).toHaveBeenCalled();
  });
});
