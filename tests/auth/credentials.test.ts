import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';
import { CliError } from '../../src/utils/errors.js';
import type { Credentials } from '../../src/types/auth.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeCredentials(expiresAt: Date): Credentials {
  return {
    access_token: 'test-token',
    expires_at: expiresAt.toISOString(),
    user: { email: 'test@example.com', aliyunId: 'test-user' },
  };
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

// ── Pure utility function tests (no mocking needed) ─────────────────

describe('isTokenExpired', () => {
  let isTokenExpired: typeof import('../../src/auth/credentials.js').isTokenExpired;

  beforeEach(async () => {
    const mod = await import('../../src/auth/credentials.js');
    isTokenExpired = mod.isTokenExpired;
  });

  it('returns true for expired token', () => {
    const creds = makeCredentials(new Date(Date.now() - 60000)); // 1 min ago
    expect(isTokenExpired(creds)).toBe(true);
  });

  it('returns false for valid token', () => {
    const creds = makeCredentials(hoursFromNow(24));
    expect(isTokenExpired(creds)).toBe(false);
  });

  it('returns true for token expiring exactly now', () => {
    const creds = makeCredentials(new Date());
    expect(isTokenExpired(creds)).toBe(true);
  });
});

describe('isTokenExpiringSoon', () => {
  let isTokenExpiringSoon: typeof import('../../src/auth/credentials.js').isTokenExpiringSoon;

  beforeEach(async () => {
    const mod = await import('../../src/auth/credentials.js');
    isTokenExpiringSoon = mod.isTokenExpiringSoon;
  });

  it('returns true when token expires within default threshold (5 min)', () => {
    const creds = makeCredentials(minutesFromNow(3));
    expect(isTokenExpiringSoon(creds)).toBe(true);
  });

  it('returns false when token has plenty of time', () => {
    const creds = makeCredentials(hoursFromNow(24));
    expect(isTokenExpiringSoon(creds)).toBe(false);
  });

  it('returns true when token expires within custom threshold', () => {
    const creds = makeCredentials(minutesFromNow(50));
    expect(isTokenExpiringSoon(creds, 60)).toBe(true);
  });

  it('returns false when token expires after custom threshold', () => {
    const creds = makeCredentials(minutesFromNow(90));
    expect(isTokenExpiringSoon(creds, 60)).toBe(false);
  });

  it('returns true for already expired token', () => {
    const creds = makeCredentials(new Date(Date.now() - 60000));
    expect(isTokenExpiringSoon(creds)).toBe(true);
  });
});

describe('getTokenRemainingTime', () => {
  let getTokenRemainingTime: typeof import('../../src/auth/credentials.js').getTokenRemainingTime;

  beforeEach(async () => {
    const mod = await import('../../src/auth/credentials.js');
    getTokenRemainingTime = mod.getTokenRemainingTime;
  });

  it('returns "expired" for expired token', () => {
    const creds = makeCredentials(new Date(Date.now() - 60000));
    expect(getTokenRemainingTime(creds)).toBe('expired');
  });

  it('returns hours and minutes format for long-lived token', () => {
    const creds = makeCredentials(hoursFromNow(3.75)); // 3h 45m
    const result = getTokenRemainingTime(creds);
    expect(result).toMatch(/^3h 4[45]m$/); // allow 1 min tolerance
  });

  it('returns minutes-only format for short-lived token', () => {
    const creds = makeCredentials(minutesFromNow(30));
    const result = getTokenRemainingTime(creds);
    expect(result).toMatch(/^(29|30)m$/);
  });
});

// ── warnIfTokenExpiringSoon tests ───────────────────────────────────

describe('warnIfTokenExpiringSoon', () => {
  let warnIfTokenExpiringSoon: typeof import('../../src/auth/credentials.js').warnIfTokenExpiringSoon;
  let stderrWriteSpy: any;
  const originalIsTTY = process.stderr.isTTY;

  beforeEach(async () => {
    const mod = await import('../../src/auth/credentials.js');
    warnIfTokenExpiringSoon = mod.warnIfTokenExpiringSoon;
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTTY, writable: true });
  });

  it('outputs warning on TTY when token expires within 4 hours', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true });
    const creds = makeCredentials(hoursFromNow(2));

    warnIfTokenExpiringSoon(creds);

    expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
    const output = stderrWriteSpy.mock.calls[0][0] as string;
    expect(output).toContain('Token expires in');
    expect(output).toContain('run auth login to refresh');
  });

  it('stays silent on non-TTY', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, writable: true });
    const creds = makeCredentials(hoursFromNow(2));

    warnIfTokenExpiringSoon(creds);

    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it('stays silent when token has more than 4 hours', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true });
    const creds = makeCredentials(hoursFromNow(24));

    warnIfTokenExpiringSoon(creds);

    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it('stays silent when token is already expired', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true });
    const creds = makeCredentials(new Date(Date.now() - 60000));

    warnIfTokenExpiringSoon(creds);

    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });
});

// ── Error factory integration tests ─────────────────────────────────
// ensureAuthenticated depends on resolveCredentials which reads from
// real credential stores (keychain/file). Instead of complex mocking,
// we verify the error factories it uses produce correct CliError instances.

describe('auth error factories (used by ensureAuthenticated)', () => {
  it('authRequiredError produces CliError with correct code and exitCode', async () => {
    const { authRequiredError } = await import('../../src/utils/errors.js');
    const err = authRequiredError();
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
    expect(err.message).toContain('Not authenticated');
  });

  it('tokenExpiredError produces CliError with correct code and exitCode', async () => {
    const { tokenExpiredError } = await import('../../src/utils/errors.js');
    const err = tokenExpiredError();
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('TOKEN_EXPIRED');
    expect(err.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
    expect(err.message).toContain('Token expired');
  });

  it('authRequiredError serializes to correct JSON shape', async () => {
    const { authRequiredError } = await import('../../src/utils/errors.js');
    const err = authRequiredError();
    const json = err.toJSON();
    expect(json).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: expect.stringContaining('Not authenticated'),
        exit_code: 2,
      },
    });
  });

  it('tokenExpiredError serializes to correct JSON shape', async () => {
    const { tokenExpiredError } = await import('../../src/utils/errors.js');
    const err = tokenExpiredError();
    const json = err.toJSON();
    expect(json).toEqual({
      error: {
        code: 'TOKEN_EXPIRED',
        message: expect.stringContaining('Token expired'),
        exit_code: 2,
      },
    });
  });
});
