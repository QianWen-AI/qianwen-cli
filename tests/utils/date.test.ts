import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  parsePeriod,
  resolveDateRange,
  validateDateRange,
  formatDate,
  formatAsiaShanghaiDate,
  formatRelativeTime,
  resolveRechargeHistoryRange,
} from '../../src/utils/date.js';

// Local-calendar helpers depend on the host timezone; fix it for deterministic tests.
const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe('parsePeriod', () => {
  // Use a fixed "now" so tests are deterministic
  const FIXED_NOW = new Date('2025-03-15T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should parse "today"', () => {
    const result = parsePeriod('today');
    expect(result).toEqual({ from: '2025-03-15', to: '2025-03-15' });
  });

  it('should parse "yesterday"', () => {
    const result = parsePeriod('yesterday');
    expect(result).toEqual({ from: '2025-03-14', to: '2025-03-14' });
  });

  it('should parse "week" (last 7 days)', () => {
    const result = parsePeriod('week');
    expect(result).toEqual({ from: '2025-03-09', to: '2025-03-15' });
  });

  it('should parse "month" (current month)', () => {
    const result = parsePeriod('month');
    expect(result).toEqual({ from: '2025-03-01', to: '2025-03-15' });
  });

  it('should treat "this-month" as alias for "month"', () => {
    const result = parsePeriod('this-month');
    expect(result).toEqual({ from: '2025-03-01', to: '2025-03-15' });
  });

  it('should parse "last-month"', () => {
    const result = parsePeriod('last-month');
    expect(result).toEqual({ from: '2025-02-01', to: '2025-02-28' });
  });

  it('should parse "quarter" (current quarter)', () => {
    // Q1 2025: Jan 1 – Mar 15 (today)
    const result = parsePeriod('quarter');
    expect(result).toEqual({ from: '2025-01-01', to: '2025-03-15' });
  });

  it('should treat "this-week" as alias for "week"', () => {
    const result = parsePeriod('this-week');
    expect(result).toEqual({ from: '2025-03-09', to: '2025-03-15' });
  });

  it('should parse "year"', () => {
    const result = parsePeriod('year');
    expect(result).toEqual({ from: '2025-01-01', to: '2025-03-15' });
  });

  it('should parse YYYY-MM format', () => {
    const result = parsePeriod('2024-12');
    expect(result).toEqual({ from: '2024-12-01', to: '2024-12-31' });
  });

  it('should parse YYYY-MM for February in a leap year', () => {
    const result = parsePeriod('2024-02');
    expect(result).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('should throw for invalid period', () => {
    expect(() => parsePeriod('invalid')).toThrow("Invalid period: 'invalid'");
  });

  it('should throw for malformed YYYY-MM', () => {
    expect(() => parsePeriod('2024-1')).toThrow("Invalid period: '2024-1'");
  });
});

describe('resolveDateRange', () => {
  const FIXED_NOW = new Date('2025-03-15T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should prioritize explicit from/to', () => {
    const result = resolveDateRange({ from: '2025-01-01', to: '2025-01-31' });
    expect(result).toEqual({ from: '2025-01-01', to: '2025-01-31' });
  });

  it('should default to today when only from is provided', () => {
    const result = resolveDateRange({ from: '2025-03-01' });
    expect(result).toEqual({ from: '2025-03-01', to: '2025-03-15' });
  });

  it('should use --days shorthand', () => {
    const result = resolveDateRange({ days: 7 });
    expect(result).toEqual({ from: '2025-03-09', to: '2025-03-15' });
  });

  it('should use --period preset', () => {
    const result = resolveDateRange({ period: 'last-month' });
    expect(result).toEqual({ from: '2025-02-01', to: '2025-02-28' });
  });

  it('should default to current month when no options', () => {
    const result = resolveDateRange({});
    expect(result).toEqual({ from: '2025-03-01', to: '2025-03-15' });
  });

  it('should prioritize from/to over days', () => {
    const result = resolveDateRange({ from: '2025-01-01', to: '2025-01-15', days: 7 });
    expect(result).toEqual({ from: '2025-01-01', to: '2025-01-15' });
  });

  it('should prioritize days over period', () => {
    const result = resolveDateRange({ days: 3, period: 'year' });
    expect(result).toEqual({ from: '2025-03-13', to: '2025-03-15' });
  });
});

describe('validateDateRange', () => {
  const FIXED_NOW = new Date('2025-03-15T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should accept a valid date range', () => {
    expect(() => validateDateRange('2025-01-01', '2025-03-15')).not.toThrow();
  });

  it('should throw when from > to', () => {
    expect(() => validateDateRange('2025-04-01', '2025-03-01')).toThrow('INVALID_DATE_RANGE');
  });

  it('should throw when range exceeds 1 year lookback', () => {
    expect(() => validateDateRange('2024-01-01', '2025-03-15')).toThrow('exceeds maximum lookback');
  });

  it('should accept a range within the 1-year boundary', () => {
    // 2024-03-16 is within 1 year from 2025-03-15T12:00:00Z
    expect(() => validateDateRange('2024-03-16', '2025-03-15')).not.toThrow();
  });

  it('should reject a range just outside the 1-year boundary', () => {
    // 2024-03-14 is more than 1 year ago from 2025-03-15T12:00:00Z
    expect(() => validateDateRange('2024-03-14', '2025-03-15')).toThrow('exceeds maximum lookback');
  });
});

describe('formatDate', () => {
  it('should format a date as YYYY-MM-DD', () => {
    expect(formatDate(new Date('2025-06-01T00:00:00Z'))).toBe('2025-06-01');
  });

  it('should pad single-digit month and day', () => {
    expect(formatDate(new Date('2025-01-05T00:00:00Z'))).toBe('2025-01-05');
  });
});

describe('formatAsiaShanghaiDate', () => {
  it('renders empty string as em-dash', () => {
    expect(formatAsiaShanghaiDate('')).toBe('—');
  });

  it('short-circuits pure YYYY-MM-DD values', () => {
    expect(formatAsiaShanghaiDate('2026-01-01')).toBe('2026-01-01');
  });

  it('rolls UTC timestamps past Shanghai midnight forward', () => {
    // 2026-10-15T16:00:00Z = 2026-10-16 00:00:00 +08:00
    expect(formatAsiaShanghaiDate('2026-10-15T16:00:00.000Z')).toBe('2026-10-16');
  });

  it('keeps UTC timestamps before Shanghai midnight on the same day', () => {
    // 2026-10-15T15:59:59Z = 2026-10-15 23:59:59 +08:00
    expect(formatAsiaShanghaiDate('2026-10-15T15:59:59.000Z')).toBe('2026-10-15');
  });

  it('returns unparseable input unchanged', () => {
    expect(formatAsiaShanghaiDate('foo')).toBe('foo');
  });

  it('honors explicit timezone offsets', () => {
    expect(formatAsiaShanghaiDate('2026-01-01T12:00:00+08:00')).toBe('2026-01-01');
  });

  it('accepts epoch milliseconds in date mode', () => {
    expect(formatAsiaShanghaiDate(Date.parse('2026-10-15T16:00:00.000Z'), 'date')).toBe(
      '2026-10-16',
    );
  });

  it('preserves the date prefix when the source timestamp is invalid', () => {
    expect(formatAsiaShanghaiDate('2026-01-01invalid')).toBe('2026-01-01');
  });

  it.each([
    Date.parse('2026-12-31T16:00:00.123Z'),
    '2026-12-31T16:00:00.123Z',
    '2027-01-01T00:00:00.123+08:00',
  ])('formats %s as a Shanghai datetime or an ISO value', (value) => {
    expect(formatAsiaShanghaiDate(value, 'datetime')).toBe('2027-01-01 00:00:00');
    expect(formatAsiaShanghaiDate(value, 'iso')).toBe('2027-01-01T00:00:00.123+08:00');
  });

  it('treats epoch zero as a valid instant in all formats', () => {
    expect(formatAsiaShanghaiDate(0)).toBe('1970-01-01');
    expect(formatAsiaShanghaiDate(0, 'datetime')).toBe('1970-01-01 08:00:00');
    expect(formatAsiaShanghaiDate(0, 'iso')).toBe('1970-01-01T08:00:00.000+08:00');
  });

  it.each(['', 'foo', NaN, Infinity])('rejects invalid datetime input: %s', (value) => {
    expect(() => formatAsiaShanghaiDate(value, 'datetime')).toThrow(RangeError);
    expect(() => formatAsiaShanghaiDate(value, 'iso')).toThrow(RangeError);
  });
});

describe('resolveRechargeHistoryRange', () => {
  const now = new Date('2026-08-25T10:30:00.000+08:00');

  it.each([
    ['1d', '2026-08-25T00:00:00.000+08:00'],
    ['3d', '2026-08-23T00:00:00.000+08:00'],
    ['7d', '2026-08-19T00:00:00.000+08:00'],
    ['30d', '2026-07-27T00:00:00.000+08:00'],
  ] as const)('resolves %s by Shanghai calendar days', (range, expectedStart) => {
    const result = resolveRechargeHistoryRange({ range, now });
    expect(formatAsiaShanghaiDate(result.startTime, 'iso')).toBe(expectedStart);
    expect(formatAsiaShanghaiDate(result.endTime, 'iso')).toBe('2026-08-25T23:59:59.999+08:00');
  });

  it('defaults to the latest 30 Shanghai calendar days without arguments', () => {
    const result = resolveRechargeHistoryRange({ now });
    expect(formatAsiaShanghaiDate(result.startTime, 'iso')).toBe('2026-07-27T00:00:00.000+08:00');
    expect(formatAsiaShanghaiDate(result.endTime, 'iso')).toBe('2026-08-25T23:59:59.999+08:00');
  });

  it('resolves explicit dates to the start and end of Shanghai calendar days', () => {
    const result = resolveRechargeHistoryRange({
      startTime: '2026-08-20',
      endTime: '2026-08-24',
    });
    expect(formatAsiaShanghaiDate(result.startTime, 'iso')).toBe('2026-08-20T00:00:00.000+08:00');
    expect(formatAsiaShanghaiDate(result.endTime, 'iso')).toBe('2026-08-24T23:59:59.999+08:00');
  });

  it('preserves explicit Shanghai time and milliseconds', () => {
    const result = resolveRechargeHistoryRange({
      startTime: '2026-08-20 10:30:00.1',
      endTime: '2026-08-20T20:00:00.123',
    });
    expect(formatAsiaShanghaiDate(result.startTime, 'iso')).toBe('2026-08-20T10:30:00.100+08:00');
    expect(formatAsiaShanghaiDate(result.endTime, 'iso')).toBe('2026-08-20T20:00:00.123+08:00');
  });

  it.each([
    [{ startTime: '2026-08-20' }, 'must be provided together'],
    [{ endTime: '2026-08-20' }, 'must be provided together'],
    [
      { range: '3d' as const, startTime: '2026-08-20', endTime: '2026-08-21' },
      'Choose either --range or both',
    ],
    [{ startTime: '2026-08-21', endTime: '2026-08-20' }, 'must be earlier than or equal to'],
    [{ startTime: '2026-02-30', endTime: '2026-03-01' }, 'Invalid Shanghai date/time'],
    [{ startTime: '2026-08-20T25:00:00', endTime: '2026-08-21' }, 'Invalid Shanghai date/time'],
  ])('rejects invalid recharge history range: %s', (options, message) => {
    expect(() => resolveRechargeHistoryRange(options)).toThrow(message);
  });
});

describe('formatRelativeTime', () => {
  const FIXED_NOW = new Date('2025-03-15T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "now" when target is in the past', () => {
    expect(formatRelativeTime('2025-03-15T11:00:00Z')).toBe('now');
  });

  it('returns "now" when target is exactly now', () => {
    expect(formatRelativeTime('2025-03-15T12:00:00Z')).toBe('now');
  });

  it('formats sub-hour deltas as minutes', () => {
    // +30 min
    expect(formatRelativeTime('2025-03-15T12:30:00Z')).toBe('in 30m');
  });

  it('formats sub-day deltas as hours + remaining minutes', () => {
    // +3h 24m
    expect(formatRelativeTime('2025-03-15T15:24:00Z')).toBe('in 3h 24m');
  });

  it('formats whole-hour deltas with 0 remaining minutes', () => {
    expect(formatRelativeTime('2025-03-15T17:00:00Z')).toBe('in 5h 0m');
  });

  it('formats multi-day deltas as days + remaining hours', () => {
    // +5d 8h
    expect(formatRelativeTime('2025-03-20T20:00:00Z')).toBe('in 5d 8h');
  });

  it('formats whole-day deltas with 0 remaining hours', () => {
    expect(formatRelativeTime('2025-03-22T12:00:00Z')).toBe('in 7d 0h');
  });
});
