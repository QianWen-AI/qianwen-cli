/**
 * Integration tests for the custom help formatter and error-supplement
 * wiring applied by createProgram (src/cli.ts).
 *
 * The formatter must keep every physical line inside the terminal's right
 * edge: help width resolves to min(80, columns - 1), and descriptions wrap
 * into the description column. The assertions measure visible width, so they
 * stay valid whether or not styling escapes are present.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProgram } from '../../src/cli.js';
import { visibleWidth } from '../../src/ui/textWrap.js';
import { runCommand } from './helpers.js';

const MAX_HELP_WIDTH = 80;
const HELP_RIGHT_MARGIN = 1;

let columnsDescriptor: PropertyDescriptor | undefined;

function setTerminalColumns(columns: number): void {
  Object.defineProperty(process.stdout, 'columns', {
    value: columns,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
});

afterEach(() => {
  if (columnsDescriptor) {
    Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, 'columns');
  }
});

function helpLines(stdout: string): string[] {
  return stdout.split('\n');
}

describe('help width stays inside the terminal', () => {
  it('wraps root help to a narrow terminal without crossing its right edge', async () => {
    setTerminalColumns(40);
    const r = await runCommand(['--help']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('Commands:');
    for (const line of helpLines(r.stdout)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40 - HELP_RIGHT_MARGIN);
    }
  });

  it('caps root help at the max width on a wide terminal', async () => {
    setTerminalColumns(200);
    const r = await runCommand(['--help']);

    expect(r.exitCode).toBe(0);
    for (const line of helpLines(r.stdout)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(MAX_HELP_WIDTH);
    }
  });

  it('wraps a long command description inside a narrow terminal', async () => {
    setTerminalColumns(60);
    const r = await runCommand(['usage', 'breakdown', '--help']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('PAYG only');
    for (const line of helpLines(r.stdout)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60 - HELP_RIGHT_MARGIN);
    }
  });

  it('keeps grouped root sections in the layout', async () => {
    setTerminalColumns(120);
    const r = await runCommand(['--help']);

    expect(r.stdout).toContain('Core:');
    expect(r.stdout).toContain('Usage & billing:');
    expect(r.stdout).toContain('Operations:');
  });
});

describe('command error supplements', () => {
  it('appends the registered hint when --channel loses its argument', async () => {
    const program = createProgram();
    let caught: unknown;
    try {
      await program.parseAsync(['node', 'qianwen', 'billing', 'balance', 'recharge', '--channel']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('commander.optionMissingArgument');
    expect((caught as Error).message).toContain('Available values: alipay');
  });

  it('appends the amount hint for the --amount option', async () => {
    const program = createProgram();
    let caught: unknown;
    try {
      await program.parseAsync([
        'node',
        'qianwen',
        'billing',
        'balance',
        'recharge',
        '--channel',
        'alipay',
        '--amount',
      ]);
    } catch (error) {
      caught = error;
    }

    expect((caught as { code?: string }).code).toBe('commander.optionMissingArgument');
    expect((caught as Error).message).toContain(
      'Enter a positive CNY amount with at most two decimal places.',
    );
  });

  it('does not attach a supplement to unrelated parse errors', async () => {
    const program = createProgram();
    let caught: unknown;
    try {
      await program.parseAsync([
        'node',
        'qianwen',
        'billing',
        'balance',
        'recharge',
        '--bogus-flag',
      ]);
    } catch (error) {
      caught = error;
    }

    expect((caught as { code?: string }).code).toBe('commander.unknownOption');
    expect((caught as Error).message).not.toContain('Available values: alipay');
  });
});
