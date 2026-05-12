import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CliError,
  HandledError,
  authRequiredError,
  tokenExpiredError,
  modelNotFoundError,
  networkError,
  configError,
  invalidArgError,
  handleError,
  getErrorVerbosity,
} from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('CliError', () => {
  it('creates error with correct properties', () => {
    const err = new CliError({
      code: 'TEST_ERROR',
      message: 'Test error message',
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliError');
    expect(err.code).toBe('TEST_ERROR');
    expect(err.message).toBe('Test error message');
    expect(err.exitCode).toBe(1);
  });

  it('serializes to JSON correctly', () => {
    const err = new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Not authenticated',
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });

    expect(err.toJSON()).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Not authenticated',
        exit_code: 2,
      },
    });
  });

  it('serializes detail field to JSON when present', () => {
    const err = new CliError({
      code: 'NETWORK_ERROR',
      message: 'API unreachable',
      exitCode: EXIT_CODES.NETWORK_ERROR,
      detail: 'HTTP 500: Internal Server Error\n  URL: https://api.example.com',
    });

    expect(err.detail).toBe('HTTP 500: Internal Server Error\n  URL: https://api.example.com');
    expect(err.toJSON()).toEqual({
      error: {
        code: 'NETWORK_ERROR',
        message: 'API unreachable',
        exit_code: 3,
        detail: 'HTTP 500: Internal Server Error\n  URL: https://api.example.com',
      },
    });
  });

  it('omits detail from JSON when not provided', () => {
    const err = new CliError({
      code: 'CONFIG_ERROR',
      message: 'Bad config',
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });

    expect(err.detail).toBeUndefined();
    expect(err.toJSON()).not.toHaveProperty('error.detail');
  });
});

