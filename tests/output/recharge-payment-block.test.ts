import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import {
  prepareStaticQr,
  writeRechargePaymentBlock,
  writeRechargeQueryFailureBlock,
  writeRechargeResultBlock,
  writeRechargeWaitingNotice,
} from '../../src/output/recharge-payment-block.js';
import { stripAnsi } from '../../src/ui/textWrap.js';
import { encodeQrModules, toForegroundQrRows } from '../../src/utils/qr-code.js';
import { RECHARGE_FAILURE_REASON } from '../../src/view-models/billing/recharge.js';
import type { RechargePaymentViewModel } from '../../src/view-models/billing/recharge.js';

const SHORT_URL = 'https://pay.test.qianwenai.com/checkout/ui-test';
const LONG_URL =
  'https://excashier.pay.test.qianwenai.com/standard/auth.htm?payOrderId=2088aabbccddeeff112233445566778899&sign=abcdef0123456789';

function makeVm(paymentUrl: string): RechargePaymentViewModel {
  return {
    type: 'recharge',
    channel: 'alipay',
    amount: '0.01',
    currency: 'CNY',
    status: 'pending',
    rechargeOrderId: 'order-static-test',
    paymentUrl,
  };
}

const restores: (() => void)[] = [];
let lines: string[] = [];

function override<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

/** Force chalk to actually colour, and restore its level afterwards. */
function ensureChalkColours(): void {
  const previousLevel = chalk.level;
  if (chalk.level < 1) chalk.level = 3;
  restores.push(() => {
    chalk.level = previousLevel;
  });
}

/** Present a colour-capable Apple Terminal, which selects the compact layout. */
function setTrustedTerminal(): void {
  override(process, 'platform', 'darwin');
  override(process.stdin, 'isTTY', true);
  override(process.stdout, 'isTTY', true);
  override(
    process.stdout,
    'hasColors',
    vi.fn(() => true),
  );
  ensureChalkColours();
  const previous = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = 'Apple_Terminal';
  restores.push(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'TERM_PROGRAM');
    else process.env.TERM_PROGRAM = previous;
  });
  const style = process.env.QIANWEN_QR_STYLE;
  Reflect.deleteProperty(process.env, 'QIANWEN_QR_STYLE');
  restores.push(() => {
    if (style !== undefined) process.env.QIANWEN_QR_STYLE = style;
  });
}

/** Present a colour-capable Windows ConHost: no WT_SESSION, no TERM_PROGRAM. */
function setConHost(): void {
  override(process, 'platform', 'win32');
  override(process.stdin, 'isTTY', true);
  override(process.stdout, 'isTTY', true);
  override(
    process.stdout,
    'hasColors',
    vi.fn(() => true),
  );
  ensureChalkColours();
  for (const key of ['TERM_PROGRAM', 'WT_SESSION', 'QIANWEN_QR_STYLE'] as const) {
    const previous = process.env[key];
    Reflect.deleteProperty(process.env, key);
    restores.push(() => {
      if (previous !== undefined) process.env[key] = previous;
    });
  }
}

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  vi.restoreAllMocks();
});

/** Strip SGR sequences so assertions read the payload, not the styling. */
function plain(value: string): string {
  return stripAnsi(value);
}

