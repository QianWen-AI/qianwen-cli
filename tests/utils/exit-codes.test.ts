import { describe, it, expect } from 'vitest';
import { EXIT_CODES, type ExitCode } from '../../src/utils/exit-codes.js';

// These are part of the public CLI contract documented in PRD §error model.
// Lock them down so accidental renames or numeric changes break the build.

describe('EXIT_CODES contract', () => {
  it('matches the documented numeric contract', () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.GENERAL_ERROR).toBe(1);
    expect(EXIT_CODES.AUTH_FAILURE).toBe(2);
    expect(EXIT_CODES.NETWORK_ERROR).toBe(3);
    expect(EXIT_CODES.CONFIG_ERROR).toBe(4);
    expect(EXIT_CODES.USER_INTERRUPT).toBe(130);
  });

  it('exposes all nine known exit codes (no extras silently added)', () => {
    expect(Object.keys(EXIT_CODES).sort()).toEqual(
      [
        'AUTH_FAILURE',
        'CONFIG_ERROR',
        'GENERAL_ERROR',
        'NETWORK_ERROR',
        'NOT_FOUND',
        'RATE_LIMITED',
        'SERVER_ERROR',
        'SUCCESS',
        'USER_INTERRUPT',
      ].sort(),
    );
  });

  it('ExitCode type accepts every EXIT_CODES value', () => {
    // Compile-time check: each value should satisfy ExitCode. We surface this
    // as a runtime no-op so the test file fails to compile if the type drifts.
    const values: ExitCode[] = [
      EXIT_CODES.SUCCESS,
      EXIT_CODES.GENERAL_ERROR,
      EXIT_CODES.AUTH_FAILURE,
      EXIT_CODES.NETWORK_ERROR,
      EXIT_CODES.CONFIG_ERROR,
      EXIT_CODES.RATE_LIMITED,
      EXIT_CODES.SERVER_ERROR,
      EXIT_CODES.NOT_FOUND,
      EXIT_CODES.USER_INTERRUPT,
    ];
    expect(values).toHaveLength(9);
  });
});