describe('Error factory functions', () => {
  it('authRequiredError creates correct error', () => {
    const err = authRequiredError();
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.message).toBe(`Not authenticated. Run: ${s.cliName} login`);
    expect(err.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
  });

  it('tokenExpiredError creates correct error', () => {
    const err = tokenExpiredError();
    expect(err.code).toBe('TOKEN_EXPIRED');
    expect(err.message).toBe(`Token expired. Run: ${s.cliName} login`);
    expect(err.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
  });

  it('modelNotFoundError creates correct error', () => {
    const err = modelNotFoundError('qwen3.6-plus');
    expect(err.code).toBe('MODEL_NOT_FOUND');
    expect(err.message).toBe("Model 'qwen3.6-plus' not found.");
    expect(err.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
  });

  it('networkError creates correct error with default message', () => {
    const err = networkError();
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toBe('Network error: API unreachable');
    expect(err.exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  it('networkError creates correct error with custom detail', () => {
    const err = networkError('Connection timeout after 30s');
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toBe('Connection timeout after 30s');
    expect(err.exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  it('configError creates correct error', () => {
    const err = configError('Invalid config file format');
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.message).toBe('Invalid config file format');
    expect(err.exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
  });

  it('invalidArgError creates correct error', () => {
    const err = invalidArgError('Unknown option: --foo');
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toBe('Unknown option: --foo');
    expect(err.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
  });
});

describe('handleError', () => {
  // Helper: call handleError and return the thrown HandledError
  function catchHandledError(error: unknown, format: 'json' | 'table' | 'text'): HandledError {
    try {
      handleError(error, format);
    } catch (e) {
      if (e instanceof HandledError) return e;
      throw e;
    }
    throw new Error('handleError did not throw');
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles CliError in table format', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Not authenticated',
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });

    const thrown = catchHandledError(err, 'table');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Not authenticated');
    expect(thrown).toBeInstanceOf(HandledError);
    expect(thrown.exitCode).toBe(2);
  });

  it('handles CliError in json format', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const err = new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Not authenticated',
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });

    const thrown = catchHandledError(err, 'json');

    // JSON errors must go to stderr so Agent pipelines (`cmd | jq`) don't see
    // them mixed into the data stream.
    expect(stderrSpy).toHaveBeenCalledWith(
      JSON.stringify({
        error: { code: 'AUTH_REQUIRED', message: 'Not authenticated', exit_code: 2 },
      }, null, 2) + '\n'
    );
    expect(thrown.exitCode).toBe(2);
  });

  it('handles CliError in text format', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new CliError({
      code: 'NETWORK_ERROR',
      message: 'API unreachable',
      exitCode: EXIT_CODES.NETWORK_ERROR,
    });

    const thrown = catchHandledError(err, 'text');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: API unreachable');
    expect(thrown.exitCode).toBe(3);
  });

  it('handles unknown Error in table format (verbose)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new Error('Something went wrong');

    const thrown = catchHandledError(err, 'table');

    // verbose mode: preserves raw error message
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Something went wrong');
    expect(thrown.exitCode).toBe(1);
  });

  it('handles unknown Error in json format (verbose)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const err = new Error('Something went wrong');

    const thrown = catchHandledError(err, 'json');

    // verbose mode: preserves raw error message in JSON output
    expect(stderrSpy).toHaveBeenCalledWith(
      JSON.stringify({
        error: { code: 'UNKNOWN_ERROR', message: 'Something went wrong', exit_code: 1 },
      }, null, 2) + '\n'
    );
    expect(thrown.exitCode).toBe(1);
  });

  it('handles non-Error unknown value (verbose)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const thrown = catchHandledError('string error', 'table');

    // verbose mode: preserves raw string
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: string error');
    expect(thrown.exitCode).toBe(1);
  });

  it('includes cause chain for unknown errors in table format (verbose)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cause = new Error('Root cause');
    const err = new Error('Failed to connect', { cause });

    const thrown = catchHandledError(err, 'table');

    // verbose mode: shows raw message + cause chain
    const output = (consoleErrorSpy.mock.calls[0] as any[])[0];
    expect(output).toContain('Failed to connect');
    expect(output).toContain('Caused by: Root cause');
    expect(thrown.exitCode).toBe(1);
  });

  it('includes cause chain for unknown errors in json format (verbose)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cause = new Error('Root cause');
    const err = new Error('Failed to connect', { cause });

    const thrown = catchHandledError(err, 'json');

    const output = JSON.parse((stderrSpy.mock.calls[0] as any[])[0]);
    // verbose mode: message includes raw error + cause chain
    expect(output.error.message).toContain('Failed to connect');
    expect(output.error.message).toContain('Caused by: Root cause');
    expect(thrown.exitCode).toBe(1);
  });

  it('limits cause chain depth to 5 levels', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create a chain of 7 errors
    let cause: Error = new Error('Level 7');
    for (let i = 6; i >= 1; i--) {
      cause = new Error(`Level ${i}`, { cause });
    }

    const thrown = catchHandledError(cause, 'table');

    const output = (consoleErrorSpy.mock.calls[0] as any[])[0];
    const causeLines = output.split('\n  Caused by: ').length - 1;
    expect(causeLines).toBeLessThanOrEqual(5);
    expect(thrown.exitCode).toBe(1);
  });
});

describe('getErrorVerbosity', () => {
  const envPrefix = s.envPrefix;

  afterEach(() => {
    delete process.env[`${envPrefix}_ERROR_VERBOSITY`];
  });

  it('returns build-time define (verbose) by default when no env var', () => {
    // Build-time __ERROR_VERBOSITY__ is set to 'verbose' in vitest config
    expect(getErrorVerbosity()).toBe('verbose');
  });

  it('returns "suppress" when env var is set', () => {
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'suppress';
    expect(getErrorVerbosity()).toBe('suppress');
  });

  it('returns "verbose" when env var is set', () => {
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'verbose';
    expect(getErrorVerbosity()).toBe('verbose');
  });

  it('ignores invalid env var values, falls back to build-time define', () => {
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'invalid';
    expect(getErrorVerbosity()).toBe('verbose');
  });
});

