/**
 * ANSI-aware text wrapping utilities for terminal UI components.
 *
 * These functions correctly handle ANSI escape codes (colors, bold, etc.)
 * and CJK / emoji / ZWJ sequences when measuring string width and wrapping
 * text to fit within a given width.
 */

/**
 * ANSI escape code regex pattern.
 * Matches all CSI (Control Sequence Introducer) sequences.
 */
// eslint-disable-next-line no-control-regex -- ANSI escape codes intentionally use \x1b
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Grapheme cluster segmenter (single shared instance).
 * Used to iterate strings at user-perceived character boundaries so that
 * ZWJ sequences, keycaps, variation selectors and surrogate pairs stay
 * intact when measuring or splitting text.
 */
const segmenter = new Intl.Segmenter();

/**
 * Detects whether a grapheme cluster contains a default-presentation emoji.
 * Only matches characters with the Emoji_Presentation property — those that
 * terminals (xterm.js, Terminal.app) reliably render as 2 terminal columns.
 *
 * Text-presentation characters with an explicit VS16 (U+FE0F), such as
 * ✖️ (U+2716+FE0F) and keycap sequences (2️⃣), are NOT matched because
 * xterm.js renders them as 1 column with the Menlo/monospace fallback font.
 */
const EMOJI_RE = /\p{Emoji_Presentation}/u;

/**
 * Strip ANSI escape codes from a string, returning only visible characters.
 * Non-string inputs are coerced to string defensively so a misbehaving upstream
 * (e.g. numeric timestamp leaked into a string-typed field) cannot crash the
 * entire render pipeline with `e.replace is not a function`.
 */
export function stripAnsi(str: string): string {
  if (typeof str !== 'string') {
    return str == null ? '' : String(str);
  }
  return str.replace(ANSI_REGEX, '');
}

/**
 * Check whether a Unicode code point is a CJK fullwidth character
 * (occupies 2 terminal columns).
 *
 * Retained as an exported helper for callers that need to make per-codepoint
 * decisions outside the grapheme-aware {@link visibleWidth} pathway.
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
 * Iterates by grapheme cluster so emoji ZWJ/keycap sequences and
 * variation selectors collapse to their rendered width. Recognises
 * CJK and fullwidth ranges as width 2, zero-width and combining marks
 * as width 0, and everything else as width 1.
 */
export function visibleWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const { segment } of segmenter.segment(plain)) {
    const code = segment.codePointAt(0) ?? 0;

    // Zero-width characters
    if (code >= 0x200b && code <= 0x200f) continue; // ZWS, ZWNJ, ZWJ, LRM, RLM
    if (code === 0xfeff) continue; // BOM / ZWNBSP
    if (code >= 0xfe00 && code <= 0xfe0f) continue; // Variation Selectors

    // Combining diacritical marks
    if (code >= 0x0300 && code <= 0x036f) continue;
    if (code >= 0x1ab0 && code <= 0x1aff) continue;
    if (code >= 0x1dc0 && code <= 0x1dff) continue;
    if (code >= 0x20d0 && code <= 0x20ff) continue;
    if (code >= 0xfe20 && code <= 0xfe2f) continue;

    // Control characters (excluding tab/newline/CR which callers handle elsewhere)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;

    // ZWJ sequences — xterm.js with Menlo decomposes these into individual glyphs.
    // Each Emoji_Presentation component renders independently as 2 columns.
    if (segment.includes('\u200D') && EMOJI_RE.test(segment)) {
      let zwjWidth = 0;
      for (const char of segment) {
        const cp = char.codePointAt(0) ?? 0;
        if (cp === 0x200d) continue;
        if (cp >= 0xfe00 && cp <= 0xfe0f) continue;
        if (/\p{Emoji_Presentation}/u.test(char)) {
          zwjWidth += 2;
        }
      }
      width += zwjWidth;
      continue;
    }

    // Emoji (default-presentation). All Emoji_Presentation graphemes render
    // as 2 terminal columns in modern terminals (xterm.js, Terminal.app,
    // iTerm2). Detected at the grapheme-cluster level so flag sequences and
    // similar composites collapse to one glyph.
    if (EMOJI_RE.test(segment)) {
      width += 2;
      continue;
    }

    // CJK and fullwidth character ranges — each occupies 2 terminal columns
    if (isCJKCodePoint(code)) {
      width += 2;
      continue;
    }

    width += 1;
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
 * Truncate a string so its visible width does not exceed `maxWidth`.
 * Iterates by grapheme cluster so emoji ZWJ sequences and combining
 * marks remain intact across the truncation boundary. When truncation
 * occurs, the trailing characters are replaced with `ellipsis`
 * (default U+2026), and the combined result still fits within
 * `maxWidth` columns.
 */
export function truncateByDisplayWidth(
  str: string,
  maxWidth: number,
  ellipsis: string = '\u2026',
): string {
  if (!str || maxWidth <= 0) return str;
  if (visibleWidth(str) <= maxWidth) return str;

  const ellipsisWidth = visibleWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);
  let acc = '';
  let used = 0;
  for (const { segment: ch } of segmenter.segment(str)) {
    const w = visibleWidth(ch);
    if (used + w > budget) break;
    acc += ch;
    used += w;
  }
  return acc + ellipsis;
}

/**
 * Break a string at display-width boundaries so that each resulting line
 * fits within `maxWidth` display columns.  Iterates by grapheme cluster
 * so surrogate pairs, ZWJ emoji and CJK characters never split mid-glyph.
 *
 * Retained for callers that need a width-based hard splitter independent of
 * word boundaries (the word-aware path lives in {@link wrapText}).
 */
function breakByDisplayWidth(str: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return str ? [str] : [];
  const lines: string[] = [];
  let chunk = '';
  let used = 0;

  for (const { segment } of segmenter.segment(str)) {
    const w = visibleWidth(segment);
    if (w === 0) {
      // Zero-width clusters (combining marks, VS, ZWJ-only) attach to the
      // previous cluster on the current line — never start a fresh line.
      chunk += segment;
      continue;
    }
    if (used + w > maxWidth && chunk.length > 0) {
      lines.push(chunk);
      chunk = '';
      used = 0;
    }
    chunk += segment;
    used += w;
  }

  if (chunk.length > 0) {
    lines.push(chunk);
  }

  return lines.length > 0 ? lines : [str];
}

/**
 * Wrap a string into multiple lines, each no wider than `maxWidth`.
 * Preserves ANSI escape codes and distributes them appropriately.
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

    // If line fits, keep as-is
    if (visibleWidth(rawLine) <= maxWidth) {
      lines.push(rawLine);
      continue;
    }

    // Word-aware wrapping: try to break at word boundaries.
    // Display width is used so CJK fullwidth chars (2 cols) and emoji are
    // measured correctly — falling back to .length would over-pack lines
    // that visibly overflow the target column count.
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

        // If single word exceeds width, force-break it by display width.
        // Iterating by grapheme cluster keeps emoji ZWJ sequences and CJK
        // characters intact across the chunk boundary.
        if (visibleWidth(word) > maxWidth) {
          const broken = breakByDisplayWidth(word, maxWidth);
          for (let i = 0; i < broken.length - 1; i++) {
            lines.push(broken[i]!);
          }
          currentLine = broken[broken.length - 1] ?? '';
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
