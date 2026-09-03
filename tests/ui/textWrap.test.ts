import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  visibleWidth,
  wrapText,
  wrapTextWithIndent,
  padEndVisible,
  padStartVisible,
  isCJKCodePoint,
  truncateByDisplayWidth,
} from '../../src/ui/textWrap.js';

describe('stripAnsi', () => {
  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('removes bold codes', () => {
    expect(stripAnsi('\x1b[1mBold\x1b[0m')).toBe('Bold');
  });

  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mRed\x1b[0m')).toBe('Red');
  });

  it('removes multiple codes in sequence', () => {
    expect(stripAnsi('\x1b[1m\x1b[32mGreen Bold\x1b[0m')).toBe('Green Bold');
  });
});

describe('visibleWidth', () => {
  it('returns length of plain text', () => {
    expect(visibleWidth('hello')).toBe(5);
  });

  it('excludes ANSI codes from width', () => {
    expect(visibleWidth('\x1b[1mhello\x1b[0m')).toBe(5);
  });

  it('counts CJK characters as width 2', () => {
    // Two CJK characters, each width 2, have a total display width of 4.
    expect(visibleWidth('\u4e2d\u6587')).toBe(4);
  });

  it('handles mixed CJK and ASCII', () => {
    // Five ASCII characters plus two CJK characters have a display width of 9.
    expect(visibleWidth('Hello\u4e16\u754c')).toBe(9);
  });

  it('counts fullwidth forms as width 2', () => {
    // Fullwidth exclamation mark U+FF01
    expect(visibleWidth('\uff01')).toBe(2);
  });

  it('counts emoji-presentation symbols as width 2', () => {
    // BMP emoji with Emoji_Presentation property: renders as 2 columns
    expect(visibleWidth('❌')).toBe(2); // U+274C
    expect(visibleWidth('☕')).toBe(2); // U+2615
    // Text-presentation symbols (no Emoji_Presentation): width 1
    expect(visibleWidth('✔')).toBe(1); // U+2714
    expect(visibleWidth('✖')).toBe(1); // U+2716
    // Text symbol + VS16: still width 1 in xterm.js (no emoji glyph in Menlo)
    expect(visibleWidth('\u2716\uFE0F')).toBe(1); // ✖️ U+2716+FE0F
  });

  it('counts classic SMP emoji as width 2', () => {
    // U+1F300–1F64F, U+1F680–1F6FF: terminal renders as 2 columns
    expect(visibleWidth('💻')).toBe(2); // U+1F4BB
    expect(visibleWidth('🍔')).toBe(2); // U+1F354
    expect(visibleWidth('🚀')).toBe(2); // U+1F680
    expect(visibleWidth('😀')).toBe(2); // U+1F600
  });

  it('counts newer SMP emoji (U+1F900+) as width 2', () => {
    // All Emoji_Presentation chars render as 2 columns in modern terminals
    expect(visibleWidth('🧑')).toBe(2); // U+1F9D1
    expect(visibleWidth('🤖')).toBe(2); // U+1F916
    expect(visibleWidth('🦊')).toBe(2); // U+1F98A
  });

  it('counts ZWJ sequences by component emoji width (xterm.js decomposes)', () => {
    // 🧑‍💻 = U+1F9D1 ZWJ U+1F4BB — xterm.js renders as 2 separate glyphs: 2+2=4
    expect(visibleWidth('🧑\u200D💻')).toBe(4);
    // 👨‍👩‍👧‍👦 = family ZWJ — 4 emoji components: 2×4=8
    expect(visibleWidth('👨\u200D👩\u200D👧\u200D👦')).toBe(8);
  });

  it('counts middle dot (U+00B7) as width 1 (xterm.js primary target)', () => {
    expect(visibleWidth('\u00b7')).toBe(1);
    // Four letters, a space, a middle dot, a space, and four letters total 11 columns.
    expect(visibleWidth('Role \u00b7 Name')).toBe(11);
  });

  it('counts keycap sequences as width 1 (xterm.js renders text-style)', () => {
    // 2️⃣ = 0032 + FE0F + 20E3 — keycap sequence renders as 1 col in xterm.js
    expect(visibleWidth('2\uFE0F\u20E3')).toBe(1);
  });

  it('counts flag emoji as width 2', () => {
    // 🇨🇳 = U+1F1E8 + U+1F1F3 — regional indicator pair
    expect(visibleWidth('🇨🇳')).toBe(2);
  });

  it('handles mixed content with emoji correctly', () => {
    // Three ASCII columns, two emoji pairs, and one CJK character total 9 columns.
    expect(visibleWidth('abc❌💻\u4e2d')).toBe(9);
  });
});

