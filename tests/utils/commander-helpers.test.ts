import { describe, it, expect } from 'vitest';
import { Command, Option } from 'commander';
import {
  addCommandErrorSupplement,
  getCommandArgs,
  getCommandErrorSupplement,
  extractCommandTree,
  setCommandHidden,
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

describe('extractCommandTree', () => {
  it('collects top-level command names, descriptions, and aliases', () => {
    const program = new Command();
    program.command('models').description('Browse models').alias('m');

    const tree = extractCommandTree(program);
    const models = tree.find((n) => n.name === 'models');

    expect(models).toBeDefined();
    expect(models!.description).toBe('Browse models');
    expect(models!.aliases).toContain('m');
  });

  it('collects long options (--flag) for each command', () => {
    const program = new Command();
    program
      .command('usage')
      .option('--format <fmt>', 'output format')
      .option('--days <n>', 'day range');

    const tree = extractCommandTree(program);
    const usage = tree.find((n) => n.name === 'usage')!;

    const longs = usage.options.map((o) => o.long);
    expect(longs).toContain('--format');
    expect(longs).toContain('--days');
  });

  it('collects OptionSpec description and takesArg for value options', () => {
    const program = new Command();
    program.command('usage').option('--days <n>', 'day range');

    const tree = extractCommandTree(program);
    const days = tree.find((n) => n.name === 'usage')!.options.find((o) => o.long === '--days')!;

    expect(days.description).toBe('day range');
    expect(days.takesArg).toBe(true);
    expect(days.choices).toEqual([]);
  });

  it('sets OptionSpec takesArg to false for boolean flags', () => {
    const program = new Command();
    program.command('models').option('--all', 'show all');

    const tree = extractCommandTree(program);
    const all = tree.find((n) => n.name === 'models')!.options.find((o) => o.long === '--all')!;

    expect(all.takesArg).toBe(false);
    expect(all.choices).toEqual([]);
  });

  it('collects OptionSpec enumerated values from .choices()', () => {
    const program = new Command();
    program
      .command('billing')
      .addOption(new Option('--group-by <g>', 'grouping').choices(['model', 'api-key']));

    const tree = extractCommandTree(program);
    const groupBy = tree
      .find((n) => n.name === 'billing')!
      .options.find((o) => o.long === '--group-by')!;

    expect(groupBy.choices).toEqual(['model', 'api-key']);
    expect(groupBy.takesArg).toBe(true);
  });

  it('uses an empty string for an omitted OptionSpec description', () => {
    const program = new Command();
    program.command('doctor').option('--format <fmt>');

    const tree = extractCommandTree(program);
    const format = tree.find((n) => n.name === 'doctor')!.options[0];

    expect(format.description).toBe('');
  });

  it('collects positional arguments with ArgSpec name, required, and variadic fields', () => {
    const program = new Command();
    program.command('search').argument('<query>', 'search query');
    program.command('install').argument('[slug...]', 'skill slugs');

    const tree = extractCommandTree(program);
    const searchArgs = tree.find((n) => n.name === 'search')!.args;
    const installArgs = tree.find((n) => n.name === 'install')!.args;

    expect(searchArgs).toEqual([{ name: 'query', required: true, variadic: false }]);
    expect(installArgs).toEqual([{ name: 'slug', required: false, variadic: true }]);
  });

  it('returns an empty args array for commands without arguments', () => {
    const program = new Command();
    program.command('doctor');

    const tree = extractCommandTree(program);
    expect(tree.find((n) => n.name === 'doctor')!.args).toEqual([]);
  });

  it('recursively collects subcommands in a nested command tree', () => {
    const program = new Command();
    const billing = program.command('billing').description('Billing');
    billing.command('balance').description('Show balance');

    const tree = extractCommandTree(program);
    const billingNode = tree.find((n) => n.name === 'billing')!;

    expect(billingNode.subcommands).toHaveLength(1);
    expect(billingNode.subcommands[0].name).toBe('balance');
  });

  it('omits hidden commands when includeHidden defaults to false', () => {
    const program = new Command();
    const login = program.command('login').description('Login');
    setCommandHidden(login, true);
    program.command('models').description('Models');

    const tree = extractCommandTree(program);

    expect(tree.find((n) => n.name === 'login')).toBeUndefined();
    expect(tree.find((n) => n.name === 'models')).toBeDefined();
  });

  it('includes hidden commands for reserved-name checks when includeHidden is true', () => {
    const program = new Command();
    const login = program.command('login').description('Login');
    setCommandHidden(login, true);

    const tree = extractCommandTree(program, { includeHidden: true });

    expect(tree.find((n) => n.name === 'login')).toBeDefined();
  });

  it('collects aliases so reserved-name checks protect built-in aliases', () => {
    const program = new Command();
    program.command('logout').description('Logout').aliases(['signout', 'exit']);

    const tree = extractCommandTree(program, { includeHidden: true });
    const logout = tree.find((n) => n.name === 'logout')!;

    expect(logout.aliases).toEqual(expect.arrayContaining(['signout', 'exit']));
  });

  it('returns an empty array for an empty program', () => {
    const program = new Command();
    expect(extractCommandTree(program)).toEqual([]);
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