describe('writeRechargePaymentBlock', () => {
  it('writes the raw payment URL once on its own line without a prefix', () => {
    setTrustedTerminal();
    writeRechargePaymentBlock(makeVm(SHORT_URL), 80);

    const matches = lines.filter((line) => plain(line).includes(SHORT_URL));
    expect(matches).toHaveLength(1);
    // Exactly the original value: no indent, no wrapping, no rewriting.
    expect(plain(matches[0])).toBe(SHORT_URL);
  });

  it('keeps the payment URL intact when the terminal is narrower than the URL', () => {
    setTrustedTerminal();
    writeRechargePaymentBlock(makeVm(LONG_URL), 40);

    const matches = lines.filter((line) => plain(line).includes(LONG_URL));
    expect(matches).toHaveLength(1);
    expect(plain(matches[0])).toBe(LONG_URL);
    // The application never injects a newline into the value.
    expect(lines.every((line) => !line.includes('\n'))).toBe(true);
  });

  it('preserves key details such as order type, channel, and amount', () => {
    setTrustedTerminal();
    writeRechargePaymentBlock(makeVm(SHORT_URL), 80);
    const text = lines.map(plain).join('\n');

    expect(text).toContain('Payment order created.');
    expect(text).toMatch(/TYPE\s+recharge/u);
    expect(text).toMatch(/CHANNEL\s+alipay/u);
    expect(text).toMatch(/AMOUNT\s+¥0\.01 CNY/u);
    expect(text).toContain('Alipay QR Code');
  });

  it('omits the QR code when space is insufficient but still prints the URL and reason', () => {
    setTrustedTerminal();
    writeRechargePaymentBlock(makeVm(SHORT_URL), 20);
    const text = lines.map(plain).join('\n');

    expect(text).toContain('the QR code needs');
    expect(text).toContain('Alipay QR Code');
    expect(lines.filter((line) => plain(line) === SHORT_URL)).toHaveLength(1);
  });

  it('marks only insufficient width as redrawable and reports sufficient width as drawn', () => {
    setTrustedTerminal();
    expect(writeRechargePaymentBlock(makeVm(SHORT_URL), 20)).toEqual({
      qrDrawn: false,
      qrAppendable: false,
    });
    lines = [];
    expect(writeRechargePaymentBlock(makeVm(SHORT_URL), 20, true)).toEqual({
      qrDrawn: false,
      qrAppendable: true,
    });
    lines = [];
    expect(writeRechargePaymentBlock(makeVm(SHORT_URL), 80)).toEqual({
      qrDrawn: true,
      qrAppendable: false,
    });
  });

  it('ignores height so the QR code may extend into scrollback', () => {
    setTrustedTerminal();
    override(process.stdout, 'rows', 5);
    writeRechargePaymentBlock(makeVm(SHORT_URL), 80);
    const text = lines.map(plain).join('\n');

    expect(text).not.toContain('the QR code needs');
    expect(lines.length).toBeGreaterThan(5);
  });
});

describe('toForegroundQrRows', () => {
  const ESC = String.fromCharCode(27);
  const BLOCK = '\u2588';

  it('renders both module colors as explicit foreground blocks without background SGR', () => {
    ensureChalkColours();
    const modules = encodeQrModules(SHORT_URL);
    const rows = toForegroundQrRows(modules);
    const moduleCount = modules[0].length;

    // The line count equals the module row count (size + 8, including the quiet zone).
    expect(rows.length).toBe(modules.length);
    for (const row of rows) {
      // Each line has moduleCount * 2 visible columns, preserving two columns per module.
      expect(stripAnsi(row).length).toBe(moduleCount * 2);
      // Every module uses a solid block, so the QR code does not depend on terminal background.
      expect(stripAnsi(row)).toBe(BLOCK.repeat(moduleCount * 2));
      expect(row).toContain(`${ESC}[37m`);
      // Never use background SGR (\x1b[4x / \x1b[10x); use foreground colors only.
      expect(row.includes(`${ESC}[4`)).toBe(false);
      expect(row.includes(`${ESC}[10`)).toBe(false);
      // End each line with a full reset (\x1b[0m) so colors do not leak into later lines.
      expect(row.endsWith(`${ESC}[0m`)).toBe(true);
    }

    // The top quiet-zone row is light throughout, so it contains one white foreground span.
    expect(rows[0]).toBe(`${ESC}[37m${BLOCK.repeat(moduleCount * 2)}${ESC}[0m`);
    // Dark modules exist, so at least one row explicitly switches to a black foreground.
    expect(rows.some((row) => row.includes(`${ESC}[30m`))).toBe(true);
  });
});

