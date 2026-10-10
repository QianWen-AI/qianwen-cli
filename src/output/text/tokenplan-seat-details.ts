import type { TokenPlanSeatDetailsViewModel } from '../../types/tokenplan-subscription.js';
import { visibleWidth } from '../../ui/textWrap.js';
import { formatTextTable } from '../format.js';

export function formatTokenPlanSeatDetails(
  details: TokenPlanSeatDetailsViewModel,
  width = Infinity,
): string {
  const table = formatTextTable(details.headers, details.rows, 0);
  const fits = table.split('\n').every((line) => visibleWidth(line) <= width);
  // Long IDs and large quotas stay intact on narrow terminals.
  const body = fits
    ? table
    : details.rows
        .map((row) => details.headers.map((header, i) => `${header}: ${row[i]}`).join('\n'))
        .join('\n\n');
  const rows = details.rows.length ? [body] : [];
  return (details.noteAfterRows ? [...rows, details.note] : [details.note, ...rows])
    .filter(Boolean)
    .join('\n');
}
