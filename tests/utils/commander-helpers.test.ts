import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  addCommandErrorSupplement,
  getCommandArgs,
  getCommandErrorSupplement,
} from '../../src/utils/commander-helpers.js';

// getCommandArgs must read positional arguments from commander's PUBLIC
// `registeredArguments` array, never the private `_args` field. In a production
// build, property mangling rewrites underscore-prefixed accessors, so a project
// that reads `cmd._args` resolves to `undefined` and loses every positional
// argument. The public `registeredArguments` name survives mangling.
describe('getCommandArgs', () => {
  it('reads from the public registeredArguments, not the private _args', () => {
    // Simulate the production-mangle failure mode directly: the private `_args`
    // accessor no longer resolves (undefined), while the public array still
    // carries the argument. An implementation that reads `_args` returns [];
    // one that reads `registeredArguments` returns the argument.
    const cmd = {
      registeredArguments: [{ name: () => 'id', required: false }],
      _args: undefined,
    } as unknown as Command;

    const args = getCommandArgs(cmd);

    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('id');
    expect(args[0].required).toBe(false);
  });

  it('returns the registered argument from a real Command', () => {
    const cmd = new Command().argument('<query>');

    const args = getCommandArgs(cmd);

    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('query');
    expect(args[0].required).toBe(true);
  });

  it('returns an empty array for a command with no arguments', () => {
    const cmd = new Command();

    expect(getCommandArgs(cmd)).toEqual([]);
  });

  // H-4: the help formatter renders an `Arguments:` block keyed off each
  // positional argument's description. getCommandArgs must therefore surface the
  // description text registered via `.argument(name, description)`, alongside the
  // existing name()/required fields it already exposes.
  it('exposes the description registered for a positional argument', () => {
    const cmd = new Command().argument('[message...]', 'User prompt, piped stdin prepended');

    const args = getCommandArgs(cmd);

    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('message');
    expect(args[0].required).toBe(false);
    expect(args[0].description).toBe('User prompt, piped stdin prepended');
  });

  it('reports an empty description when an argument was registered without one', () => {
    const cmd = new Command().argument('<query>');

    const args = getCommandArgs(cmd);

    expect(args).toHaveLength(1);
    // No description was supplied; commander stores '' for the Argument.
    expect(args[0].description).toBe('');
  });
});

// applyExitOverride (src/cli.ts) enriches CommanderError messages with the
// supplement registered for the exact (code, message) pair, so option-hint
// guidance survives the structured error path. The pairing must be exact:
// a same-code error with different wording must not pick up a foreign hint.
describe('command error supplements', () => {
  it('returns the supplement when both code and message match', () => {
    const cmd = new Command();
    addCommandErrorSupplement(cmd, {
      code: 'commander.optionMissingArgument',
      message: "error: option '--channel <channel>' argument missing",
      supplement: 'Available values: alipay',
    });

    const supplement = getCommandErrorSupplement(cmd, {
      code: 'commander.optionMissingArgument',
      message: "error: option '--channel <channel>' argument missing",
    });

    expect(supplement).toBe('Available values: alipay');
  });

  it('resolves each of multiple supplements registered on one command', () => {
    const cmd = new Command();
    addCommandErrorSupplement(cmd, {
      code: 'commander.optionMissingArgument',
      message: "error: option '--channel <channel>' argument missing",
      supplement: 'Available values: alipay',
    });
    addCommandErrorSupplement(cmd, {
      code: 'commander.optionMissingArgument',
      message: "error: option '--amount <amount>' argument missing",
      supplement: 'Enter a positive CNY amount with at most two decimal places.',
    });

    expect(
      getCommandErrorSupplement(cmd, {
        code: 'commander.optionMissingArgument',
        message: "error: option '--amount <amount>' argument missing",
      }),
    ).toBe('Enter a positive CNY amount with at most two decimal places.');
    expect(
      getCommandErrorSupplement(cmd, {
        code: 'commander.optionMissingArgument',
        message: "error: option '--channel <channel>' argument missing",
      }),
    ).toBe('Available values: alipay');
  });

  it('requires an exact message match, not just the error code', () => {
    const cmd = new Command();
    addCommandErrorSupplement(cmd, {
      code: 'commander.optionMissingArgument',
      message: "error: option '--channel <channel>' argument missing",
      supplement: 'Available values: alipay',
    });

    const supplement = getCommandErrorSupplement(cmd, {
      code: 'commander.optionMissingArgument',
      message: "error: option '--format <fmt>' argument missing",
    });

    expect(supplement).toBeUndefined();
  });

  it('returns undefined for a command without registered supplements', () => {
    const cmd = new Command();

    expect(
      getCommandErrorSupplement(cmd, {
        code: 'commander.optionMissingArgument',
        message: "error: option '--channel <channel>' argument missing",
      }),
    ).toBeUndefined();
  });

  it('keeps supplements isolated per command instance', () => {
    const registered = new Command();
    const other = new Command();
    addCommandErrorSupplement(registered, {
      code: 'commander.missingArgument',
      message: 'error: missing required argument',
      supplement: 'Provide the ticket id.',
    });

    expect(
      getCommandErrorSupplement(other, {
        code: 'commander.missingArgument',
        message: 'error: missing required argument',
      }),
    ).toBeUndefined();
  });
});
