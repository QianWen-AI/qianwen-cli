import chalk from 'chalk';
import { colors } from '../ui/theme.js';
import {
  backgroundQrRenderedColumns,
  encodeQrModules,
  qrRenderedColumns,
  toBackgroundQrRows,
  toCompactQrRows,
  toForegroundQrRows,
  type QrSegment,
} from '../utils/qr-code.js';
import { isConHost, resolveQrRenderMode } from '../ui/terminalCompat.js';
import { RECHARGE_LABEL_WIDTH, formatRechargeAmount } from '../view-models/billing/recharge.js';
import {
  buildRechargeResultDisplay,
  describeRechargeResult,
} from '../view-models/billing/recharge.js';
import type {
  RechargePaymentViewModel,
  RechargeResultViewModel,
} from '../view-models/billing/recharge.js';
import { classifyRechargeStatus } from '../utils/recharge-status.js';
import { formatCmd } from '../utils/runtime-mode.js';
import { theme } from '../ui/theme.js';

const SECTION_INDENT = '  ';
const CONTENT_INDENT = '    ';
// Built from a char code so this module carries no literal control character.
const SGR_PREFIX = `${String.fromCharCode(27)}[`;
// Section indents by two columns and the content block adds two more.
const QR_INDENT_COLUMNS = 4;

/**
 * Print a section header matching the Ink `Section` chrome.
 *
 * @param title Header label.
 * @param columns Current terminal width.
 */
function writeSectionTitle(title: string, columns: number): void {
  const width = Math.max(1, columns - SECTION_INDENT.length - 1);
  const dashes = '─'.repeat(Math.max(1, width - title.length));
  console.log(
    `${SECTION_INDENT}${chalk.hex(colors.brand).bold(title)}${chalk.hex(colors.border)(dashes)}`,
  );
}

/** Convert one styled run into an ANSI-coloured string. */
function paintSegment(segment: QrSegment): string {
  const background = segment.backgroundColor === 'black' ? chalk.bgBlack : chalk.bgWhite;
  if (segment.color === undefined) return background(segment.text);
  return segment.color === 'black'
    ? background.black(segment.text)
    : background.white(segment.text);
}

/** Terminal QR prepared for a static write, or a classified reason it was skipped. */
type PreparedQr =
  | { readonly lines: readonly string[] }
  | { readonly unavailable: string; readonly retryOnResize: boolean };

/** Outcome of attempting to append a QR after a terminal resize. */
export type RechargeQrAppendResult = 'appended' | 'width_insufficient' | 'unavailable';

/** Explain why the current terminal cannot paint a QR at all. */
function describeUnavailableQr(): string {
  if (process.env.QIANWEN_QR_STYLE === 'off') {
    return 'QR display is disabled by QIANWEN_QR_STYLE=off. Use the payment link above.';
  }
  if (process.stdout.isTTY !== true) {
    return 'QR display requires an interactive terminal. Use the payment link above.';
  }
  if (process.stdout.hasColors?.(16) !== true || chalk.level < 1) {
    return 'QR display requires ANSI colors, which this terminal does not report. Use the payment link above.';
  }
  return 'QR display is unavailable in this terminal. Use the payment link above.';
}

/**
 * Encode the payment URL and decide once whether it fits the current width.
 *
 * Height is deliberately not considered: a tall code simply scrolls into the
 * terminal's scrollback, which the user can scroll back to. Width is treated
 * differently per mode. Background and half-block modes bake a colour fill into
 * every cell, so a terminal that soft-wraps an over-wide row folds it into an
 * unscannable smear that widening the window cannot undo — those modes keep the
 * width guard and offer the link alone when too narrow. The foreground mode
 * paints explicit black and white glyphs that a reflow-capable terminal
 * (Windows) keeps and rewraps, so it is emitted as ordinary text at any width:
 * too narrow it simply soft-wraps for now, and widening the window reflows it
 * back to a scannable shape. The payment link printed above always stands as
 * the fallback either way.
 *
 * @param paymentUrl Validated payment link.
 * @param columns Current terminal width.
 * @param canAppendOnResize Whether a live frame will append the code after the
 * terminal becomes wide enough. Only then may the fallback promise that
 * widening the terminal will help.
 * @returns Painted QR lines, or the reason no code was drawn.
 */
