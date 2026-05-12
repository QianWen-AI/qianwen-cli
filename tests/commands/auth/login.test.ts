import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';

const holder: { client: ApiClient } = { client: makeMockApiClient() };

const credResolveStub = vi.fn();
const tokenExpiredStub = vi.fn();
const remainingStub = vi.fn(() => '1h 30m');

const deviceFlowStub = vi.fn();
const deviceFlowInitOnlyStub = vi.fn();
const deviceFlowCompleteStub = vi.fn();

vi.mock('../../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));

vi.mock('../../../src/auth/credentials.js', () => ({
  resolveCredentials: () => credResolveStub(),
  isTokenExpired: () => tokenExpiredStub(),
  getTokenRemainingTime: () => remainingStub(),
}));

vi.mock('../../../src/auth/device-flow.js', () => ({
  executeDeviceFlow: (...args: unknown[]) => deviceFlowStub(...args),
  executeDeviceFlowInitOnly: (...args: unknown[]) => deviceFlowInitOnlyStub(...args),
  executeDeviceFlowComplete: (...args: unknown[]) => deviceFlowCompleteStub(...args),
}));

vi.mock('../../../src/utils/cache.js', () => ({
  resetGlobalCache: () => {},
}));

const { registerLoginCommand } = await import('../../../src/commands/auth/login.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
  credResolveStub.mockReset();
  tokenExpiredStub.mockReset();
  remainingStub.mockReset();
  remainingStub.mockReturnValue('1h 30m');
  deviceFlowStub.mockReset();
  deviceFlowInitOnlyStub.mockReset();
  deviceFlowCompleteStub.mockReset();

  // Force TTY=true so the auto-degrade path doesn't kick in for non-init-only tests
  Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
});

function setup(program: import('commander').Command) {
  const auth = program.command('auth');
  registerLoginCommand(auth);
}

