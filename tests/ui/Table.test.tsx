import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Table } from '../../src/ui/Table.js';

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
