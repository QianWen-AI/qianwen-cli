import { describe, it, expect } from 'vitest';
import { surfaceCommanderError, shouldSwallowReplError } from '../../src/repl/repl-error.js';
import { HandledError } from '../../src/utils/errors.js';

describe('surfaceCommanderError', () => {
  describe('commander.* errors → strips "error: " prefix and returns message', () => {
    it('commander.error with a validation message → message without prefix (core case)', () => {
      const result = surfaceCommanderError({
        code: 'commander.error',
        message:
          'error: model ID is required. Provide it as a positional argument or use --model <id>',
      });
      expect(result).toBe(
        'model ID is required. Provide it as a positional argument or use --model <id>',
      );
    });

    it('commander.optionMissingArgument → message without prefix', () => {
      const result = surfaceCommanderError({
        code: 'commander.optionMissingArgument',
        message: "error: option '--model <id>' argument missing",
      });
      expect(result).toBe("option '--model <id>' argument missing");
    });

    it('commander.missingArgument → message without prefix', () => {
      const result = surfaceCommanderError({
        code: 'commander.missingArgument',
        message: 'error: missing required argument',
      });
      expect(result).toBe('missing required argument');
    });

    it('commander.* message without an "error: " prefix → returned verbatim', () => {
      const result = surfaceCommanderError({
        code: 'commander.error',
        message: 'No error prefix here',
      });
      expect(result).toBe('No error prefix here');
    });
  });

  describe('non-commander errors → null', () => {
    it('internal exit-interception sentinel → null', () => {
      const result = surfaceCommanderError({
        code: 'repl.exit.intercepted',
        message: 'process.exit intercepted',
      });
      expect(result).toBeNull();
    });

    it('error carrying only a non-zero exitCode (no code) → null', () => {
      const result = surfaceCommanderError({ exitCode: 1 });
      expect(result).toBeNull();
    });
  });
});

describe('shouldSwallowReplError', () => {
  it('returns true for HandledError of any exit code (already-printed sentinel)', () => {
    expect(shouldSwallowReplError(new HandledError(0))).toBe(true);
    expect(shouldSwallowReplError(new HandledError(1))).toBe(true);
    expect(shouldSwallowReplError(new HandledError(4))).toBe(true);
  });

  it('returns false for ordinary errors so they still render', () => {
    expect(shouldSwallowReplError(new Error('boom'))).toBe(false);
    expect(shouldSwallowReplError({ code: 'commander.error', message: 'x' })).toBe(false);
    expect(shouldSwallowReplError({ exitCode: 1 })).toBe(false);
    expect(shouldSwallowReplError(undefined)).toBe(false);
  });
});
