import chalk from 'chalk';

/** Terminal QR layout selected for the current stdout environment. */
export type QrRenderMode = 'compact' | 'full' | 'foreground' | 'off';

function hasValue(value: string | undefined): boolean {
  return value != null && value.length > 0;
}

/**
 * Terminals positively identified as rendering the U+2580 half-block precisely.
 *
 * Only `TERM_PROGRAM` values qualify. That variable names the terminal itself
 * and every modern host sets its own value, so an inherited one still describes
 * the attached session. `VTE_VERSION`, `KONSOLE_VERSION` and `KITTY_WINDOW_ID`
 * are deliberately excluded: they record a library version or window id that no
 * other terminal clears, so an inherited value only proves such a terminal
 * appeared somewhere in the process chain — not that it is attached now. Half
 * blocks guessed wrong produce an unscannable code, so anything unconfirmed
 * falls back to the glyph-free full-cell layout.
 */
const HALF_BLOCK_TERM_PROGRAMS = new Set(['Apple_Terminal', 'iTerm.app', 'WezTerm']);

/**
 * Returns true when running inside Windows legacy ConHost (not Windows Terminal).
 *
 * ConHost auto-wraps a line the instant it fills the final column rather than
 * deferring the wrap, so callers that must keep physical rows aligned with
 * logical ones need to reserve the last column.
 */
export function isConHost(): boolean {
  return process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM_PROGRAM;
}

/**
 * Select the safest QR rendering mode supported by the current stdout terminal.
 *
 * Capability gate first, and it cannot be bypassed by the override:
 *
 * - `hasColors(16)` rather than `hasColors(2)`. Black and white are entries in
 *   the standard 16-colour palette, and `getColorDepth()` bottoms out at 1,
 *   which makes `hasColors(2)` true for every TTY — it would wave through a
 *   monochrome terminal that cannot tell `CSI 40m` from `CSI 47m`, painting the
 *   code as one flat block.
 * - `chalk.level` must be non-zero. The gate has to describe the pipeline that
 *   actually paints: chalk decides colour from `supports-color` (`FORCE_COLOR`,
 *   `NO_COLOR`) while `hasColors` reads `getColorDepth()`, and at level 0 chalk
 *   returns the raw string, so the QR would silently degrade into a block of
 *   plain spaces or bare half-blocks with no hint that anything was lost.
 *
 * Layout selection is then conservative: the compact half-block layout is used
 * only for positively identified terminals. Windows hosts use explicit black
 * and standard-white foreground blocks because Windows Terminal drops the
 * background-colour SGR of blank cells when it reflows on resize, blanking a
 * background-painted code; a foreground-only code survives the reflow and
 * merely rewraps. Every other multiplexer and unrecognised terminal uses the
 * full-cell layout, which paints plain spaces on coloured backgrounds and so
 * depends on no glyph at all.
 *
 * @returns The compact, full-size, foreground, or disabled QR rendering mode.
 */
export function resolveQrRenderMode(): QrRenderMode {
  if (
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    process.stdout.hasColors?.(16) !== true ||
    chalk.level < 1 ||
    process.env.QIANWEN_QR_STYLE === 'off'
  ) {
    return 'off';
  }

  const configuredMode = process.env.QIANWEN_QR_STYLE;
  if (configuredMode === 'compact' || configuredMode === 'full') {
    return configuredMode;
  }

  if (process.platform === 'win32' || process.env.WT_SESSION) {
    return 'foreground';
  }

  const term = process.env.TERM?.toLowerCase() ?? '';
  if (hasValue(process.env.TMUX) || term.startsWith('screen') || term.startsWith('tmux')) {
    return 'full';
  }

  if (HALF_BLOCK_TERM_PROGRAMS.has(process.env.TERM_PROGRAM ?? '')) {
    return 'compact';
  }

  return 'full';
}