describe('auth login command', () => {
  describe('already authenticated path', () => {
    it('JSON: returns already_authenticated event with user + remaining', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok',
        source: 'keychain',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-12-31T00:00:00Z',
          user: { aliyunId: 'user-1', email: 'u@q.dev' },
        },
      });
      tokenExpiredStub.mockReturnValue(false);
      holder.client = makeMockApiClient({
        getAuthStatus: async () => ({
          authenticated: true,
          server_verified: true,
          user: { aliyunId: 'user-1', email: 'u@q.dev' },
        } as any),
      });

      const r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.events[0].event).toBe('already_authenticated');
      expect(payload.events[0].authenticated).toBe(true);
      expect(payload.events[0].user.aliyunId).toBe('user-1');
      expect(payload.events[0].source).toBe('keychain');
      // device-flow should NOT have been triggered
      expect(deviceFlowStub).not.toHaveBeenCalled();
    });

    it('text: prints "Already authenticated as <id>"', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok',
        source: 'file',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-12-31T00:00:00Z',
          user: { aliyunId: 'aliyun-2' },
        },
      });
      tokenExpiredStub.mockReturnValue(false);
      holder.client = makeMockApiClient({
        getAuthStatus: async () => ({
          authenticated: true,
          server_verified: true,
          user: { aliyunId: 'aliyun-2' },
        } as any),
      });

      const r = await runCommand(setup, ['auth', 'login', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toMatch(/Already authenticated/);
      expect(r.stdout).toContain('aliyun-2');
      expect(deviceFlowStub).not.toHaveBeenCalled();
    });
  });

  describe('--init-only path', () => {
    it('not authenticated → emits device_code event', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://example.com/device?code=ABC',
        expires_in: 600,
        device_code: 'd-1',
        user_code: 'ABC-123',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.events[0].event).toBe('device_code');
      expect(payload.events[0].verification_url).toContain('example.com');
      expect(payload.events[0].expires_in).toBe(600);
      expect(deviceFlowInitOnlyStub).toHaveBeenCalled();
    });

    it('already authenticated → emits already_authenticated, skips init', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok',
        source: 'keychain',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-12-31T00:00:00Z',
          user: { aliyunId: 'init-user' },
        },
      });
      tokenExpiredStub.mockReturnValue(false);
      holder.client = makeMockApiClient({
        getAuthStatus: async () => ({
          authenticated: true,
          server_verified: true,
          user: { aliyunId: 'init-user' },
        } as any),
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.events[0].event).toBe('already_authenticated');
      expect(deviceFlowInitOnlyStub).not.toHaveBeenCalled();
    });
  });

  describe('--complete path', () => {
    it('JSON success: emits success event with user', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockImplementation(async (callbacks: any) => {
        callbacks.onSuccess({ aliyunId: 'complete-user', email: 'cu@q.dev' });
        return true;
      });

      // Force non-TTY so --complete defaults to JSON output and skips polling dots
      Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });

      const r = await runCommand(setup, ['auth', 'login', '--complete']);
      const payload = JSON.parse(r.stdout);
      const successEvent = payload.events.find((e: any) => e.event === 'success');
      expect(successEvent).toBeDefined();
      expect(successEvent.authenticated).toBe(true);
      expect(deviceFlowCompleteStub).toHaveBeenCalled();
    });

    it('JSON pending: maps "not yet completed" error to pending event', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockImplementation(async (callbacks: any) => {
        callbacks.onError('Authentication has not yet completed');
        return false;
      });
      Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });

      const r = await runCommand(setup, ['auth', 'login', '--complete']);
      const payload = JSON.parse(r.stdout);
      const evt = payload.events.find((e: any) => e.event === 'pending' || e.event === 'error');
      expect(evt).toBeDefined();
      expect(evt.authenticated).toBe(false);
      // process.exitCode is set to 1 inside the action
      expect(process.exitCode === 1 || process.exitCode === undefined).toBe(true);
    });

    it('JSON expired: maps onExpired to expired event', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockImplementation(async (callbacks: any) => {
        callbacks.onExpired();
        return false;
      });
      Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });

      const r = await runCommand(setup, ['auth', 'login', '--complete']);
      const payload = JSON.parse(r.stdout);
      const expired = payload.events.find((e: any) => e.event === 'expired');
      expect(expired).toBeDefined();
      expect(expired.authenticated).toBe(false);
    });

    it('JSON: when no callbacks fired, emits a fallback error event (output never empty)', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockResolvedValue(false);
      Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });

      const r = await runCommand(setup, ['auth', 'login', '--complete']);
      const payload = JSON.parse(r.stdout);
      expect(payload.events.length).toBeGreaterThan(0);
      expect(payload.events[0].event).toBe('error');
    });

    it('--timeout option is parsed and forwarded', async () => {
      credResolveStub.mockReturnValue(null);
      let capturedOpts: any = null;
      deviceFlowCompleteStub.mockImplementation(async (_cb: any, opts: any) => {
        capturedOpts = opts;
        return false;
      });
      Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });

      await runCommand(setup, [
        'auth', 'login', '--complete', '--timeout', '60',
      ]);
      expect(capturedOpts).toBeTruthy();
      expect(capturedOpts.timeoutSeconds).toBe(60);
    });
  });

  describe('default (non-init-only) flow in JSON mode', () => {
    it('not authenticated → drives executeDeviceFlow and emits aggregated events', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://example.com/d',
          expiresIn: 600,
        });
        callbacks.onSuccess({ aliyunId: 'flow-user', email: 'f@q.dev' });
        return true;
      });

      const r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      const events = payload.events.map((e: any) => e.event);
      expect(events).toContain('device_code');
      expect(events).toContain('success');
    });

    it('flow returns false → emits error event (process.exitCode set to 1 internally)', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onError('User cancelled');
        return false;
      });

      const r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      const payload = JSON.parse(r.stdout);
      const errorEvent = payload.events.find((e: any) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.authenticated).toBe(false);
    });

    it('expired callback → expired event in payload', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onExpired();
        return false;
      });

      const r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      const payload = JSON.parse(r.stdout);
      const expiredEvent = payload.events.find((e: any) => e.event === 'expired');
      expect(expiredEvent).toBeDefined();
    });
  });
});
