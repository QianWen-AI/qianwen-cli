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
    // '中文' = 2 characters, each width 2 → total display width 4
    expect(visibleWidth('中文')).toBe(4);
  });

  it('handles mixed CJK and ASCII', () => {
    // 'Hello世界' = 5 ASCII + 2 CJK(×2) = 5 + 4 = 9
    expect(visibleWidth('Hello世界')).toBe(9);
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
    expect(visibleWidth('·')).toBe(1);
    // "Role" = 4, " " = 1, "·" = 1, " " = 1, "Name" = 4, total = 11
    expect(visibleWidth('Role · Name')).toBe(11);
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
    // "abc" (3) + "❌" (2) + "💻" (2) + "中" (2) = 9
    expect(visibleWidth('abc❌💻中')).toBe(9);
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
    expect(truncateByDisplayWidth('一二三四五六', 8)).toBe('一二三…');
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
    const result = wrapText('这是一段中文描述', 8);
    // '这是一段' = 8 cols, '中文描述' = 8 cols
    expect(result).toEqual(['这是一段', '中文描述']);
  });

  it('wraps long Chinese text that exceeds line width', () => {
    const text = 'qianwen-cjk-test 是千问云测试用例数据，仅供验证 CJK 排版，无实际业务含义';
    const result = wrapText(text, 20);
    // Every line must fit within 20 display columns
    for (const line of result) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it('handles mixed CJK and English text', () => {
    // 'Hello' (5) + '世界' (4) = 9 cols
    const result = wrapText('Hello 世界 Test', 10);
    expect(result).toEqual(['Hello 世界', 'Test']);
  });

  it('CJK force-break never splits a character', () => {
    // 5 CJK chars = 10 cols, maxWidth=6 → must break at char boundary (4+2)
    const result = wrapText('一二三四五', 6);
    expect(result).toEqual(['一二三', '四五']);
    // Verify each line's display width
    expect(visibleWidth(result[0]!)).toBe(6);
    expect(visibleWidth(result[1]!)).toBe(4);
  });

  it('wraps Chinese text with spaces at word boundaries first', () => {
    const result = wrapText('你好 世界 测试', 6);
    // '你好' (4 cols), then '世界' (4 cols) — can't fit on one line
    expect(result).toEqual(['你好', '世界', '测试']);
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
    // '中文' = 4 display cols, pad to 8 → need 4 spaces
    expect(padEndVisible('中文', 8)).toBe('中文    ');
  });

  it('does not add padding when already at target width', () => {
    expect(padEndVisible('中文', 4)).toBe('中文');
  });

  it('does not truncate when exceeding target width', () => {
    expect(padEndVisible('中文测试', 4)).toBe('中文测试');
  });

  it('handles mixed CJK and ASCII', () => {
    // 'Hello世界' = 5 + 4 = 9 display cols, pad to 12 → 3 spaces
    expect(padEndVisible('Hello世界', 12)).toBe('Hello世界   ');
  });
});

describe('padStartVisible', () => {
  it('left-pads ASCII text', () => {
    expect(padStartVisible('hi', 5)).toBe('   hi');
  });

  it('left-pads CJK text to correct display width', () => {
    // '中文' = 4 display cols, pad to 8 → 4 spaces
    expect(padStartVisible('中文', 8)).toBe('    中文');
  });
});

describe('isCJKCodePoint', () => {
  it('identifies CJK Unified Ideographs', () => {
    expect(isCJKCodePoint(0x4e00)).toBe(true); // 一
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
