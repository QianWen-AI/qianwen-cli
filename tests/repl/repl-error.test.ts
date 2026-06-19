import { describe, it, expect } from 'vitest';
import { surfaceCommanderError } from '../../src/repl/repl-error.js';

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
