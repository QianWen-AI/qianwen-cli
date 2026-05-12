/**
 * ANSI-aware text wrapping utilities for terminal UI components.
 *
 * These functions correctly handle ANSI escape codes (colors, bold, etc.)
 * and CJK fullwidth characters when measuring string width and wrapping
 * text to fit within a given width.
 */

/**
 * ANSI escape code regex pattern.
 * Matches all CSI (Control Sequence Introducer) sequences.
 */
// eslint-disable-next-line no-control-regex -- ANSI escape codes intentionally use \x1b
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Strip ANSI escape codes from a string, returning only visible characters.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

/**
 * Check whether a Unicode code point is a CJK fullwidth character
 * (occupies 2 terminal columns).
 */
export function isCJKCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals, Kangxi, CJK Symbols
    (code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, CJK Compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ext A
    (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified + Yi
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compat Forms
    (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
    (code >= 0x20000 && code <= 0x2fa1f)
  ); // CJK Unified Ext B–F, Compat Supplement
}

/**
 * Get the visible width of a string (excluding ANSI escape codes).
 * Correctly handles CJK fullwidth characters (width 2) and standard characters (width 1).
 */
export function visibleWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const char of plain) {
    const code = char.codePointAt(0) ?? 0;
    width += isCJKCodePoint(code) ? 2 : 1;
  }
  return width;
}

/**
 * Pad a string on the right to a target **visible width** (display columns).
 * Unlike `String.prototype.padEnd` which pads by character count, this
 * function accounts for CJK fullwidth characters (width 2) so borders
 * align correctly in the terminal.
 */
export function padEndVisible(str: string, targetWidth: number, padChar: string = ' '): string {
  const currentWidth = visibleWidth(str);
  const paddingNeeded = Math.max(0, targetWidth - currentWidth);
  return str + padChar.repeat(paddingNeeded);
}

/**
 * Pad a string on the left to a target **visible width** (display columns).
 * Useful for right-aligning columns that may contain CJK characters.
 */
export function padStartVisible(str: string, targetWidth: number, padChar: string = ' '): string {
  const currentWidth = visibleWidth(str);
  const paddingNeeded = Math.max(0, targetWidth - currentWidth);
  return padChar.repeat(paddingNeeded) + str;
}

/**
 * Break a string at display-width boundaries so that each resulting line
 * fits within `maxWidth` display columns.  Never splits a surrogate pair
 * or a CJK character mid-character.
 */
function breakByDisplayWidth(str: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  let lineWidth = 0;

  for (let i = 0; i < str.length; ) {
    const code = str.codePointAt(i)!;
    const charWidth = isCJKCodePoint(code) ? 2 : 1;

    if (lineWidth + charWidth > maxWidth && lineWidth > 0) {
      lines.push(str.slice(lineStart, i));
      lineStart = i;
      lineWidth = 0;
    }

    lineWidth += charWidth;
    // Advance by the number of UTF-16 code units for this code point
    i += code > 0xffff ? 2 : 1;
  }

  if (lineStart < str.length) {
    lines.push(str.slice(lineStart));
  }

  return lines.length > 0 ? lines : [str];
}

/**
 * Wrap a string into multiple lines, each no wider than `maxWidth`.
 * Preserves ANSI escape codes and distributes them appropriately.
 *
 * CJK-aware: uses `visibleWidth` (display columns) instead of
 * `.length` (character count) so that fullwidth characters (width 2)
 * are handled correctly.  Chinese text without spaces is force-broken
 * at character boundaries — breaking between any CJK characters is valid.
 *
 * For simplicity, this implementation strips ANSI codes during wrapping
 * and returns plain text chunks. The caller should re-apply styling
 * via Ink's `<Text>` component if needed.
 *
 * @param text - The text to wrap
 * @param maxWidth - Maximum visible width per line
 * @returns Array of wrapped lines
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return text ? [text] : [''];
  }

  const plainText = stripAnsi(text);
  const lines: string[] = [];

  // Split on existing newlines first
  const rawLines = plainText.split('\n');

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }

    // If line fits in display width, keep as-is
    if (visibleWidth(rawLine) <= maxWidth) {
      lines.push(rawLine);
      continue;
    }

    // Word-aware wrapping: try to break at word boundaries
    const words = rawLine.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      if (word.length === 0) continue;

      const candidate = currentLine ? `${currentLine} ${word}` : word;

      if (visibleWidth(candidate) <= maxWidth) {
        currentLine = candidate;
      } else {
        // Current line is full
        if (currentLine) {
          lines.push(currentLine);
        }

        // If single word exceeds display width, force-break at character boundaries
        if (visibleWidth(word) > maxWidth) {
          const broken = breakByDisplayWidth(word, maxWidth);
          lines.push(...broken.slice(0, -1));
          currentLine = broken[broken.length - 1]!;
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Wrap text with indentation on continuation lines.
 *
 * @param text - The text to wrap
 * @param maxWidth - Maximum visible width per line
 * @param indent - Indentation string for continuation lines (default: '').
 *                 When empty, all lines are left-aligned.
 * @returns Array of wrapped lines
 */
export function wrapTextWithIndent(text: string, maxWidth: number, indent: string = ''): string[] {
  const lines = wrapText(text, maxWidth);
  if (lines.length <= 1) return lines;

  const wrappedLines = [lines[0]!];

  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart();
    if (trimmed) {
      wrappedLines.push(`${indent}${trimmed}`);
    } else {
      wrappedLines.push(lines[i]!);
    }
  }

  return wrappedLines;
}
