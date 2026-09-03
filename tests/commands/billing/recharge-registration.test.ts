import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createProgram } from '../../../src/cli.js';

function findCommand(parent: Command, name: string): Command {
  const command = parent.commands.find((candidate) => candidate.name() === name);
  expect(command, `command ${name} should be registered`).toBeDefined();
  return command as Command;
}

describe('billing balance recharge command registration', () => {
  it('registers the public recharge command and hidden result query in the real CLI tree', () => {
    const program = createProgram();
    const billing = findCommand(program, 'billing');
    const balance = findCommand(billing, 'balance');
    const recharge = findCommand(balance, 'recharge');
    findCommand(balance, 'recharge-history');
    const result = findCommand(recharge, 'result');

    expect(balance.helpInformation()).toMatch(/^\s*recharge\b/mu);
    expect(balance.helpInformation()).toContain('recharge-history');
    expect(recharge.helpInformation()).not.toMatch(/^\s*result\b/mu);
    const rechargeOptions = recharge.options.map((option) => option.long);
    expect(rechargeOptions).toEqual(expect.arrayContaining(['--channel', '--amount', '--format']));
    expect(rechargeOptions).not.toContain('--method');
    expect(result.options.find((option) => option.long === '--recharge-order-id')?.mandatory).toBe(
      true,
    );
    expect(result.options.map((option) => option.long)).toContain('--wait');

    const parsed = result.parseOptions([
      '--recharge-order-id',
      'order-registration-test',
      '--wait',
      '--format',
      'json',
    ]);
    expect(parsed.unknown).toEqual([]);
    expect(result.opts()).toMatchObject({
      rechargeOrderId: 'order-registration-test',
      wait: true,
      format: 'json',
    });
  });
});
