/**
 * Parse --period preset into { from, to } date strings.
 * Presets: today, yesterday, week, month (default), last-month, quarter, year, YYYY-MM
 */
export function parsePeriod(period: string): { from: string; to: string } {
  // Normalize aliases from CLI help text
  if (period === 'this-week') period = 'week';
  if (period === 'this-month') period = 'month';

  const now = new Date();
  const today = formatDate(now);

  switch (period) {
    case 'today':
      return { from: today, to: today };

    case 'yesterday': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      const y = formatDate(d);
      return { from: y, to: y };
    }

    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { from: formatDate(d), to: today };
    }

    case 'month': {
      const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      return { from, to: today };
    }

    case 'last-month': {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: formatDate(d), to: formatDate(last) };
    }

    case 'quarter': {
      const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      return { from: formatDate(qStart), to: today };
    }

    case 'year': {
      return { from: `${now.getFullYear()}-01-01`, to: today };
    }

    default: {
      // YYYY-MM format
      const match = period.match(/^(\d{4})-(\d{2})$/);
      if (match) {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]);
        const from = `${year}-${String(month).padStart(2, '0')}-01`;
        const last = new Date(year, month, 0);
        return { from, to: formatDate(last) };
      }
      throw new Error(
        `Invalid period: '${period}'. Valid: today, yesterday, week, month, last-month, quarter, year, YYYY-MM`,
      );
    }
  }
}

/**
 * Resolve date range from various flag combinations.
 * Priority: --from/--to > --days > --period > default (month)
 */
export function resolveDateRange(options: {
  from?: string;
  to?: string;
  days?: number;
  period?: string;
}): { from: string; to: string } {
  const now = new Date();
  const today = formatDate(now);

  // Priority 1: explicit from/to
  if (options.from || options.to) {
    const from = options.from ?? (options.to ? `${options.to.slice(0, 7)}-01` : today);
    return { from, to: options.to || today };
  }

  // Priority 2: --days shorthand
  if (options.days) {
    const d = new Date(now);
    d.setDate(d.getDate() - options.days + 1);
    return { from: formatDate(d), to: today };
  }

  // Priority 3: --period preset
  if (options.period) {
    return parsePeriod(options.period);
  }

  // Default: current month
  return parsePeriod('month');
}

/**
 * Validate that a date range doesn't exceed 1 year lookback.
 * Throws an Error with a structured message that commands can catch
 * and convert to a CliError with INVALID_RANGE code.
 */
export function validateDateRange(from: string, to: string): void {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  if (fromDate < oneYearAgo) {
    throw new Error('date range exceeds maximum lookback (1 year)');
  }

  if (fromDate > toDate) {
    // Use a special error class that can be detected by callers
    const err = new Error(`INVALID_DATE_RANGE:from=${from}:to=${to}`);
    err.name = 'InvalidDateRangeError';
    throw err;
  }
}

/**
 * Expand a YYYY-MM input to a full YYYY-MM-DD date by attaching the
 * first day for a range start and the calendar's last day for a range
 * end. Inputs already in YYYY-MM-DD form are returned unchanged. Other
 * formats are returned as-is so callers can surface their own validation.
 */
export function normalizeToFullDate(dateStr: string, position: 'start' | 'end'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const match = dateStr.match(/^(\d{4})-(\d{2})$/);
  if (!match) return dateStr;
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  if (position === 'start') {
    return `${match[1]}-${match[2]}-01`;
  }
  const lastDay = new Date(year, month, 0).getDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Format a Date to YYYY-MM-DD string using local time (not UTC).
 * This avoids off-by-one errors near midnight when the local date
 * differs from the UTC date.
 */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format a relative time string like "in 3h 24m" or "in 5d 8h"
 */
export function formatRelativeTime(isoDate: string): string {
  const target = new Date(isoDate);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();

  if (diffMs <= 0) return 'now';

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainHours = hours % 24;
    return `in ${days}d ${remainHours}h`;
  }
  if (hours > 0) {
    const remainMins = minutes % 60;
    return `in ${hours}h ${remainMins}m`;
  }
  return `in ${minutes}m`;
}