describe('truncateByDisplayWidth', () => {
  it('returns the original string when it fits the budget', () => {
    expect(truncateByDisplayWidth('hello', 10)).toBe('hello');
  });

  it('truncates ASCII strings and appends an ellipsis', () => {
    expect(truncateByDisplayWidth('abcdefghij', 6)).toBe('abcde…');
  });

  it('truncates CJK strings by display width, not by code-unit length', () => {
    // 6 CJK chars = 12 columns; budget 8 leaves room for 3 chars + ellipsis (1).
    expect(truncateByDisplayWidth('\u4e00\u4e8c\u4e09\u56db\u4e94\u516d', 8)).toBe(
      '\u4e00\u4e8c\u4e09…',
    );
  });

  it('preserves emoji surrogate pairs intact when truncating', () => {
    // Classic SMP emoji (U+1F600–U+1F603) each have visibleWidth=2.
    // Budget: maxWidth=5, ellipsis=1 col → body budget=4 → fits 2 emoji (4 cols).
    const input = '😀😁😂😃';
    const out = truncateByDisplayWidth(input, 5);
    expect(out).toBe('😀😁…');
  });

  it('returns the input untouched when maxWidth is non-positive', () => {
    expect(truncateByDisplayWidth('abc', 0)).toBe('abc');
  });

  it('preserves ANSI SGR sequences as zero-width atoms and resets styles after truncation', () => {
    const output = truncateByDisplayWidth('\x1b[31mabcdefgh\x1b[0m', 6);
    expect(output).toBe('\x1b[31mabcde…\x1b[0m');
    expect(visibleWidth(output)).toBe(6);
  });

  it('does not truncate inside consecutive ANSI style sequences', () => {
    const output = truncateByDisplayWidth('\x1b[1m\x1b[32m\u4e2d\u6587abcd\x1b[0m', 6);
    expect(output).toBe('\x1b[1m\x1b[32m\u4e2d\u6587a…\x1b[0m');
    expect(stripAnsi(output)).toBe('\u4e2d\u6587a…');
    expect(visibleWidth(output)).toBe(6);
  });
});

