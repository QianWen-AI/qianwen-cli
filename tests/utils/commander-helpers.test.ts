import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { getCommandArgs } from '../../src/utils/commander-helpers.js';

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
});
