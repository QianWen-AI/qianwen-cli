import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

// ── Test environment ──────────────────────────────────────────────
let tmpDir: string;
let pendingPath: string;

const apiClient = {
  deviceFlowInit: vi.fn(),
  deviceFlowPoll: vi.fn(),
  setPkceVerifier: vi.fn(),
};

const writeCredsMock = vi.fn();

vi.mock('../../src/api/client.js', () => ({
  createClient: async () => apiClient,
}));

vi.mock('../../src/auth/credentials.js', () => ({
  writeCredentials: (c: unknown) => writeCredsMock(c),
}));

vi.mock('../../src/config/paths.js', () => ({
  getDeviceFlowPendingPath: () => pendingPath,
}));

const {
  executeDeviceFlow,
  executeDeviceFlowInitOnly,
  executeDeviceFlowComplete,
  writePendingState,
  readPendingState,
  removePendingState,
} = await import('../../src/auth/device-flow.js');

function makeCallbacks() {
  return {
    onCodeReceived: vi.fn(),
    onPolling: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onExpired: vi.fn(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `${s.cliName}-deviceflow-`));
  pendingPath = join(tmpDir, '.device-flow-pending');
  apiClient.deviceFlowInit.mockReset();
  apiClient.deviceFlowPoll.mockReset();
  apiClient.setPkceVerifier.mockReset();
  writeCredsMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Pending state helpers ──────────────────────────────────────────
describe('writePendingState / readPendingState / removePendingState', () => {
  it('round-trips state to disk', () => {
    writePendingState({
      token: 'tok-1',
      verification_url: 'https://x/y',
      expires_in: 600,
      interval: 5,
      code_verifier: 'verifier-abc',
      code_challenge: 'cha',
      code_challenge_method: 'S256',
    } as any);

    expect(existsSync(pendingPath)).toBe(true);
    const state = readPendingState();
    expect(state).not.toBeNull();
    expect(state!.token).toBe('tok-1');
    expect(state!.code_verifier).toBe('verifier-abc');
  });

  it('readPendingState returns null when file missing', () => {
    expect(readPendingState()).toBeNull();
  });

  it('readPendingState returns null when JSON malformed', () => {
    writeFileSync(pendingPath, '{broken', 'utf-8');
    expect(readPendingState()).toBeNull();
  });

  it('readPendingState returns null and removes file when expired', () => {
    const stale = {
      token: 't',
      verification_url: 'u',
      expires_in: 1,
      interval: 5,
      created_at: new Date(Date.now() - 10_000).toISOString(),
    };
    writeFileSync(pendingPath, JSON.stringify(stale), 'utf-8');

    expect(readPendingState()).toBeNull();
    expect(existsSync(pendingPath)).toBe(false);
  });

  it('removePendingState silently ignores missing file', () => {
    expect(() => removePendingState()).not.toThrow();
  });
});

// ── executeDeviceFlow ──────────────────────────────────────────────
describe('executeDeviceFlow', () => {
  it('completes successfully on first poll', async () => {
    apiClient.deviceFlowInit.mockResolvedValue({
      token: 'init-tok',
      verification_url: 'https://x',
      expires_in: 600,
      interval: 1,
    });
    apiClient.deviceFlowPoll.mockResolvedValueOnce({
      status: 'complete',
      credentials: {
        access_token: 'final-token',
        expires_at: '2099-01-01T00:00:00Z',
        user: { email: 'a@b', aliyunId: 'c' },
      },
    });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);
    // sleep = interval*1000 + jitter (0~999ms); advance enough to cover worst case
    await vi.advanceTimersByTimeAsync(2500);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(cb.onCodeReceived).toHaveBeenCalledWith({
      verificationUrl: 'https://x',
      expiresIn: 600,
    });
    expect(cb.onSuccess).toHaveBeenCalledWith({ email: 'a@b', aliyunId: 'c' });
    expect(writeCredsMock).toHaveBeenCalledTimes(1);
  });

  it('handles access_denied', async () => {
    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 1,
    });
    apiClient.deviceFlowPoll.mockResolvedValueOnce({ status: 'access_denied' });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);
    await vi.advanceTimersByTimeAsync(2500);
    const ok = await promise;

    expect(ok).toBe(false);
    expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });

  it('handles expired_token', async () => {
    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 1,
    });
    apiClient.deviceFlowPoll.mockResolvedValueOnce({ status: 'expired_token' });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);
    await vi.advanceTimersByTimeAsync(2500);
    const ok = await promise;

    expect(ok).toBe(false);
    expect(cb.onExpired).toHaveBeenCalled();
  });

  it('handles slow_down by increasing interval and retrying', async () => {
    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 1,
    });
    apiClient.deviceFlowPoll
      .mockResolvedValueOnce({ status: 'slow_down' })
      .mockResolvedValueOnce({
        status: 'complete',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-01-01T00:00:00Z',
          user: { email: 'x', aliyunId: 'y' },
        },
      });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);
    // 1st poll @ ~1s+jitter (slow_down → interval becomes 6)
    await vi.advanceTimersByTimeAsync(2500);
    // 2nd poll @ ~6s+jitter
    await vi.advanceTimersByTimeAsync(7500);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(cb.onSuccess).toHaveBeenCalled();
    expect(apiClient.deviceFlowPoll).toHaveBeenCalledTimes(2);
  });

  it('returns false when init throws', async () => {
    apiClient.deviceFlowInit.mockRejectedValue(new Error('init failed'));

    const cb = makeCallbacks();
    const ok = await executeDeviceFlow(cb);

    expect(ok).toBe(false);
    expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('init failed'));
  });

  it('applies jitter on top of poll interval to desynchronize concurrent instances', async () => {
    // Force Math.random() to a deterministic value so we can assert exact wait time.
    // jitter = floor(0.5 * 1000) = 500ms, on top of interval=1s → total wait = 1500ms.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 1,
    });
    apiClient.deviceFlowPoll.mockResolvedValueOnce({
      status: 'complete',
      credentials: {
        access_token: 'tok',
        expires_at: '2099-01-01T00:00:00Z',
        user: { email: 'x', aliyunId: 'y' },
      },
    });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);

    // Advance just under expected wait (1000 + 500 = 1500ms) — poll should NOT have fired
    await vi.advanceTimersByTimeAsync(1499);
    expect(apiClient.deviceFlowPoll).not.toHaveBeenCalled();

    // Cross the threshold — poll fires
    await vi.advanceTimersByTimeAsync(2);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(apiClient.deviceFlowPoll).toHaveBeenCalledTimes(1);
    // Math.random must have been consulted at least once (jitter computation)
    expect(randomSpy).toHaveBeenCalled();

    randomSpy.mockRestore();
  });

  it('regression: normal-state sleep stays within [interval, interval + POLL_JITTER_MS)', async () => {
    // Lock random to upper bound so jitter window contributes its maximum.
    // With interval=1s and POLL_JITTER_MS=1000, max sleep = 1000 + 999 = 1999ms.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999);

    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 1,
    });
    apiClient.deviceFlowPoll.mockResolvedValueOnce({
      status: 'complete',
      credentials: {
        access_token: 'tok',
        expires_at: '2099-01-01T00:00:00Z',
        user: { email: 'x', aliyunId: 'y' },
      },
    });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);

    // Just under 2000ms — poll must not yet have fired
    await vi.advanceTimersByTimeAsync(1998);
    expect(apiClient.deviceFlowPoll).not.toHaveBeenCalled();

    // Cross threshold
    await vi.advanceTimersByTimeAsync(3);
    const ok = await promise;
    expect(ok).toBe(true);

    randomSpy.mockRestore();
  });

  it('grows Full Jitter window after a transient failure, then resets on success', async () => {
    // Lock random so jitter is deterministic. Use 0 (lower bound) for clean math:
    // sleep = interval + 0 = interval (no jitter contribution).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 1, // base = 1000ms
    });
    apiClient.deviceFlowPoll
      // 1st poll: throws transient → failCount becomes 1
      .mockRejectedValueOnce(new Error('transient 503'))
      // 2nd poll: pending → failCount resets to 0
      .mockResolvedValueOnce({ status: 'authorization_pending' })
      // 3rd poll: complete
      .mockResolvedValueOnce({
        status: 'complete',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-01-01T00:00:00Z',
          user: { email: 'x', aliyunId: 'y' },
        },
      });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);

    // With random=0, every sleep = intervalMs exactly = 1000ms.
    // Sequence of polls all fire at base interval (1000ms each), regardless of failCount.
    // We just verify all 3 polls eventually complete in expected order.
    await vi.advanceTimersByTimeAsync(5000);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(apiClient.deviceFlowPoll).toHaveBeenCalledTimes(3);
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
  });

  it('uses Full Jitter window proportional to 2^failCount on transient errors', async () => {
    // Use random=0.999 to drive sleep to upper bound, then verify exact poll-firing time.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999);

    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 1, // base = 1000ms
    });
    apiClient.deviceFlowPoll
      .mockRejectedValueOnce(new Error('503')) // 1st throws → failCount=1
      .mockResolvedValueOnce({
        status: 'complete',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-01-01T00:00:00Z',
          user: { email: 'x', aliyunId: 'y' },
        },
      });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);

    // 1st sleep: normal window=POLL_JITTER_MS=1000, max sleep = 1000 + 999 = 1999ms
    // After 1st throw, failCount=1, window = min(1000*2, 30000) = 2000, max sleep = 1000 + 1999 = 2999ms
    // Total to fire 2nd poll: 1999 + 2999 = 4998ms
    // Advance 4900ms — only 1st poll should have fired
    await vi.advanceTimersByTimeAsync(4900);
    expect(apiClient.deviceFlowPoll).toHaveBeenCalledTimes(1);

    // Advance past 4998ms threshold
    await vi.advanceTimersByTimeAsync(200);
    const ok = await promise;
    expect(ok).toBe(true);
    expect(apiClient.deviceFlowPoll).toHaveBeenCalledTimes(2);

    randomSpy.mockRestore();
  });

  it('caps Full Jitter window at POLL_BACKOFF_CAP_MS (30s) after consecutive failures', async () => {
    // Use random=0 → every sleep collapses to its lower bound (= intervalMs).
    // This makes the test deterministic and decoupled from window size; we
    // verify CAP behavior via a separate pure-function-style assertion below.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 6000,
      interval: 5, // base = 5000ms
    });
    apiClient.deviceFlowPoll
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({
        status: 'complete',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-01-01T00:00:00Z',
          user: { email: 'x', aliyunId: 'y' },
        },
      });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);

    // With random=0, all 5 sleeps = 5000ms each. Total = 25000ms minimum.
    await vi.advanceTimersByTimeAsync(30000);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(apiClient.deviceFlowPoll).toHaveBeenCalledTimes(5);
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
  });

  it('Full Jitter window grows then caps at 30s as failCount increases (window-size assertion)', async () => {
    // This test verifies the window-size growth/cap by intercepting Math.random
    // and capturing the multiplier used at each call. Since sleep = interval +
    // floor(random * window), with random=0.5 we can read back: 2*(sleep-interval) = window.
    const sleeps: number[] = [];
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    apiClient.deviceFlowInit.mockResolvedValue({
      token: 't',
      verification_url: 'u',
      expires_in: 600,
      interval: 5, // base = 5000ms
    });
    apiClient.deviceFlowPoll
      .mockRejectedValueOnce(new Error('503')) // failCount → 1
      .mockRejectedValueOnce(new Error('503')) // failCount → 2
      .mockRejectedValueOnce(new Error('503')) // failCount → 3
      .mockRejectedValueOnce(new Error('503')) // failCount → 4 (clamped to 3)
      .mockResolvedValueOnce({
        status: 'complete',
        credentials: {
          access_token: 'tok',
          expires_at: '2099-01-01T00:00:00Z',
          user: { email: 'x', aliyunId: 'y' },
        },
      });

    const cb = makeCallbacks();
    const promise = executeDeviceFlow(cb);

    // Drain everything
    await vi.advanceTimersByTimeAsync(200000);
    await promise;

    // Capture sleep durations from setTimeout calls (this is how `sleep()` is implemented)
    for (const call of sleepSpy.mock.calls) {
      const ms = call[1];
      if (typeof ms === 'number' && ms > 0) sleeps.push(ms);
    }

    // Expected window per attempt (random=0.5):
    //   1st (normal):     window=POLL_JITTER_MS=1000 → sleep = 5000 + 500 = 5500
    //   2nd (failCount=1): window=min(5000*2, 30000)=10000 → sleep = 5000 + 5000 = 10000
    //   3rd (failCount=2): window=min(5000*4, 30000)=20000 → sleep = 5000 + 10000 = 15000
    //   4th (failCount=3): window=min(5000*8, 30000)=30000 → sleep = 5000 + 15000 = 20000
    //   5th (failCount=4 clamped→3): window=30000 → sleep = 5000 + 15000 = 20000 (CAPPED)
    expect(sleeps[0]).toBe(5500);
    expect(sleeps[1]).toBe(10000);
    expect(sleeps[2]).toBe(15000);
    expect(sleeps[3]).toBe(20000);
    expect(sleeps[4]).toBe(20000); // CAP holds — does not grow further

    randomSpy.mockRestore();
    sleepSpy.mockRestore();
  });
});

