import { site } from '../../site.js';
import { formatAmount } from '../../output/humanize.js';

export const NA = '—';

export const CURRENCY_CODE = site.features.currency;

export interface ViewContext {
  currency: string;
  locale: string;
  dateFormat: string;
  /** Terminal columns; builders may degrade on narrow widths. */
  columns?: number;
}

export const NARROW_TERMINAL_THRESHOLD = 60;

function currencySymbolFor(code: string): string {
  switch (code) {
    case 'USD':
      return '$';
    case 'CNY':
    case 'JPY':
      return '¥';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    default:
      return '';
  }
}

/** Format an amount for display. */
export function formatMoney(amount: number | string | null | undefined, ctx: ViewContext): string {
  if (amount == null) return NA;
  const trimmed = typeof amount === 'string' ? amount.trim() : String(amount);
  if (trimmed.length === 0) return NA;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return NA;
  const sym = currencySymbolFor(ctx.currency);
  const formatted = formatAmount(n);
  return sym.length > 0 ? `${sym}${formatted}` : `${formatted} ${ctx.currency}`;
}

/** Format an integer count. */
export function formatCount(value: number | null | undefined): string {
  if (value == null) return NA;
  if (!Number.isFinite(value)) return NA;
  return value.toLocaleString('en-US');
}

/** Format an ISO date / datetime string per ctx.dateFormat ('iso' | 'short'). */
export function formatDate(date: string | null | undefined, ctx: ViewContext): string {
  if (!date) return NA;
  const raw = String(date).trim();
  if (raw.length === 0) return NA;
  // Already YYYY-MM-DD or YYYY-MM — pass through.
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (ctx.dateFormat === 'short') return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/** Build a default ViewContext from the active site. */
export function defaultViewContext(): ViewContext {
  return {
    currency: CURRENCY_CODE,
    locale: 'zh-CN',
    dateFormat: 'iso',
    columns: typeof process.stdout?.columns === 'number' ? process.stdout.columns : 100,
  };
}
