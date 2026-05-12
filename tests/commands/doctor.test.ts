
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../helpers/run-command.js';
import { makeMockApiClient } from '../helpers/api-client.js';
import type { ApiClient } from '../../src/api/client.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

const holder: { client: ApiClient } = { client: makeMockApiClient() };
const credResolveStub = vi.fn();

vi.mock('../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));

vi.mock('../../src/auth/credentials.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/credentials.js')>(
      '../../src/auth/credentials.js',
    );
  return {
    ...actual,
    resolveCredentials: () => credResolveStub(),
  };
});

const { registerDoctorCommand } = await import('../../src/commands/doctor.js');

function inFutureIso(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

beforeEach(() => {
  holder.client = makeMockApiClient();
  credResolveStub.mockReset();
});

describe('doctor command', () => {
  it('JSON: all checks pass → exit 0', async () => {
    credResolveStub.mockReturnValue({
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: inFutureIso(48),
        user: { email: 'demo@x', aliyunId: '1' },
      },
    });
    holder.client = makeMockApiClient({
      checkVersion: async () => ({
        current: '1.0.0',
        latest: '1.0.0',
        update_available: false,
      }),
      ping: async () => ({ latency: 50, reachable: true, hostname: 'api.x' }),
      getAuthStatus: async () => ({
        authenticated: true,
        server_verified: true,
        user: { email: 'demo@x', aliyunId: '1' },
      }),
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'json'],
    );

    // doctor calls process.exit(0) → harness catches and records exit code
    const payload = JSON.parse(r.stdout);
    expect(payload.summary.fail).toBe(0);
    expect(payload.exit_code).toBe(0);
    expect(payload.checks.find((c: any) => c.name === 'auth').status).toBe('pass');
    expect(payload.checks.find((c: any) => c.name === 'token').status).toBe('pass');
  });

  it('JSON: not authenticated → auth fail, exit code 2', async () => {
    credResolveStub.mockReturnValue(null);
    holder.client = makeMockApiClient({
      ping: async () => ({ latency: 50, reachable: true, hostname: 'api.x' }),
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'json'],
    );

    const payload = JSON.parse(r.stdout);
    expect(payload.exit_code).toBe(2);
    expect(payload.summary.fail).toBeGreaterThanOrEqual(1);
    const authCheck = payload.checks.find((c: any) => c.name === 'auth');
    expect(authCheck.status).toBe('fail');
    expect(authCheck.action).toMatch(/login/i);
  });

  it('JSON: token expired → token fail, exit 2', async () => {
    credResolveStub.mockReturnValue({
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        user: { email: 'demo@x', aliyunId: '1' },
      },
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'json'],
    );

    const payload = JSON.parse(r.stdout);
    expect(payload.exit_code).toBe(2);
    const tokenCheck = payload.checks.find((c: any) => c.name === 'token');
    expect(tokenCheck.status).toBe('fail');
    expect(tokenCheck.detail).toMatch(/expired/i);
  });

  it('JSON: token expiring soon → token warn (not fail), exit 0', async () => {
    credResolveStub.mockReturnValue({
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: inFutureIso(0.5), // 30 minutes away
        user: { email: 'demo@x', aliyunId: '1' },
      },
    });
    holder.client = makeMockApiClient({
      ping: async () => ({ latency: 50, reachable: true, hostname: 'api.x' }),
      getAuthStatus: async () => ({ authenticated: true, server_verified: true }),
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'json'],
    );

    const payload = JSON.parse(r.stdout);
    const tokenCheck = payload.checks.find((c: any) => c.name === 'token');
    expect(tokenCheck.status).toBe('warn');
    expect(tokenCheck.detail).toMatch(/expires soon/i);
  });

  it('JSON: network unreachable → network fail, exit 3', async () => {
    credResolveStub.mockReturnValue({
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: inFutureIso(48),
        user: { email: 'demo@x', aliyunId: '1' },
      },
    });
    holder.client = makeMockApiClient({
      ping: async () => ({ latency: 0, reachable: false, hostname: 'api.x' }),
      getAuthStatus: async () => ({ authenticated: true, server_verified: true }),
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'json'],
    );

    const payload = JSON.parse(r.stdout);
    expect(payload.exit_code).toBe(3);
    const netCheck = payload.checks.find((c: any) => c.name === 'network');
    expect(netCheck.status).toBe('fail');
  });

  it('JSON: network high latency → network fail (>2000ms), exit 3', async () => {
    credResolveStub.mockReturnValue({
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: inFutureIso(48),
        user: { email: 'demo@x', aliyunId: '1' },
      },
    });
    holder.client = makeMockApiClient({
      ping: async () => ({ latency: 3000, reachable: true, hostname: 'api.x' }),
      getAuthStatus: async () => ({ authenticated: true, server_verified: true }),
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'json'],
    );

    const payload = JSON.parse(r.stdout);
    expect(payload.exit_code).toBe(3);
    const netCheck = payload.checks.find((c: any) => c.name === 'network');
    expect(netCheck.status).toBe('fail');
    expect(netCheck.detail).toMatch(/latency/i);
  });

  it('JSON: cli update available → cli_version warn', async () => {
    credResolveStub.mockReturnValue({
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: inFutureIso(48),
        user: { email: 'demo@x', aliyunId: '1' },
      },
    });
    holder.client = makeMockApiClient({
      checkVersion: async () => ({
        current: '1.0.0',
        latest: '1.5.0',
        update_available: true,
      }),
      ping: async () => ({ latency: 50, reachable: true, hostname: 'api.x' }),
      getAuthStatus: async () => ({ authenticated: true, server_verified: true }),
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'json'],
    );

    const payload = JSON.parse(r.stdout);
    const cliCheck = payload.checks.find((c: any) => c.name === 'cli_version');
    expect(cliCheck.status).toBe('warn');
    expect(cliCheck.action).toMatch(/update/i);
  });

  it('text mode: prints all check labels and final summary', async () => {
    credResolveStub.mockReturnValue({
      source: 'keychain',
      auth_mode: 'device_flow',
      access_token: 't',
      credentials: {
        access_token: 't',
        expires_at: inFutureIso(48),
        user: { email: 'demo@x', aliyunId: '1' },
      },
    });
    holder.client = makeMockApiClient({
      ping: async () => ({ latency: 50, reachable: true, hostname: 'api.x' }),
      getAuthStatus: async () => ({ authenticated: true, server_verified: true }),
    });

    const r = await runCommand(
      (program) => registerDoctorCommand(program),
      ['doctor', '--format', 'text'],
    );

    const out = r.stdout;
    expect(out).toContain(s.doctorTitle);
    expect(out).toContain('CLI version');
    expect(out).toContain('Auth');
    expect(out).toContain('Token');
    expect(out).toContain('Network');
    expect(out).toMatch(/All critical checks passed|checks passed/);
  });
});