describe('handleError with error verbosity', () => {
  const envPrefix = s.envPrefix;

  function catchHandledError(error: unknown, format: 'json' | 'table' | 'text'): HandledError {
    try {
      handleError(error, format);
    } catch (e) {
      if (e instanceof HandledError) return e;
      throw e;
    }
    throw new Error('handleError did not throw');
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[`${envPrefix}_ERROR_VERBOSITY`];
  });

  it('suppress mode: no output, just exit code', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'suppress';

    const err = new CliError({
      code: 'NETWORK_ERROR',
      message: 'API unreachable',
      exitCode: EXIT_CODES.NETWORK_ERROR,
    });

    const thrown = catchHandledError(err, 'table');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('NETWORK_ERROR')
    );
    expect(thrown.exitCode).toBe(3);
  });

  it('verbose mode: outputs detail for CliError with detail', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'verbose';

    const err = new CliError({
      code: 'NETWORK_ERROR',
      message: 'API unreachable',
      exitCode: EXIT_CODES.NETWORK_ERROR,
      detail: 'HTTP 500: Internal Server Error\n  URL: https://api.example.com',
    });

    const thrown = catchHandledError(err, 'table');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 500')
    );
    expect(thrown.exitCode).toBe(3);
  });

  it('graceful mode: outputs only user-friendly message for unknown errors', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'graceful';

    const err = new Error('HTTP 403: Forbidden\n  URL: https://secret.internal/api\n  Response: {"detail":"token expired"}');

    const thrown = catchHandledError(err, 'table');
    const output = (consoleErrorSpy.mock.calls[0] as any[])[0];
    // Should NOT contain internal URL or response body
    expect(output).not.toContain('https://secret.internal');
    expect(output).not.toContain('Response:');
    // Should contain user-friendly message
    expect(output).toContain('Token expired');
    expect(thrown.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
  });

  it('graceful mode: JSON output does not include detail', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'graceful';

    const err = new CliError({
      code: 'NETWORK_ERROR',
      message: 'API unreachable',
      exitCode: EXIT_CODES.NETWORK_ERROR,
      detail: 'HTTP 500: Internal Server Error\n  URL: https://internal',
    });

    const thrown = catchHandledError(err, 'json');
    const output = JSON.parse((stderrSpy.mock.calls[0] as any[])[0]);
    // graceful JSON does not include detail
    expect(output.error).not.toHaveProperty('detail');
    expect(output.error.message).toBe('API unreachable');
    expect(thrown.exitCode).toBe(3);
  });

  it('verbose mode: JSON output includes detail for CliError', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'verbose';

    const err = new CliError({
      code: 'NETWORK_ERROR',
      message: 'API unreachable',
      exitCode: EXIT_CODES.NETWORK_ERROR,
      detail: 'HTTP 500: Internal Server Error',
    });

    const thrown = catchHandledError(err, 'json');
    const output = JSON.parse((stderrSpy.mock.calls[0] as any[])[0]);
    expect(output.error.detail).toBe('HTTP 500: Internal Server Error');
    expect(thrown.exitCode).toBe(3);
  });
});

describe('handleError graceful mode (explicit)', () => {
  const envPrefix = s.envPrefix;

  function catchHandledError(error: unknown, format: 'json' | 'table' | 'text'): HandledError {
    try {
      handleError(error, format);
    } catch (e) {
      if (e instanceof HandledError) return e;
      throw e;
    }
    throw new Error('handleError did not throw');
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[`${envPrefix}_ERROR_VERBOSITY`];
  });

  it('unknown Error in table format → friendly message', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'graceful';

    const thrown = catchHandledError(new Error('Something went wrong'), 'table');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: An unexpected error occurred.');
    expect(thrown.exitCode).toBe(1);
  });

  it('unknown Error in json format → friendly message with UNKNOWN_ERROR code', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'graceful';

    const thrown = catchHandledError(new Error('Something went wrong'), 'json');

    expect(stderrSpy).toHaveBeenCalledWith(
      JSON.stringify({
        error: { code: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.', exit_code: 1 },
      }, null, 2) + '\n'
    );
    expect(thrown.exitCode).toBe(1);
  });

  it('non-Error value → friendly message', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'graceful';

    const thrown = catchHandledError('string error', 'table');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: An unexpected error occurred.');
    expect(thrown.exitCode).toBe(1);
  });

  it('HTTP error with internal details → hides URL and response body', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'graceful';

    const err = new Error('HTTP 401: Unauthorized\n  URL: https://internal.api/secret\n  Response: {"token":"abc"}');

    const thrown = catchHandledError(err, 'table');
    const output = (consoleErrorSpy.mock.calls[0] as any[])[0];
    expect(output).not.toContain('https://internal.api');
    expect(output).not.toContain('Response:');
    expect(output).toContain('Not authenticated');
    expect(thrown.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
  });

  it('CliError without detail → same output in graceful and verbose', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[`${envPrefix}_ERROR_VERBOSITY`] = 'graceful';

    const err = new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Not authenticated',
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });

    const thrown = catchHandledError(err, 'table');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Not authenticated');
    expect(thrown.exitCode).toBe(2);
  });
});