describe('wrapText', () => {
  it('returns single line when text fits', () => {
    expect(wrapText('short', 20)).toEqual(['short']);
  });

  it('wraps long text at word boundaries', () => {
    const result = wrapText('hello world foo bar', 12);
    expect(result).toEqual(['hello world', 'foo bar']);
  });

  it('force-breaks words exceeding width', () => {
    const result = wrapText('superlongword short', 10);
    // After force-breaking 'superlongword' -> 'superlongw' + 'ord',
    // 'ord' and 'short' fit together on one line (9 chars <= 10)
    expect(result).toEqual(['superlongw', 'ord short']);
  });

  it('handles empty string', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });

  it('handles zero maxWidth', () => {
    expect(wrapText('text', 0)).toEqual(['text']);
  });

  it('preserves existing newlines', () => {
    const result = wrapText('line1\nline2', 20);
    expect(result).toEqual(['line1', 'line2']);
  });

  it('wraps each existing newline independently', () => {
    const result = wrapText('first part of sentence\nsecond part', 15);
    expect(result).toEqual(['first part of', 'sentence', 'second part']);
  });

  it('handles ANSI-stripped width measurement', () => {
    const result = wrapText('\x1b[1mhello world foo bar\x1b[0m', 12);
    expect(result).toEqual(['hello world', 'foo bar']);
  });

  // ── CJK-specific tests ──────────────────────────────────────────────────

  it('wraps Chinese text by breaking at character boundaries', () => {
    // 6 CJK chars × 2 = 12 display cols, maxWidth=8 → must break
    const result = wrapText('\u8fd9\u662f\u4e00\u6bb5\u4e2d\u6587\u63cf\u8ff0', 8);
    // Each group of four CJK characters occupies 8 columns.
    expect(result).toEqual(['\u8fd9\u662f\u4e00\u6bb5', '\u4e2d\u6587\u63cf\u8ff0']);
  });

  it('wraps long Chinese text that exceeds line width', () => {
    const text =
      'qianwen-cjk-test \u662f\u5343\u95eeAI\u5e73\u53f0\u6d4b\u8bd5\u7528\u4f8b\u6570\u636e\uff0c\u4ec5\u4f9b\u9a8c\u8bc1 CJK \u6392\u7248\uff0c\u65e0\u5b9e\u9645\u4e1a\u52a1\u542b\u4e49';
    const result = wrapText(text, 20);
    // Every line must fit within 20 display columns
    for (const line of result) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it('handles mixed CJK and English text', () => {
    // Five ASCII columns plus two CJK characters occupy 9 columns.
    const result = wrapText('Hello \u4e16\u754c Test', 10);
    expect(result).toEqual(['Hello \u4e16\u754c', 'Test']);
  });

  it('CJK force-break never splits a character', () => {
    // 5 CJK chars = 10 cols, maxWidth=6 → must break at char boundary (4+2)
    const result = wrapText('\u4e00\u4e8c\u4e09\u56db\u4e94', 6);
    expect(result).toEqual(['\u4e00\u4e8c\u4e09', '\u56db\u4e94']);
    // Verify each line's display width
    expect(visibleWidth(result[0]!)).toBe(6);
    expect(visibleWidth(result[1]!)).toBe(4);
  });

  it('wraps Chinese text with spaces at word boundaries first', () => {
    const result = wrapText('\u4f60\u597d \u4e16\u754c \u6d4b\u8bd5', 6);
    // Two CJK words of width 4 cannot fit on one line at this width.
    expect(result).toEqual(['\u4f60\u597d', '\u4e16\u754c', '\u6d4b\u8bd5']);
  });
});

describe('wrapTextWithIndent', () => {
  it('returns unchanged single line', () => {
    expect(wrapTextWithIndent('short', 20)).toEqual(['short']);
  });

  it('indents continuation lines', () => {
    const result = wrapTextWithIndent('hello world foo bar', 12, '  ');
    expect(result).toEqual(['hello world', '  foo bar']);
  });

  it('uses default indent of empty string (left-aligned)', () => {
    const result = wrapTextWithIndent('hello world foo bar', 12);
    expect(result).toEqual(['hello world', 'foo bar']);
  });

  it('indents continuation lines when indent specified', () => {
    const result = wrapTextWithIndent('hello world foo bar', 12, '  ');
    expect(result).toEqual(['hello world', '  foo bar']);
  });
});

// ── CJK padding utilities ─────────────────────────────────────────────────────

describe('padEndVisible', () => {
  it('pads ASCII text like regular padEnd', () => {
    expect(padEndVisible('hi', 5)).toBe('hi   ');
  });

  it('pads CJK text to the correct display width', () => {
    // Two CJK characters occupy 4 columns, so padding to 8 needs four spaces.
    expect(padEndVisible('\u4e2d\u6587', 8)).toBe('\u4e2d\u6587    ');
  });

  it('does not add padding when already at target width', () => {
    expect(padEndVisible('\u4e2d\u6587', 4)).toBe('\u4e2d\u6587');
  });

  it('does not truncate when exceeding target width', () => {
    expect(padEndVisible('\u4e2d\u6587\u6d4b\u8bd5', 4)).toBe('\u4e2d\u6587\u6d4b\u8bd5');
  });

  it('handles mixed CJK and ASCII', () => {
    // Five ASCII columns plus two CJK characters occupy 9 columns.
    expect(padEndVisible('Hello\u4e16\u754c', 12)).toBe('Hello\u4e16\u754c   ');
  });
});

describe('padStartVisible', () => {
  it('left-pads ASCII text', () => {
    expect(padStartVisible('hi', 5)).toBe('   hi');
  });

  it('left-pads CJK text to correct display width', () => {
    // Two CJK characters occupy 4 columns, so padding to 8 needs four spaces.
    expect(padStartVisible('\u4e2d\u6587', 8)).toBe('    \u4e2d\u6587');
  });
});

describe('isCJKCodePoint', () => {
  it('identifies CJK Unified Ideographs', () => {
    expect(isCJKCodePoint(0x4e00)).toBe(true); // First CJK Unified Ideograph
    expect(isCJKCodePoint(0x9fff)).toBe(true); // CJK Unified
  });

  it('identifies ASCII as non-CJK', () => {
    expect(isCJKCodePoint(0x41)).toBe(false); // 'A'
    expect(isCJKCodePoint(0x7a)).toBe(false); // 'z'
  });

  it('identifies Hangul as CJK', () => {
    expect(isCJKCodePoint(0xac00)).toBe(true); // 가
  });
});