describe('Windows foreground-block QR rendering', () => {
  const ESC = String.fromCharCode(27);

  it('uses monochrome foreground blocks on Windows without background or erase sequences', () => {
    setConHost();
    const modules = encodeQrModules(SHORT_URL);
    writeRechargePaymentBlock(makeVm(SHORT_URL), 120);

    const qrLines = lines.filter((line) => plain(line).includes('\u2588'));
    // QR line count equals the module row count (size + 8).
    expect(qrLines).toHaveLength(modules.length);
    const moduleCount = modules[0].length;
    for (const line of qrLines) {
      // Visible width equals moduleCount * 2 plus four columns of content indentation.
      expect(plain(line).length).toBe(moduleCount * 2 + 4);
      // No background-color SGR is emitted.
      expect(line.includes(`${ESC}[4`)).toBe(false);
      expect(line.includes(`${ESC}[10`)).toBe(false);
    }

    // The block never emits cursor movement or screen/line erase sequences.
    const raw = lines.join('\n');
    expect(raw).not.toContain(`${ESC}[0J`);
    expect(raw).not.toContain(`${ESC}[2J`);
    expect(raw).not.toContain(`${ESC}[3J`);
    expect(raw).not.toMatch(new RegExp(`${ESC}\\[[0-9]*[AK]`, 'u'));
  });

  it('prints the foreground-block QR as text on narrow screens and keeps the URL above it', () => {
    setConHost();
    const modules = encodeQrModules(SHORT_URL);
    // Width is far below the QR requirement; foreground blocks survive reflow, so rendering continues.
    writeRechargePaymentBlock(makeVm(SHORT_URL), 20);
    const text = lines.map(plain).join('\n');

    const qrLines = lines.filter((line) => plain(line).includes('\u2588'));
    // Line count still matches module rows; a narrow terminal may soft-wrap without app-level pruning.
    expect(qrLines).toHaveLength(modules.length);
    // Never fall back to the insufficient-width URL hint.
    expect(text).not.toContain('the QR code needs');
    // The payment URL remains on its own line without a prefix.
    expect(lines.filter((line) => plain(line) === SHORT_URL)).toHaveLength(1);
  });
});

describe('writeRechargeWaitingNotice', () => {
  it('shows a wait prompt and one Ctrl+C shortcut in interactive output', () => {
    writeRechargeWaitingNotice(true);
    const text = lines.map(plain).join('\n');

    expect(text).toContain('Waiting for payment...');
    expect(text).toContain('Press Ctrl+C to stop.');
    expect(text).not.toContain('twice');
  });

  it('does not advertise an ineffective interrupt shortcut in non-interactive output', () => {
    writeRechargeWaitingNotice(false);
    const text = lines.map(plain).join('\n');

    expect(text).toContain('Waiting for payment...');
    expect(text).not.toContain('Ctrl+C');
  });
});