export function prepareStaticQr(
  paymentUrl: string,
  columns: number,
  canAppendOnResize = false,
): PreparedQr {
  const mode = resolveQrRenderMode();
  if (mode === 'off') {
    return { unavailable: describeUnavailableQr(), retryOnResize: false };
  }

  let modules;
  try {
    modules = encodeQrModules(paymentUrl);
  } catch {
    return {
      unavailable:
        'QR display is unavailable because the payment link could not be encoded. Use the payment link above.',
      retryOnResize: false,
    };
  }

  let lines: string[];
  if (mode === 'foreground') {
    // Explicit foreground blocks carry both polarities without a background
    // SGR, so a resize reflow keeps and rewraps the code instead of blanking it.
    lines = toForegroundQrRows(modules).map((row) => `${CONTENT_INDENT}${row}`);
  } else {
    const rows = mode === 'compact' ? toCompactQrRows(modules) : toBackgroundQrRows(modules);
    lines = rows.map((segments) => `${CONTENT_INDENT}${segments.map(paintSegment).join('')}`);
  }
  // Last line of defence: the mode gate already requires a colouring pipeline,
  // but an uncoloured run would render as a block of plain spaces or bare half
  // blocks that merely looks like blank output. Refuse rather than emit that.
  if (lines.some((line) => !line.includes(SGR_PREFIX))) {
    return {
      unavailable:
        'QR display is unavailable because this terminal did not accept ANSI colors. Use the payment link above.',
      retryOnResize: false,
    };
  }

  // Foreground glyphs survive a reflow, so the code goes out as plain text at
  // any width and the terminal owns the wrapping — no width guard applies.
  if (mode === 'foreground') return { lines };

  // ConHost wraps as soon as the final column is filled, so a code that exactly
  // fits would fold onto the next row and become unscannable. Reserve one column
  // there and report it in the requirement, keeping the hint self-consistent.
  const reservedColumns = isConHost() ? 1 : 0;
  const required =
    (mode === 'compact' ? qrRenderedColumns(modules) : backgroundQrRenderedColumns(modules)) +
    QR_INDENT_COLUMNS +
    reservedColumns;
  if (columns < required) {
    const remedy = canAppendOnResize
      ? 'Widen the terminal to show it, or use the payment link above.'
      : 'Use the payment link above.';
    return {
      unavailable: `Terminal width ${columns}; the QR code needs ${required} columns. ${remedy}`,
      retryOnResize: true,
    };
  }

  return { lines };
}

/**
 * Write the immutable part of a created order straight to the main screen.
 *
 * Everything here is fixed once the order exists, so it is ordinary terminal
 * text rather than an Ink frame: the terminal owns all line breaking, output
 * taller than the viewport scrolls into scrollback, and the payment link goes
 * out as one unprefixed logical write so selecting it yields the exact value.
 *
 * The initial QR block is written exactly once. Foreground mode survives
 * terminal reflow and therefore needs no application-side resize handling.
 * Background and compact modes may append one QR later when an interactive
 * caller observes that the terminal has become wide enough.
 *
 * @param vm The created order to display.
 * @param columns Current terminal width.
 * @param canAppendOnResize Whether an interactive frame can append the QR when
 * the terminal becomes wide enough.
 * @returns Whether the QR code was drawn or the link fallback was shown instead.
 */
export function writeRechargePaymentBlock(
  vm: RechargePaymentViewModel,
  columns: number,
  canAppendOnResize = false,
): { readonly qrDrawn: boolean; readonly qrAppendable: boolean } {
  const label = (text: string) => text.padEnd(RECHARGE_LABEL_WIDTH);
  const qr = prepareStaticQr(vm.paymentUrl, columns, canAppendOnResize);

  writeSectionTitle('Alipay Recharge', columns);
  console.log(`${CONTENT_INDENT}Payment order created.`);
  console.log('');
  console.log(`${CONTENT_INDENT}${label('TYPE')}${vm.type}`);
  console.log(`${CONTENT_INDENT}${label('CHANNEL')}${vm.channel}`);
  console.log(`${CONTENT_INDENT}${label('AMOUNT')}${formatRechargeAmount(vm.amount, vm.currency)}`);
  console.log('');
  console.log(
    `${CONTENT_INDENT}If the QR code is not displayed or cannot be scanned, open this link on a mobile device with Alipay installed:`,
  );
  // One unprefixed logical write. The terminal may wrap it for display, but the
  // application never inserts, removes, or rewrites a byte of the exact value.
  console.log(chalk.cyan(vm.paymentUrl));
  console.log('');

  writeSectionTitle('Alipay QR Code', columns);
  if ('lines' in qr) {
    for (const line of qr.lines) console.log(line);
  } else {
    console.log(`${CONTENT_INDENT}${chalk.yellow(qr.unavailable)}`);
  }
  console.log('');
  return {
    qrDrawn: 'lines' in qr,
    qrAppendable: canAppendOnResize && 'unavailable' in qr && qr.retryOnResize,
  };
}

