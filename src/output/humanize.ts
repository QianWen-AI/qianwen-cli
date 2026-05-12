import { site } from '../site.js';

/** Currency symbol resolved from site config. */
const CUR = site.features.currency === 'CNY' ? '¥' : '$';

/**
 * Humanize a number for TTY display.
 * Rules from PRD §9.4:
 * - >= 1,000,000 → X.XM (1 decimal, drop .0)
 * - >= 1,000 → X.XK (1 decimal, drop .0)
 * - < 1,000 → raw number
 *
 * JSON output should NEVER use this function - always output raw numbers.
 */
export function humanizeNumber(n: number): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    return val % 1 === 0 ? `${val}M` : `${parseFloat(val.toFixed(1))}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    return val % 1 === 0 ? `${val}K` : `${parseFloat(val.toFixed(1))}K`;
  }
  return String(n);
}

/**
 * Format a token/unit count with unit suffix for TTY.
 * Examples: "850K tok", "1M tok", "50 img", "10K char"
 */
export function humanizeWithUnit(n: number, unit: string): string {
  const shortUnit = unitAbbrev(unit);
  return `${humanizeNumber(n)} ${shortUnit}`;
}

/**
 * Abbreviate unit names for display.
 */
function unitAbbrev(unit: string): string {
  switch (unit) {
    case 'tokens':
    case 'token':
      return 'tok';
    case 'images':
    case 'image':
    case 'pieces':
    case 'piece':
      return 'img';
    case 'characters':
    case 'character':
      return 'char';
    case 'seconds':
    case 'second':
      return 'sec';
    default: {
      // Fallback: handle any raw API unit strings that slipped through normalization
      const l = unit.toLowerCase();
      if (l.includes('token')) return 'tok';
      if (l.includes('image') || l.includes('piece')) return 'img';
      if (l.includes('second')) return 'sec';
      if (l.includes('char') || l.includes('word')) return 'char';
      return unit;
    }
  }
}

/**
 * Format a price for display.
 * Examples: "¥0.50", "¥2.00", "¥0.14/¥0.56"
 */
export function formatPrice(amount: number): string {
  return `${CUR}${amount.toFixed(2)}`;
}

/**
 * Format cost (remove trailing zeros if possible but keep at least 2 decimals).
 */
export function formatCost(amount: number): string {
  return `${CUR}${amount.toFixed(2)}`;
}

/**
 * Format a currency amount with ¥ prefix and 2 decimal places.
 * For very small amounts (< 0.01), show more precision.
 */
export function humanizeCurrency(amount: number, currency: string = site.features.currency): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (amount < 0.01 && amount > 0) {
    return `${symbol}${amount.toFixed(5)}`;
  }
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Format a percentage value for display.
 * Examples: "85%", "100%", "0%"
 */
export function humanizePercentage(pct: number): string {
  return `${Math.round(pct)}%`;
}

/**
 * Format a duration in milliseconds to human-readable form.
 * Examples: "3h 24m", "5d 8h", "in 45m"
 */
export function humanizeDuration(ms: number, prefix: string = ''): string {
  if (ms <= 0) return `${prefix}now`;

  const totalSeconds = Math.floor(ms / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  const days = totalDays;
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);

  if (parts.length === 0) return `${prefix}now`;
  return `${prefix}${parts.join(' ')}`;
}

/**
 * Format a "next reset" time from an ISO date string.
 * Examples: "in 3h 24m", "in 5d 8h", "in 24d"
 */
export function formatNextReset(isoDate: string): string {
  const reset = new Date(isoDate);
  const now = new Date();
  const diffMs = reset.getTime() - now.getTime();
  return humanizeDuration(diffMs, 'in ');
}
