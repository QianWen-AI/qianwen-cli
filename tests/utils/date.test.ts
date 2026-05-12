import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  parsePeriod,
  resolveDateRange,
  validateDateRange,
  formatDate,
  formatRelativeTime,
} from '../../src/utils/date.js';

// formatDate uses toISOString() which is always UTC.
// parsePeriod uses local-time constructors (new Date(y,m,d)).
// To keep tests deterministic we fix the timezone to UTC.
const originalTZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'UTC'; });
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
