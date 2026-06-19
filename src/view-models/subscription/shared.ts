import { site } from '../../site.js';
import type { ViewContext } from '../billing/shared.js';

export const NA = '—';
export const CURRENCY_CODE = site.features.currency;
export const CURRENCY_SYMBOL =
  site.features.currency === 'USD'
    ? '$'
    : site.features.currency === 'CNY' || site.features.currency === 'JPY'
      ? '¥'
      : site.features.currency === 'EUR'
        ? '€'
        : site.features.currency === 'GBP'
          ? '£'
          : '';

export const STATUS_UNAVAILABLE_NOTE =
  'Subscription data unavailable — see --format json for diagnostics';

export const PARTIAL_FAILURE_NOTE_TEMPLATE = (n: number): string =>
  `Note: ${n} source(s) unavailable, see --format json for details`;

export const NARROW_TERMINAL_THRESHOLD = 80;

export function renderQuotaBar(used: number, total: number): { bar: string; percent: number } {
  if (total <= 0) return { bar: '·'.repeat(24), percent: 0 };
  const ratio = Math.min(1, Math.max(0, used / total));
  const percent = Math.round(ratio * 100);
  const filled = Math.round(ratio * 24);
  return { bar: '█'.repeat(filled).padEnd(24, '·'), percent };
}

export function renderQuotaBarFor(
  used: number,
  total: number,
  ctx: ViewContext | undefined,
): { bar: string; percent: number } {
  const cols = typeof ctx?.columns === 'number' ? ctx.columns : 100;
  if (cols < NARROW_TERMINAL_THRESHOLD) {
    if (total <= 0) return { bar: '[0.00%]', percent: 0 };
    const ratio = Math.min(1, Math.max(0, used / total));
    const pct = (ratio * 100).toFixed(2);
    return { bar: `[${pct}%]`, percent: Math.round(ratio * 100) };
  }
  return renderQuotaBar(used, total);
}

/** Boolean → "Yes" / "No" / em-dash. */
export function formatBool(value: boolean | null): string {
  if (value === null) return NA;
  return value ? 'Yes' : 'No';
}

/** Period → "start → end" / em-dash. */
export function formatPeriod(start: string, end: string): string {
  if (!start && !end) return NA;
  return `${start || NA} → ${end || NA}`;
}

export type { ViewContext } from '../billing/shared.js';