describe('writeRechargeResultBlock', () => {
  it('shows the completion message and status field for a successful result', () => {
    setTrustedTerminal();
    writeRechargeResultBlock({ type: 'recharge', rechargeOrderId: 'o1', status: 'DONE' }, 80);
    const text = lines.map(plain).join('\n');

    expect(text).toContain('Recharge Result');
    expect(text).toContain('Recharge completed.');
    expect(text).toMatch(/STATUS\s+succeeded/u);
    expect(text).not.toContain('FAILURE REASON');
  });

  it('shows the failure title, balance hint, and fixed reason after a local timeout', () => {
    setTrustedTerminal();
    writeRechargeResultBlock(
      {
        type: 'recharge',
        rechargeOrderId: 'o2',
        status: 'failed or timed out',
        reason: RECHARGE_FAILURE_REASON,
      },
      80,
    );
    const text = lines.map(plain).join('\n');

    expect(text).toContain('Recharge failed or timed out.');
    expect(text).toContain('Before trying again, check your balance');
    expect(text).toMatch(/STATUS\s+failed or timed out/u);
    expect(text).toContain(RECHARGE_FAILURE_REASON);
  });

  it('states that interruption stops only local monitoring without claiming server cancellation', () => {
    setTrustedTerminal();
    writeRechargeResultBlock(
      { type: 'recharge', rechargeOrderId: 'o3', status: 'UNKNOWN', reason: 'interrupted' },
      80,
    );
    const text = lines.map(plain).join('\n');

    expect(text).toContain('Payment status monitoring stopped.');
    expect(text).toMatch(/STATUS\s+canceled/u);
    expect(text).not.toContain('FAILURE REASON');
  });

  it('keeps every block line within the current width to avoid terminal soft wrapping', () => {
    setTrustedTerminal();
    for (const columns of [40, 80, 120]) {
      lines = [];
      writeRechargeResultBlock(
        { type: 'recharge', rechargeOrderId: 'o4', status: 'DONE' },
        columns,
      );
      for (const line of lines) {
        expect(plain(line).length).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe('writeRechargeQueryFailureBlock', () => {
  it('preserves a safe unknown terminal state without claiming failure', () => {
    setTrustedTerminal();
    writeRechargeQueryFailureBlock(80);
    const text = lines.map(plain).join('\n');

    expect(text).toContain('Recharge Result');
    expect(text).toContain('recharge result is unknown');
    expect(text).toMatch(/STATUS\s+unknown/u);
    expect(text).not.toContain('failed');
  });
});

describe('color-pipeline failure guards', () => {
  it('does not emit blank output as a QR code when chalk applies no color', () => {
    setTrustedTerminal();
    // The stream claims color support while chalk is disabled by FORCE_COLOR=0, NO_COLOR, or similar.
    chalk.level = 0;
    const prepared = prepareStaticQr(SHORT_URL, 200);

    expect('unavailable' in prepared).toBe(true);
    if (!('unavailable' in prepared)) return;
    expect(prepared.unavailable).toContain('ANSI');
  });

  it('includes SGR on every line when coloring works and emits no bare-space rows', () => {
    setTrustedTerminal();
    const prepared = prepareStaticQr(SHORT_URL, 200);

    expect('lines' in prepared).toBe(true);
    if (!('lines' in prepared)) return;
    for (const line of prepared.lines) {
      expect(line).toContain(String.fromCharCode(27));
    }
  });
});

describe('Windows ConHost', () => {
  it('renders a QR code in foreground-block mode instead of rejecting ConHost', () => {
    setConHost();
    const prepared = prepareStaticQr(SHORT_URL, 120);

    expect('lines' in prepared).toBe(true);
    if (!('lines' in prepared)) return;
    // Foreground layout paints explicit black and white blocks — no background SGR.
    for (const line of prepared.lines) {
      expect(line.includes(`${String.fromCharCode(27)}[4`)).toBe(false);
      expect(/\u2588/u.test(plain(line))).toBe(true);
    }
  });

  it('keeps foreground-block QR rendering on narrow ConHost instead of using a width fallback', () => {
    setConHost();
    const modules = encodeQrModules(SHORT_URL);
    // Width is far below the QR requirement; the terminal may wrap foreground blocks without fallback.
    const prepared = prepareStaticQr(SHORT_URL, 20);

    expect('lines' in prepared).toBe(true);
    if (!('lines' in prepared)) return;
    // Line count equals the module row count, with no pruning on narrow screens.
    expect(prepared.lines).toHaveLength(modules.length);
    for (const line of prepared.lines) {
      // Rendering still uses solid foreground blocks without background-color SGR.
      expect(/\u2588/u.test(plain(line))).toBe(true);
      expect(line.includes(`${String.fromCharCode(27)}[4`)).toBe(false);
    }
  });

  it('does not claim in fallback copy that ConHost cannot display QR codes', () => {
    setConHost();
    override(
      process.stdout,
      'hasColors',
      vi.fn(() => false),
    );
    const prepared = prepareStaticQr(SHORT_URL, 120);

    expect('unavailable' in prepared).toBe(true);
    if (!('unavailable' in prepared)) return;
    expect(prepared.unavailable).not.toContain('ConHost');
    expect(prepared.unavailable).toContain('ANSI colors');
    expect(prepared.retryOnResize).toBe(false);
  });
});

describe('prepareStaticQr', () => {
  it('returns compact QR rows for a trusted terminal with sufficient width', () => {
    setTrustedTerminal();
    const prepared = prepareStaticQr(SHORT_URL, 80);

    expect('lines' in prepared).toBe(true);
    if (!('lines' in prepared)) return;
    expect(prepared.lines.length).toBeGreaterThan(0);
  });

  it('reports current and required columns when width is insufficient', () => {
    setTrustedTerminal();
    const prepared = prepareStaticQr(SHORT_URL, 20);

    expect('unavailable' in prepared).toBe(true);
    if (!('unavailable' in prepared)) return;
    expect(prepared.unavailable).toContain('Terminal width 20');
    expect(prepared.unavailable).toMatch(/needs \d+ columns/u);
    expect(prepared.retryOnResize).toBe(true);
  });

  it('explains missing color support instead of throwing', () => {
    setTrustedTerminal();
    override(
      process.stdout,
      'hasColors',
      vi.fn(() => false),
    );
    const prepared = prepareStaticQr(SHORT_URL, 80);

    expect('unavailable' in prepared).toBe(true);
    if (!('unavailable' in prepared)) return;
    expect(prepared.unavailable).toContain('ANSI colors');
    expect(prepared.retryOnResize).toBe(false);
  });

  it('preserves the fallback explanation when the URL is too long to encode', () => {
    setTrustedTerminal();
    const prepared = prepareStaticQr(`https://pay.test.qianwenai.com/${'x'.repeat(1_000)}`, 200);

    expect('unavailable' in prepared).toBe(true);
    if (!('unavailable' in prepared)) return;
    expect(prepared.unavailable).toContain('could not be encoded');
    expect(prepared.retryOnResize).toBe(false);
  });
});