/**
 * Append the QR code after a previously narrow terminal becomes wide enough.
 *
 * This function only writes new rows. It never clears, rewinds, or repositions
 * existing terminal content, so the caller can safely invoke it from a resize
 * listener and stop after the first successful append.
 *
 * @param paymentUrl Validated payment link.
 * @param columns Current terminal width.
 * @returns Whether the QR was appended, remains too wide, or became unavailable.
 */
export function appendRechargeQrBlock(paymentUrl: string, columns: number): RechargeQrAppendResult {
  const qr = prepareStaticQr(paymentUrl, columns, true);
  if (!('lines' in qr)) return qr.retryOnResize ? 'width_insufficient' : 'unavailable';

  writeSectionTitle('Alipay QR Code', columns);
  for (const line of qr.lines) console.log(line);
  console.log('');
  return 'appended';
}

/**
 * Announce that polling has started, before the live frame mounts.
 *
 * The notice text never changes while polling, so it is static text like the
 * rest of the order. Keeping it out of the Ink frame lets that frame paint
 * nothing at all, which is what makes resizing safe.
 *
 * @param interactive Whether Ctrl+C can reach the waiting frame.
 */
export function writeRechargeWaitingNotice(interactive: boolean): void {
  for (const line of rechargeWaitingNoticeLines(interactive)) console.log(line);
}

/**
 * Build the waiting-notice rows shared by the initial static print and the
 * in-place repaint so the two can never drift. "Waiting for payment..." always;
 * the Ctrl+C hint only when Ctrl+C can reach the waiting frame.
 *
 * @param interactive Whether Ctrl+C can reach the waiting frame.
 * @returns The notice rows, top to bottom.
 */
function rechargeWaitingNoticeLines(interactive: boolean): string[] {
  const rows = [`${SECTION_INDENT}${chalk.yellow('Waiting for payment...')}`];
  if (interactive) {
    rows.push(`${SECTION_INDENT}${theme.muted('Press Ctrl+C to stop.')}`);
  }
  return rows;
}

/**
 * Write a settled payment outcome as static main-screen text.
 *
 * A settled result never changes again, so it leaves the live frame and becomes
 * ordinary text. This also keeps the dynamic frame down to a single line, which
 * is what prevents resize redraws from leaving residual rows behind.
 *
 * @param vm The settled result to display.
 * @param columns Current terminal width.
 */
export function writeRechargeResultBlock(vm: RechargeResultViewModel, columns: number): void {
  const label = (text: string) => text.padEnd(RECHARGE_LABEL_WIDTH);
  const display = buildRechargeResultDisplay(vm);
  const disposition =
    display.status === 'succeeded'
      ? 'success'
      : display.failureReason
        ? 'failure'
        : classifyRechargeStatus(vm.status);

  writeSectionTitle('Recharge Result', columns);
  if (disposition === 'success') {
    console.log(`${CONTENT_INDENT}${theme.success(`${theme.symbols.pass} Recharge completed.`)}`);
  } else if (disposition === 'failure') {
    console.log(
      `${CONTENT_INDENT}${theme.error(`${theme.symbols.fail} Recharge failed or timed out.`)}`,
    );
    console.log(
      `${CONTENT_INDENT}${chalk.yellow(`Before trying again, check your balance: ${formatCmd('billing balance summary')}`)}`,
    );
  } else {
    console.log(
      `${CONTENT_INDENT}${chalk.yellow(
        describeRechargeResult(
          vm.status,
          vm.reason,
          formatCmd('billing balance summary'),
          formatCmd('billing balance recharge-history'),
        ),
      )}`,
    );
  }
  console.log('');
  console.log(`${CONTENT_INDENT}${label('TYPE')}${vm.type}`);
  console.log(`${CONTENT_INDENT}${label('STATUS')}${display.status}`);
  if (display.failureReason) {
    console.log(`${CONTENT_INDENT}${label('FAILURE REASON')}${display.failureReason}`);
  }
  console.log('');
}

/**
 * Write a safe unknown state when the result request itself failed.
 *
 * The command keeps the original error and its exit code; this only records that
 * polling stopped without a confirmed outcome.
 *
 * @param columns Current terminal width.
 */
export function writeRechargeQueryFailureBlock(columns: number): void {
  const label = (text: string) => text.padEnd(RECHARGE_LABEL_WIDTH);
  writeSectionTitle('Recharge Result', columns);
  console.log(
    `${CONTENT_INDENT}${chalk.yellow('Payment result query stopped with an error. The recharge result is unknown; see the error below.')}`,
  );
  console.log('');
  console.log(`${CONTENT_INDENT}${label('TYPE')}recharge`);
  console.log(`${CONTENT_INDENT}${label('STATUS')}unknown`);
  console.log('');
}
