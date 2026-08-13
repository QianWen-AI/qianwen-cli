import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Table } from '../../src/ui/Table.js';
import { visibleWidth } from '../../src/ui/textWrap.js';

// ── Black-box tests for column-width logic ──────────────────────────
//
// `Table.tsx` keeps `colWidths` calculation inline (not exported), so we
// verify the behaviour by rendering the real component and inspecting
// the resulting frame. Layout invariants we assert:
//   line 0 = header row
//   line 1 = ─┼─ separator
//   line 2 = first data row
//
// All assertions strip ANSI before measuring lengths/positions.

function renderRow(props: React.ComponentProps<typeof Table>): string {
  const out = stripAnsi(render(<Table {...props} />).lastFrame() ?? '');
  return out.split('\n')[2] ?? '';
}

function renderHeaderRow(props: React.ComponentProps<typeof Table>): string {
  // Header row carries the full padded width (it's a single Text with bg color
  // and trailing space). Use it to reliably infer column widths.
  const out = stripAnsi(render(<Table {...props} />).lastFrame() ?? '');
  return out.split('\n')[0] ?? '';
}

describe('Table column width logic (verified via real render)', () => {
  it('expands column to fit longest data value', () => {
    const row = renderRow({
      columns: [
        { key: 'name', header: 'N' },
        { key: 'val', header: 'V' },
      ],
      data: [{ name: 'qwen3.6-plus', val: '999' }],
    });
    // 'qwen3.6-plus' is 12 chars; column should be at least that wide
    expect(row).toContain('qwen3.6-plus');
    // The val column appears after the divider
    expect(row).toContain('999');
    // 'qwen3.6-plus' must come before '999' (column order preserved)
    expect(row.indexOf('qwen3.6-plus')).toBeLessThan(row.indexOf('999'));
  });

  it('respects minWidth — multi-column gap reflects minWidth padding', () => {
    // Render a 2-column table where col1 has minWidth=10 but tiny content.
    // The horizontal distance between header 'X' and header 'Y' must reflect
    // the minWidth-padded col1 width, not just the natural content width.
    const header = renderHeaderRow({
      columns: [
        { key: 'x', header: 'X', minWidth: 10 },
        { key: 'y', header: 'Y' },
      ],
      data: [{ x: 'a', y: 'b' }],
    });
    const xIdx = header.indexOf('X');
    const yIdx = header.indexOf('Y');
    expect(xIdx).toBeGreaterThanOrEqual(0);
    expect(yIdx).toBeGreaterThan(xIdx);
    // Distance between headers must be >= minWidth(10). If minWidth was
    // ignored, col1 would size to 1 (just 'X') and gap would be ~4.
    expect(yIdx - xIdx).toBeGreaterThanOrEqual(10);
  });

  it('respects maxWidth — header column does not exceed cap', () => {
    // Long DATA value (100 X's) but maxWidth=20 → column visible width capped at 20.
    // Use header row to verify (it gets padded to the resolved column width).
    const longTxt = 'X'.repeat(100);
    const header = renderHeaderRow({
      columns: [{ key: 'd', header: 'D', maxWidth: 20 }],
      data: [{ d: longTxt }],
    });
    // Header row visible length (excluding leading padding) should be ~20, NOT 100.
    const trimmed = header.replace(/^\s+/, '').trimEnd();
    // Header 'D' is 1 char; padded up to colWidth which is capped at maxWidth=20.
    // Allow small tolerance (background-color trailing space etc.)
    expect(trimmed.length).toBeLessThanOrEqual(25);
  });

  it('respects fixed width override (col.width) — verified via header row positions', () => {
    const header = renderHeaderRow({
      columns: [
        { key: 'a', header: 'A', width: 8 },
        { key: 'b', header: 'B', width: 8 },
      ],
      data: [{ a: 'a', b: 'b' }],
    });
    // Headers 'A' and 'B' must be at least 8 chars apart due to width=8 padding
    const aIdx = header.indexOf('A');
    const bIdx = header.indexOf('B');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    // gap = width(8) + ' │ '(3) = 11 chars between 'A' and 'B'
    expect(bIdx - aIdx).toBeGreaterThanOrEqual(8);
  });

  it('strips ANSI codes when measuring cell width — header padding reflects visible len', () => {
    // Value with embedded ANSI escapes: 13 raw chars but 3 visible chars.
    const ansiVal = '\x1b[32mabc\x1b[0m';
    const header = renderHeaderRow({
      columns: [
        { key: 'k', header: 'K' },
        { key: 'next', header: 'Next' },
      ],
      data: [{ k: ansiVal, next: 'tail' }],
    });
    // 'abc' is 3 visible chars; with header 'K' (1 char), column is sized to 3.
    // The 'Next' header should appear close to position 3 + ' │ '(3) + leading pad.
    // If visibleWidth was buggy and counted raw 13 chars, 'Next' would shift far right.
    const nextIdx = header.indexOf('Next');
    expect(nextIdx).toBeGreaterThan(0);
    // Loose upper bound: paddingLeft(2) + colK(3) + sep(3) + small slack
    expect(nextIdx).toBeLessThan(15);
  });

  it('header column also widens to fit data when data > header', () => {
    const row = renderRow({
      columns: [{ key: 'x', header: 'X' }], // header is 1 char
      data: [{ x: 'much-longer-data' }],
    });
    expect(row).toContain('much-longer-data');
  });
});

