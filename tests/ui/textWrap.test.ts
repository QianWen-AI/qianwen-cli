import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  visibleWidth,
  wrapText,
  wrapTextWithIndent,
  padEndVisible,
  padStartVisible,
  isCJKCodePoint,
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
