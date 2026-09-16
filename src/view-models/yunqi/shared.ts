import { truncateByDisplayWidth } from '../../ui/textWrap.js';

const EMPTY_CELL = '-';

/**
 * Cap a table cell to `maxWidth` terminal display columns (CJK = 2, ASCII = 1),
 * substituting a dash for absent values.
 *
 * Yunqi `Description` fields are whole paragraphs, and `formatTextTable` sizes
 * each column to its widest cell, so a single uncapped value pushes text-mode
 * rows past 1000 columns. `--format json` bypasses the view-model entirely and
 * still carries the complete strings.
 */
export function truncateCell(value: string | undefined, maxWidth: number): string {
  if (!value) return EMPTY_CELL;
  return truncateByDisplayWidth(value.replace(/[\r\n]+/g, ' '), maxWidth);
}