describe('Table maxTotalWidth 宽度收缩（交互渲染防物理换行）', () => {
  function renderFrame(props: React.ComponentProps<typeof Table>): string {
    return stripAnsi(render(<Table {...props} />).lastFrame() ?? '');
  }

  it('收缩超宽列使每行显示宽度 ≤ maxTotalWidth', () => {
    const out = renderFrame({
      columns: [
        { key: 'name', header: 'Name' },
        { key: 'desc', header: 'Desc' },
      ],
      data: [{ name: 'n1', desc: 'x'.repeat(80) }],
      maxTotalWidth: 40,
    });
    for (const line of out.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    // Overwide cell is truncated with an ellipsis rather than wrapped.
    expect(out).toContain('…');
  });

  it('CJK 内容按显示宽度（2 列）截断，不超出约束', () => {
    const out = renderFrame({
      columns: [
        { key: 'a', header: 'A' },
        { key: 'b', header: 'B' },
      ],
      data: [{ a: '通义千问模型名称非常非常非常长', b: '中文描述也很长很长很长很长' }],
      maxTotalWidth: 30,
    });
    for (const line of out.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
    expect(out).toContain('…');
  });

  it('窄列保持不收缩：只有最宽列被截断', () => {
    const out = renderFrame({
      columns: [
        { key: 'idx', header: '#' },
        { key: 'flag', header: 'OK' },
        { key: 'text', header: 'Text' },
      ],
      data: [{ idx: '1', flag: 'yes', text: 'a-very-long-text-value-that-overflows' }],
      maxTotalWidth: 30,
    });
    // Narrow columns keep their full content; the wide column absorbs shrinking.
    expect(out).toContain('1');
    expect(out).toContain('yes');
    expect(out).toContain('…');
    for (const line of out.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it('收缩不低于最小列宽：约束过小时列宽触底而非归零', () => {
    const out = renderFrame({
      columns: [
        { key: 'a', header: 'AAAA' },
        { key: 'b', header: 'BBBB' },
      ],
      data: [{ a: 'x'.repeat(30), b: 'y'.repeat(30) }],
      maxTotalWidth: 8, // impossible — both columns floor at the minimum width
    });
    // Every cell keeps a readable stub (≥ a few chars + ellipsis) — nothing collapses to 0.
    const dataRow = out.split('\n')[2] ?? '';
    expect(dataRow).toContain('x');
    expect(dataRow).toContain('y');
  });

  it('不传 maxTotalWidth 时行为与现状完全一致（零回归）', () => {
    const props = {
      columns: [
        { key: 'name', header: 'Name' },
        { key: 'desc', header: 'Desc' },
      ],
      data: [{ name: 'n1', desc: 'z'.repeat(60) }],
    };
    const unconstrained = renderFrame(props);
    // Long value is fully present, no ellipsis introduced.
    expect(unconstrained).toContain('z'.repeat(60));
    expect(unconstrained).not.toContain('…');
  });
});