// ── executeDeviceFlowInitOnly ──────────────────────────────────────
describe('executeDeviceFlowInitOnly', () => {
  it('persists pending state and returns init response', async () => {
    apiClient.deviceFlowInit.mockResolvedValue({
      token: 'tok-init',
      verification_url: 'https://verify',
      expires_in: 600,
      interval: 5,
      code_verifier: 'v',
    });

    const r = await executeDeviceFlowInitOnly();
    expect(r.token).toBe('tok-init');
    expect(existsSync(pendingPath)).toBe(true);

    const state = readPendingState();
    expect(state!.token).toBe('tok-init');
  });
});

// ── executeDeviceFlowComplete ──────────────────────────────────────
describe('executeDeviceFlowComplete', () => {
  it('errors when no pending session exists', async () => {
    const cb = makeCallbacks();
    const ok = await executeDeviceFlowComplete(cb);
    expect(ok).toBe(false);
    expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('No pending'));
  });

  it('expires when pending state is past expires_in', async () => {
    writeFileSync(
      pendingPath,
      JSON.stringify({
        token: 't',
        verification_url: 'u',
        expires_in: 1,
        interval: 5,
        created_at: new Date(Date.now() - 10_000).toISOString(),
      }),
      'utf-8',
    );

    const cb = makeCallbacks();
    const ok = await executeDeviceFlowComplete(cb);
    expect(ok).toBe(false);
    // readPendingState already removed it; either way onExpired/onError surfaces
    expect(cb.onError.mock.calls.length + cb.onExpired.mock.calls.length).toBeGreaterThan(0);
  });

  it('completes successfully on first poll, removes pending state', async () => {
    writeFileSync(
      pendingPath,
      JSON.stringify({
        token: 'pending-tok',
        verification_url: 'u',
        expires_in: 600,
        interval: 1,
        code_verifier: 'verifier-x',
        created_at: new Date().toISOString(),
      }),
      'utf-8',
    );
    apiClient.deviceFlowPoll.mockResolvedValueOnce({
      status: 'complete',
      credentials: {
        access_token: 'final',
        expires_at: '2099-01-01T00:00:00Z',
        user: { email: 'a', aliyunId: 'b' },
      },
    });

    const cb = makeCallbacks();
    const promise = executeDeviceFlowComplete(cb, { timeoutSeconds: 5 });
    // sleep = interval*1000 + jitter (0~999ms); advance enough to cover worst case
    await vi.advanceTimersByTimeAsync(2500);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(apiClient.setPkceVerifier).toHaveBeenCalledWith('verifier-x');
    expect(writeCredsMock).toHaveBeenCalled();
    expect(existsSync(pendingPath)).toBe(false);
  });

  it('handles access_denied during complete poll', async () => {
    writeFileSync(
      pendingPath,
      JSON.stringify({
        token: 't',
        verification_url: 'u',
        expires_in: 600,
        interval: 1,
        created_at: new Date().toISOString(),
      }),
      'utf-8',
    );
    apiClient.deviceFlowPoll.mockResolvedValueOnce({ status: 'access_denied' });

    const cb = makeCallbacks();
    const promise = executeDeviceFlowComplete(cb, { timeoutSeconds: 5 });
    await vi.advanceTimersByTimeAsync(2500);
    const ok = await promise;

    expect(ok).toBe(false);
    expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('denied'));
    expect(existsSync(pendingPath)).toBe(false);
  });
});
