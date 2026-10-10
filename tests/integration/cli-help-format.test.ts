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
import { stripAnsi, visibleWidth } from '../../src/ui/textWrap.js';
import { runCommand } from './helpers.js';

const MAX_HELP_WIDTH = 80;
const HELP_RIGHT_MARGIN = 1;

let columnsDescriptor: PropertyDescriptor | undefined;
let isTTYDescriptor: PropertyDescriptor | undefined;
let noColor: string | undefined;
let forceColor: string | undefined;

function setTerminalColumns(columns: number): void {
  Object.defineProperty(process.stdout, 'columns', {
    value: columns,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  noColor = process.env.NO_COLOR;
  forceColor = process.env.FORCE_COLOR;
});

afterEach(() => {
  if (columnsDescriptor) {
    Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, 'columns');
  }
  if (isTTYDescriptor) {
    Object.defineProperty(process.stdout, 'isTTY', isTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, 'isTTY');
  }
  if (noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor;
  if (forceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = forceColor;
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

describe('Token Plan purchase help', () => {
  it('matches the PRD content and section order', async () => {
    const result = await runCommand(['subscription', 'tokenplan', 'purchase', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const helpContent = `Usage:
  qianwen subscription tokenplan purchase <token-plan-type> \\
    --billing-cycle <cycle> \\
    --channel <channel> \\
    (--auto-renew | --no-auto-renew) [options]

Purchase an Individual or Team Token Plan.

Arguments:
  <token-plan-type>                 Token Plan TYPE returned by
                                    'qianwen subscription tokenplan list'
                                    Allowed values:
                                      token_plan_individual_lite
                                      token_plan_individual_essential
                                      token_plan_individual_standard
                                      token_plan_individual_pro
                                      token_plan_team

Required options:
  --billing-cycle <cycle>           Billing cycle for the subscription
                                    Individual: monthly, quarterly, yearly
                                    Team: monthly, yearly

  --channel <channel>               Payment channel
                                    Supported: alipay

  Renewal option (choose one):
    --auto-renew                    Renew automatically at the end of the
                                    selected billing cycle
    --no-auto-renew                 Do not renew automatically

Team seat options:
  --standard-seat-count <count>     Number of Standard Seats
  --pro-seat-count <count>          Number of Pro Seats
  --max-seat-count <count>          Number of Max Seats

Output options:
  --format <fmt>                    Output format: table, json, text
                                    (default: auto)

Agent and Skill options:
  For controlled Agent and Skill automation only.

  --preview                         Preview purchasable configuration as JSON
                                    without creating an order.
  --confirm                         Skip interactive review and confirm; requires
                                    an explicit coupon choice, balance deduction,
                                    and preview amount.
  --preview-amount <amount>         Expected amount returned by --preview;
                                    required with --confirm and rejects quote changes.
  --coupon <coupon-id>              Select a specific coupon by ID.
  --no-coupon                       Do not apply any coupon.
  --balance-deduction <amount>      Account balance deduction in CNY.
                                    Required with --confirm; use 0 for no deduction.

  --preview and --confirm cannot be combined.
  --coupon and --no-coupon cannot be combined.
  --confirm requires --coupon or --no-coupon, --balance-deduction,
  and --preview-amount.

For token_plan_team:
  At least one seat count must be 1 or greater.
  Omitted seat types are treated as 0.
  Counts must be non-negative whole numbers.
  The total number of seats cannot exceed 150.

  Team seat options cannot be used with Individual Token Plans.

Interactive steps:
  After the Token Plan configuration is validated, the backend selects
  a default applicable coupon and returns the initial quote.

  If the remaining amount due is greater than 0, the maximum eligible
  account balance is applied by default. The user may change the balance
  deduction before payment.

  If the coupon covers the full plan amount, the balance deduction is
  set to 0 and cannot be changed.

  Available coupons are displayed only when the user chooses to change
  or remove the selected coupon.

Examples:
  qianwen subscription tokenplan purchase \\
    token_plan_individual_standard \\
    --billing-cycle quarterly \\
    --channel alipay \\
    --no-auto-renew

  qianwen subscription tokenplan purchase \\
    token_plan_team \\
    --billing-cycle yearly \\
    --channel alipay \\
    --standard-seat-count 2 \\
    --max-seat-count 1 \\
    --auto-renew`;
    const expected = helpContent
      .split('\n')
      .map((line) => (line === '' ? line : `  ${line}`))
      .join('\n');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.trimEnd()).toBe(expected);

    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    const ttyResult = await runCommand(['subscription', 'tokenplan', 'purchase', '--help']);
    expect(ttyResult.stdout).toContain('\u001B[');
    expect(stripAnsi(ttyResult.stdout)).toBe(result.stdout);
  });
});

describe('Token Plan list help', () => {
  it('documents the effective edition and billing-cycle defaults', async () => {
    const result = await runCommand(['subscription', 'tokenplan', 'list', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const help = stripAnsi(result.stdout).replace(/\s+/g, ' ');
    expect(help).toContain('Edition to display: all, individual, team (default: all)');
    expect(help).toContain('Team: monthly, yearly (default: monthly)');
    expect(help).toContain('You can view Token Plan prices without logging in.');
    expect(help).toContain(
      'Log in to also view your subscription status and account-specific availability.',
    );
    expect(help).toContain(
      'Availability shown here is for reference. Your eligibility will be verified again before purchase.',
    );
  });
});

describe('command error supplements', () => {
  it('lists all purchase types in parent help and missing-argument errors', async () => {
    const allowedTypes = [
      'token_plan_individual_lite',
      'token_plan_individual_essential',
      'token_plan_individual_standard',
      'token_plan_individual_pro',
      'token_plan_team',
    ];
    const help = await runCommand(['subscription', 'tokenplan', '--help']);
    expect(help.stdout).toContain('purchase <token-plan-type>');
    expect(help.stdout).toContain('Allowed values:');
    for (const type of allowedTypes) expect(help.stdout).toContain(type);

    await expect(
      createProgram().parseAsync(['node', 'qianwen', 'subscription', 'tokenplan', 'purchase']),
    ).rejects.toMatchObject({
      code: 'commander.missingArgument',
      exitCode: 1,
      message:
        "error: missing required argument 'token-plan-type'\nAllowed values for 'token-plan-type':\n" +
        allowedTypes.map((type) => `  ${type}`).join('\n'),
    });
  });

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
