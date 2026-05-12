import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { theme } from './theme.js';
import { visibleWidth } from './textWrap.js';

export interface Column {
  key: string;
  header: string;
  align?: 'left' | 'right';
  color?: (value: string) => string;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
}

export interface TableProps {
  columns: Column[];
  data: Record<string, string>[];
  footer?: Record<string, string>;
  rowColor?: (row: Record<string, string>, index: number) => ((text: string) => string) | undefined;
  paddingLeft?: number;
}

/** Pad a pre-colored string to a fixed visual width. */
function padCell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const visualLen = visibleWidth(value);
  const padding = Math.max(0, width - visualLen);
  return align === 'right' ? ' '.repeat(padding) + value : value + ' '.repeat(padding);
}

// ─── Column divider style ─────────────────────────────────────────────────────
// Divider between cells: a dim purple │ with 1-space padding on each side.
// Using chalk directly (not Ink color prop) so it can be embedded in Text strings
// alongside per-cell colors without requiring nested Text elements.
const DIV = theme.border(' │ '); // data rows
const DIV_SEP = '─┼─'; // separator row (drawn in border color)

export function Table({ columns, data, footer, rowColor, paddingLeft = 2 }: TableProps) {
  // ── 1. Calculate fixed column widths ────────────────────────────────────────
  const colWidths = columns.map((col) => {
    const headerLen = col.header.length;
    const dataMax = data.reduce((max, row) => Math.max(max, visibleWidth(row[col.key] ?? '')), 0);
    const footerLen = footer ? visibleWidth(footer[col.key] ?? '') : 0;
    let w = Math.max(headerLen, dataMax, footerLen);
    if (col.minWidth != null) w = Math.max(w, col.minWidth);
    if (col.maxWidth != null) w = Math.min(w, col.maxWidth);
    if (col.width != null) w = col.width;
    return w;
  });

  // ── 2. Build reusable separator string ──────────────────────────────────────
  // Format: ─────────┼─────── (aligns with cell content + ` │ ` dividers)
  const separatorRaw = colWidths
    .map((w, i) => '─'.repeat(w) + (i < colWidths.length - 1 ? DIV_SEP : ''))
    .join('');
  const separator = theme.border(separatorRaw);

  // ── 3. Build header string (single string so bg color is continuous) ────────
  const headerContent = colWidths
    .map((w, i) => {
      const padded = padCell(columns[i].header, w, columns[i].align);
      return i < colWidths.length - 1 ? padded + ' │ ' : padded;
    })
    .join('');
  // Wrap with 1-space trailing padding so bg color extends past the last cell
  const headerStr = headerContent + ' ';

  // ── 4. Render a data / footer row ───────────────────────────────────────────
  const renderRow = (row: Record<string, string>, isFooter = false, rowIndex = 0) => {
    const rowColorFn = isFooter ? undefined : rowColor?.(row, rowIndex);

    return columns.map((col, i) => {
      const raw = row[col.key] ?? '';
      const padded = padCell(raw, colWidths[i], col.align);
      const div = i < columns.length - 1 ? DIV : '';

      let cell: string;
      if (isFooter) {
        cell = chalk.bold(padded);
      } else if (rowColorFn) {
        cell = rowColorFn(padded);
      } else if (col.color) {
        cell = col.color(padded);
      } else {
        cell = padded;
      }

      return (
        <Text key={col.key}>
          {cell}
          {div}
        </Text>
      );
    });
  };

  return (
    <Box flexDirection="column" paddingLeft={paddingLeft}>
      {/* ── Header row with bg color ── */}
      <Box>
        <Text bold color={theme.tableHeader.fg} backgroundColor={theme.tableHeader.bg}>
          {headerStr}
        </Text>
      </Box>

      {/* ── Separator (─┼─ pattern, brand dark purple) ── */}
      <Text>{separator}</Text>

      {/* ── Data rows ── */}
      {data.map((row, rowIndex) => (
        <Box key={rowIndex}>{renderRow(row, false, rowIndex)}</Box>
      ))}

      {/* ── Footer ── */}
      {footer && (
        <>
          <Text>{separator}</Text>
          <Box>{renderRow(footer, true)}</Box>
        </>
      )}
    </Box>
  );
}
