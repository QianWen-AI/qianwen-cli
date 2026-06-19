import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec } from 'child_process';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';

/**
 * Parse NDJSON: split a stdout buffer on newlines, drop empty lines, and
 * JSON.parse each remaining line into an event object. The plain blocking
 * `auth login --format json` path streams one compact JSON object per line
 * (no `{events:[...]}` wrapper), so the event sequence is reconstructed by
 * parsing line by line.
 */
function parseNDJSON(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Capture raw chunks written to process.stdout in call order.
 *
 * The streaming NDJSON contract emits each event the instant its callback
 * fires via `process.stdout.write(...)`. runCommand only mirrors `console.log`
 * into its captured stdout, so the streaming path's writes are observed here
 * directly. The returned `chunks` array preserves write order, which the
 * streaming-order assertion depends on.
 */
function captureStdoutWrites(): {
  chunks: string[];
  restore: () => void;
  text: () => string;
} {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return {
    chunks,
    restore: () => spy.mockRestore(),
    text: () => chunks.join(''),
  };
}

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

vi.mock('../../../src/auth/login-flow.js', () => ({
  executeLogin: (...args: unknown[]) => deviceFlowStub(...args),
  executeLoginInitOnly: (...args: unknown[]) => deviceFlowInitOnlyStub(...args),
  executeLoginComplete: (...args: unknown[]) => deviceFlowCompleteStub(...args),
}));

vi.mock('../../../src/utils/cache.js', () => ({
  resetGlobalCache: () => {},
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
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
  vi.mocked(exec).mockReset();

  // Reset process.exitCode before each test
  process.exitCode = undefined;

  // Force TTY=true so the auto-degrade path doesn't kick in for non-init-only tests
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // Restore any global `fetch` stub installed via vi.stubGlobal so the
  // fetchUserIdentifier backfill tests cannot leak a fake fetch into other suites.
  vi.unstubAllGlobals();
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
        getAuthStatus: async () =>
          ({
            authenticated: true,
            server_verified: true,
            user: { aliyunId: 'user-1', email: 'u@q.dev' },
          }) as any,
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      expect(r.exitCode).toBeUndefined();
      const events = parseNDJSON(cap.text());
      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.event).toBe('already_authenticated');
      expect(evt.authenticated).toBe(true);
      expect((evt.user as { aliyunId: string }).aliyunId).toBe('user-1');
      expect(evt.source).toBe('keychain');
      // No `{events:[...]}` wrapper in the streaming NDJSON contract.
      expect(evt.events).toBeUndefined();
      // login flow should NOT have been triggered
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
        getAuthStatus: async () =>
          ({
            authenticated: true,
            server_verified: true,
            user: { aliyunId: 'aliyun-2' },
          }) as any,
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
        verification_url: 'https://mock-auth.test.qianwen.com/device?code=ABC',
        expires_in: 600,
        device_code: 'd-1',
        user_code: 'ABC-123',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.events[0].event).toBe('device_code');
      expect(payload.events[0].verification_url).toContain('mock-auth.test.qianwen.com');
      expect(payload.events[0].expires_in).toBe(600);
      // Backward-compatible numeric unit field carries the same value as expires_in.
      expect(payload.events[0].expires_in_seconds).toBe(600);
      expect(deviceFlowInitOnlyStub).toHaveBeenCalled();
    });

    it('not authenticated → device_code event carries next_step pointing at --complete', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://mock-auth.test.qianwen.com/device?code=NEXT',
        expires_in: 300,
        device_code: 'd-next',
        user_code: 'NXT-001',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.events[0].event).toBe('device_code');
      // Machine-readable next-step command for programmatic (Agent) consumption.
      expect(typeof payload.events[0].next_step).toBe('string');
      expect(payload.events[0].next_step).toContain('--complete');
      expect(payload.events[0].next_step).toContain('auth login');
    });

    it('not authenticated → device_code event carries numeric expires_in_seconds equal to expires_in', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://mock-auth.test.qianwen.com/device?code=EXP',
        expires_in: 450,
        device_code: 'd-exp',
        user_code: 'EXP-001',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      const evt = payload.events[0];
      expect(evt.event).toBe('device_code');
      expect(typeof evt.expires_in_seconds).toBe('number');
      expect(evt.expires_in_seconds).toBe(450);
      // Original field is preserved for backward compatibility and matches the unit-named one.
      expect(evt.expires_in).toBe(450);
      expect(evt.expires_in_seconds).toBe(evt.expires_in);
    });

    it('not authenticated → writes a human-readable --complete guidance to stderr', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://mock-auth.test.qianwen.com/device?code=GUIDE',
        expires_in: 300,
        device_code: 'd-guide',
        user_code: 'GDE-001',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      // Guidance must steer the user toward the second-phase --complete command.
      expect(r.stderr).toContain('--complete');
      // Per C25-2, stdout in JSON mode carries only the payload; the
      // human-readable guidance sentence must not leak into stdout. (The
      // machine-readable next_step field may legitimately carry the command.)
      expect(r.stdout).not.toContain('Open the URL');
      // The advisory does not contradict the JSON payload — stdout still parses cleanly.
      expect(() => JSON.parse(r.stdout)).not.toThrow();
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
        getAuthStatus: async () =>
          ({
            authenticated: true,
            server_verified: true,
            user: { aliyunId: 'init-user' },
          }) as any,
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
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });

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
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });

      const r = await runCommand(setup, ['auth', 'login', '--complete']);
      const payload = JSON.parse(r.stdout);
      const evt = payload.events.find((e: any) => e.event === 'pending' || e.event === 'error');
      expect(evt).toBeDefined();
      expect(evt.authenticated).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('JSON expired: maps onExpired to expired event', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockImplementation(async (callbacks: any) => {
        callbacks.onExpired();
        return false;
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });

      const r = await runCommand(setup, ['auth', 'login', '--complete']);
      const payload = JSON.parse(r.stdout);
      const expired = payload.events.find((e: any) => e.event === 'expired');
      expect(expired).toBeDefined();
      expect(expired.authenticated).toBe(false);
    });

    it('JSON: when no callbacks fired, emits a fallback error event (output never empty)', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockResolvedValue(false);
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });

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
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });

      await runCommand(setup, ['auth', 'login', '--complete', '--timeout', '60']);
      expect(capturedOpts).toBeTruthy();
      expect(capturedOpts.timeoutSeconds).toBe(60);
    });
  });

  describe('default (non-init-only) flow in JSON mode', () => {
    it('not authenticated → drives executeLogin and streams device_code + success lines', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/d',
          expiresIn: 600,
        });
        callbacks.onSuccess({ aliyunId: 'flow-user', email: 'f@mock-auth.test.qianwen.com' });
        return true;
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      expect(r.exitCode).toBeUndefined();
      const events = parseNDJSON(cap.text()).map((e) => e.event);
      expect(events).toContain('device_code');
      expect(events).toContain('success');
    });

    it('device_code line is a single compact NDJSON object before any poll output', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device?code=ABC',
          expiresIn: 600,
        });
        callbacks.onSuccess({ aliyunId: 'shape-user', email: 's@mock-auth.test.qianwen.com' });
        return true;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      const lines = cap
        .text()
        .split('\n')
        .filter((l) => l.trim().length > 0);
      const firstLine = lines[0];
      // Compact single-line JSON: no indentation, no internal newline.
      expect(firstLine).not.toContain('\n');
      expect(firstLine).not.toMatch(/\n\s+"/);
      const first = JSON.parse(firstLine);
      expect(first.event).toBe('device_code');
      expect(first.verification_url).toBe('https://mock-auth.test.qianwen.com/device?code=ABC');
      expect(first.expires_in).toBe(600);
    });

    it('streamed device_code line carries numeric expires_in_seconds equal to expires_in', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device?code=UNIT',
          expiresIn: 720,
        });
        callbacks.onSuccess({ aliyunId: 'unit-user', email: 'u@mock-auth.test.qianwen.com' });
        return true;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      const events = parseNDJSON(cap.text());
      const deviceCode = events.find((e) => e.event === 'device_code');
      expect(deviceCode).toBeDefined();
      expect(typeof deviceCode?.expires_in_seconds).toBe('number');
      expect(deviceCode?.expires_in_seconds).toBe(720);
      // Original field preserved alongside the unit-named one.
      expect(deviceCode?.expires_in).toBe(720);
      expect(deviceCode?.expires_in_seconds).toBe(deviceCode?.expires_in);
    });

    it('success path yields a standalone success line with authenticated true', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device',
          expiresIn: 600,
        });
        callbacks.onSuccess({ aliyunId: 'ok-user', email: 'ok@mock-auth.test.qianwen.com' });
        return true;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      const events = parseNDJSON(cap.text());
      const success = events.find((e) => e.event === 'success');
      expect(success).toBeDefined();
      expect(success?.authenticated).toBe(true);
    });

    it('flow returns false with onError → streams error line and exit code 1', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onError('User cancelled');
        return false;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      const events = parseNDJSON(cap.text());
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.authenticated).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('expired callback → standalone expired line', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onExpired();
        return false;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      const events = parseNDJSON(cap.text());
      const expiredEvent = events.find((e) => e.event === 'expired');
      expect(expiredEvent).toBeDefined();
      expect(expiredEvent?.authenticated).toBe(false);
    });

    it('every non-empty stdout line is valid JSON (no advisory text mixed in)', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device',
          expiresIn: 600,
        });
        callbacks.onPolling();
        callbacks.onSuccess({ aliyunId: 'pure-user', email: 'pure@mock-auth.test.qianwen.com' });
        return true;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      const lines = cap
        .text()
        .split('\n')
        .filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('streaming order: device_code is written before success, not buffered to the end', async () => {
      credResolveStub.mockReturnValue(null);
      const orderCap = captureStdoutWrites();
      // Fire onCodeReceived, then yield across an awaited microtask gap before
      // onSuccess. A streaming implementation must flush the device_code line at
      // the moment the callback fires (before the awaited gap resolves); a
      // buffered implementation (printJSON once after executeLogin resolves)
      // writes nothing until both callbacks have fired and the promise settles.
      let writesAfterCodeReceived = 0;
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device?code=ORDER',
          expiresIn: 600,
        });
        // Snapshot how many stdout writes exist immediately after the
        // device-code callback returns, before any later event.
        writesAfterCodeReceived = orderCap.chunks.length;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        callbacks.onSuccess({
          aliyunId: 'order-user',
          email: 'order@mock-auth.test.qianwen.com',
        });
        return true;
      });

      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        orderCap.restore();
      }

      // The device_code line must already have been written synchronously within
      // the onCodeReceived callback — before the awaited gap and before success.
      expect(writesAfterCodeReceived).toBeGreaterThan(0);

      const events = parseNDJSON(orderCap.text());
      const codeIdx = events.findIndex((e) => e.event === 'device_code');
      const successIdx = events.findIndex((e) => e.event === 'success');
      expect(codeIdx).toBeGreaterThanOrEqual(0);
      expect(successIdx).toBeGreaterThanOrEqual(0);
      // device_code strictly precedes success in write order.
      expect(codeIdx).toBeLessThan(successIdx);

      // The snapshotted device_code write must parse to the device_code event,
      // proving it was flushed at callback time rather than aggregated later.
      const snapshotChunk = orderCap.chunks[0];
      expect(JSON.parse(snapshotChunk.trim()).event).toBe('device_code');
    });

    it('TTY: onCodeReceived auto-opens the browser at the verification URL', async () => {
      credResolveStub.mockReturnValue(null);
      const verificationUrl = 'https://mock-auth.test.qianwen.com/device?code=OPEN-BROWSER';
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl,
          expiresIn: 600,
        });
        callbacks.onSuccess({
          aliyunId: 'browser-user',
          email: 'browser@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }

      expect(vi.mocked(exec)).toHaveBeenCalled();
      const execCommand = vi.mocked(exec).mock.calls[0]?.[0] as string;
      expect(typeof execCommand).toBe('string');
      expect(execCommand).toContain(verificationUrl);
      expect(execCommand).toMatch(/open|xdg-open|start/);
    });

    it('TTY: writes an "Opening browser" advisory to stderr while stdout stays pure NDJSON', async () => {
      credResolveStub.mockReturnValue(null);
      const verificationUrl = 'https://mock-auth.test.qianwen.com/device?code=ADVISORY';
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl,
          expiresIn: 600,
        });
        callbacks.onSuccess({
          aliyunId: 'advisory-user',
          email: 'advisory@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }

      expect(r.stderr).toContain('Opening browser');

      const lines = cap
        .text()
        .split('\n')
        .filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(cap.text()).not.toContain('Opening browser');
    });

    it('TTY auto-open: device_code line still carries verification_url / expires_in / expires_in_seconds', async () => {
      credResolveStub.mockReturnValue(null);
      const verificationUrl = 'https://mock-auth.test.qianwen.com/device?code=REGRESS';
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl,
          expiresIn: 540,
        });
        callbacks.onSuccess({
          aliyunId: 'regress-user',
          email: 'regress@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const cap = captureStdoutWrites();
      try {
        await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }

      const events = parseNDJSON(cap.text());
      const deviceCode = events.find((e) => e.event === 'device_code');
      expect(deviceCode).toBeDefined();
      expect(deviceCode?.verification_url).toBe(verificationUrl);
      expect(deviceCode?.expires_in).toBe(540);
      expect(deviceCode?.expires_in_seconds).toBe(540);
    });
  });
  // BACKFILL_PLACEHOLDER

  describe('getAuthStatus error tolerance', () => {
    it('should enter login flow when getAuthStatus throws gateway error', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok-revoked',
        source: 'keychain',
        credentials: {
          access_token: 'tok-revoked',
          expires_at: '2099-12-31T00:00:00Z',
          user: { aliyunId: 'user-revoked', email: 'rev@mock-auth.test.qianwen.com' },
        },
      });
      tokenExpiredStub.mockReturnValue(false);
      holder.client = makeMockApiClient({
        getAuthStatus: async () => {
          throw new Error('Auth gateway error: You need to log in.');
        },
      });
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device',
          expiresIn: 600,
        });
        callbacks.onSuccess({
          aliyunId: 'user-reauth',
          email: 'reauth@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      expect(r.exitCode).toBeUndefined();
      const events = parseNDJSON(cap.text()).map((e) => e.event);
      expect(events).toContain('device_code');
      expect(events).toContain('success');
      expect(deviceFlowStub).toHaveBeenCalled();
    });

    it('should enter login flow when getAuthStatus throws network error', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok-net',
        source: 'keychain',
        credentials: {
          access_token: 'tok-net',
          expires_at: '2099-12-31T00:00:00Z',
          user: { aliyunId: 'user-net', email: 'net@mock-auth.test.qianwen.com' },
        },
      });
      tokenExpiredStub.mockReturnValue(false);
      holder.client = makeMockApiClient({
        getAuthStatus: async () => {
          const err = new Error('connect ETIMEDOUT 203.0.113.1:443');
          (err as any).code = 'ETIMEDOUT';
          throw err;
        },
      });
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device',
          expiresIn: 600,
        });
        callbacks.onSuccess({
          aliyunId: 'user-net-ok',
          email: 'net-ok@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      expect(r.exitCode).toBeUndefined();
      const events = parseNDJSON(cap.text()).map((e) => e.event);
      expect(events).toContain('device_code');
      expect(events).toContain('success');
      expect(deviceFlowStub).toHaveBeenCalled();
    });

    it('should show already authenticated when getAuthStatus succeeds', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok-valid',
        source: 'keychain',
        credentials: {
          access_token: 'tok-valid',
          expires_at: '2099-12-31T00:00:00Z',
          user: { aliyunId: 'user-valid', email: 'valid@mock-auth.test.qianwen.com' },
        },
      });
      tokenExpiredStub.mockReturnValue(false);
      holder.client = makeMockApiClient({
        getAuthStatus: async () =>
          ({
            authenticated: true,
            server_verified: true,
            user: { aliyunId: 'user-valid', email: 'valid@mock-auth.test.qianwen.com' },
          }) as any,
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      expect(r.exitCode).toBeUndefined();
      const events = parseNDJSON(cap.text());
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('already_authenticated');
      expect(events[0].authenticated).toBe(true);
      expect(events[0].events).toBeUndefined();
      expect(deviceFlowStub).not.toHaveBeenCalled();
    });

    it('should enter login flow directly without calling getAuthStatus when no credentials exist', async () => {
      credResolveStub.mockReturnValue(null);
      const getAuthStatusSpy = vi.fn();
      holder.client = makeMockApiClient({
        getAuthStatus: getAuthStatusSpy,
      });
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device',
          expiresIn: 600,
        });
        callbacks.onSuccess({
          aliyunId: 'fresh-user',
          email: 'fresh@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      expect(r.exitCode).toBeUndefined();
      const events = parseNDJSON(cap.text()).map((e) => e.event);
      expect(events).toContain('device_code');
      expect(events).toContain('success');
      expect(getAuthStatusSpy).not.toHaveBeenCalled();
      expect(deviceFlowStub).toHaveBeenCalled();
    });
  });

  describe('non-TTY auto-degrade path', () => {
    it('auto-degrades to --init-only + json when stdin is not TTY', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      credResolveStub.mockReturnValue(null);
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://mock-auth.test.qianwen.com/device?code=NONTTY',
        expires_in: 300,
        device_code: 'd-nontty',
        user_code: 'NTT-001',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login']);
      expect(r.exitCode).toBeUndefined();
      // Should have written a non-interactive notice to stderr
      expect(r.stderr).toContain('Non-interactive environment detected');
      // Outputs JSON with device_code event
      const payload = JSON.parse(r.stdout);
      expect(payload.events[0].event).toBe('device_code');
      expect(payload.events[0].verification_url).toContain('NONTTY');
      // Should NOT call executeLogin (full interactive loop)
      expect(deviceFlowStub).not.toHaveBeenCalled();
      expect(deviceFlowInitOnlyStub).toHaveBeenCalled();
    });

    it('auto-degrade emits the --complete guidance exactly once (no duplicate with degrade notice)', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      credResolveStub.mockReturnValue(null);
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://mock-auth.test.qianwen.com/device?code=NODUP',
        expires_in: 300,
        device_code: 'd-nodup',
        user_code: 'NDP-001',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login']);
      expect(r.exitCode).toBeUndefined();

      // The slim degrade-only notice is present exactly once.
      const noticeMatches = r.stderr.match(/Non-interactive environment detected/g) ?? [];
      expect(noticeMatches.length).toBe(1);

      // The --complete guidance (now produced solely by runLoginInitOnly) must
      // appear, but exactly once — the degrade path no longer duplicates it.
      const completeMatches = r.stderr.match(/--complete/g) ?? [];
      expect(completeMatches.length).toBe(1);
    });

    it('non-TTY with --init-only explicit: does not double-degrade', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      credResolveStub.mockReturnValue(null);
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://mock-auth.test.qianwen.com/device',
        expires_in: 600,
        device_code: 'd-x',
        user_code: 'X-001',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      // When --init-only is explicit, no auto-degrade message
      expect(r.stderr).not.toContain('Non-interactive environment detected');
      expect(deviceFlowInitOnlyStub).toHaveBeenCalled();
    });
  });

  describe('token expired path', () => {
    it('enters login flow when credentials exist but token is expired', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok-expired',
        source: 'keychain',
        credentials: {
          access_token: 'tok-expired',
          expires_at: '2020-01-01T00:00:00Z',
          user: { aliyunId: 'expired-user' },
        },
      });
      tokenExpiredStub.mockReturnValue(true);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device',
          expiresIn: 600,
        });
        callbacks.onSuccess({
          aliyunId: 'refreshed-user',
          email: 'r@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const cap = captureStdoutWrites();
      let r;
      try {
        r = await runCommand(setup, ['auth', 'login', '--format', 'json']);
      } finally {
        cap.restore();
      }
      expect(r.exitCode).toBeUndefined();
      const events = parseNDJSON(cap.text()).map((e) => e.event);
      expect(events).toContain('device_code');
      expect(events).toContain('success');
      expect(deviceFlowStub).toHaveBeenCalled();
    });
  });

  describe('interactive text flow', () => {
    it('text mode: prints onCodeReceived info and success with identifier', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device?code=TEXT',
          expiresIn: 600,
        });
        callbacks.onPolling();
        callbacks.onSuccess({ aliyunId: 'text-user', email: 't@mock-auth.test.qianwen.com' });
        return true;
      });

      const r = await runCommand(setup, ['auth', 'login', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('Authenticated');
    });

    it('text mode: prints generic success when fetchUserIdentifier returns empty', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onCodeReceived({
          verificationUrl: 'https://mock-auth.test.qianwen.com/device',
          expiresIn: 600,
        });
        callbacks.onSuccess({ aliyunId: '', email: '' });
        return true;
      });

      const r = await runCommand(setup, ['auth', 'login', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('Authenticated');
    });

    it('text mode: onError callback prints error and sets exitCode=1', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onError('Network timeout during polling');
        return false;
      });

      await runCommand(setup, ['auth', 'login', '--format', 'text']);
      expect(process.exitCode).toBe(1);
    });

    it('text mode: onExpired callback prints expiration message', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowStub.mockImplementation(async (callbacks: any) => {
        callbacks.onExpired();
        return false;
      });

      await runCommand(setup, ['auth', 'login', '--format', 'text']);
      expect(process.exitCode).toBe(1);
    });
  });

  describe('--complete text format (TTY mode)', () => {
    it('text success: prints authenticated message', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockImplementation(async (callbacks: any) => {
        callbacks.onSuccess({
          aliyunId: 'complete-tty-user',
          email: 'ctu@mock-auth.test.qianwen.com',
        });
        return true;
      });

      const r = await runCommand(setup, ['auth', 'login', '--complete', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('Authenticated');
    });

    it('text error: prints error message from onError', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockImplementation(async (callbacks: any) => {
        callbacks.onError('Authentication has not yet completed');
        return false;
      });

      await runCommand(setup, ['auth', 'login', '--complete', '--format', 'text']);
      expect(process.exitCode).toBe(1);
    });

    it('text expired: prints device code expired message', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockImplementation(async (callbacks: any) => {
        callbacks.onExpired();
        return false;
      });

      await runCommand(setup, ['auth', 'login', '--complete', '--format', 'text']);
      expect(process.exitCode).toBe(1);
    });

    it('text: unexpected error during executeLoginComplete is surfaced', async () => {
      credResolveStub.mockReturnValue(null);
      deviceFlowCompleteStub.mockRejectedValue(new Error('createClient failed unexpectedly'));

      const r = await runCommand(setup, ['auth', 'login', '--complete', '--format', 'text']);
      expect(r.stderr).toContain('createClient failed unexpectedly');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('--init-only path — getAuthStatus error tolerance', () => {
    it('falls through to init flow when getAuthStatus throws (init-only)', async () => {
      credResolveStub.mockReturnValue({
        access_token: 'tok-initonly-err',
        source: 'keychain',
        credentials: {
          access_token: 'tok-initonly-err',
          expires_at: '2099-12-31T00:00:00Z',
          user: { aliyunId: 'init-err-user' },
        },
      });
      tokenExpiredStub.mockReturnValue(false);
      holder.client = makeMockApiClient({
        getAuthStatus: async () => {
          throw new Error('Server unavailable');
        },
      });
      deviceFlowInitOnlyStub.mockResolvedValue({
        verification_url: 'https://mock-auth.test.qianwen.com/device?code=FALLBACK',
        expires_in: 600,
        device_code: 'd-fallback',
        user_code: 'FB-001',
        interval: 5,
      });

      const r = await runCommand(setup, ['auth', 'login', '--init-only']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.events[0].event).toBe('device_code');
      expect(deviceFlowInitOnlyStub).toHaveBeenCalled();
    });
  });
});
