import { describe, it, expect } from 'vitest';
import {
  humanizeNumber,
  humanizeWithUnit,
  formatPrice,
  formatCost,
  humanizeCurrency,
  humanizePercentage,
  humanizeDuration,
} from '../../src/output/humanize.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('humanizeNumber', () => {
  it('returns raw number for values < 1000', () => {
    expect(humanizeNumber(0)).toBe('0');
    expect(humanizeNumber(50)).toBe('50');
    expect(humanizeNumber(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(humanizeNumber(1000)).toBe('1K');
    expect(humanizeNumber(1500)).toBe('1.5K');
    expect(humanizeNumber(65536)).toBe('65.5K');
    expect(humanizeNumber(15000)).toBe('15K');
  });

  it('formats millions with M suffix', () => {
    expect(humanizeNumber(1000000)).toBe('1M');
    expect(humanizeNumber(1500000)).toBe('1.5M');
    expect(humanizeNumber(2480000)).toBe('2.5M'); // 2.48 rounds to 2.5 with 1 decimal
    expect(humanizeNumber(991800)).toBe('991.8K'); // just under 1M
  });

  it('handles edge cases', () => {
    expect(humanizeNumber(100000)).toBe('100K');
    expect(humanizeNumber(55160)).toBe('55.2K');
    expect(humanizeNumber(850000)).toBe('850K');
  });
});

describe('humanizeWithUnit', () => {
  it('abbreviates unit names correctly', () => {
    expect(humanizeWithUnit(850000, 'tokens')).toBe('850K tok');
    expect(humanizeWithUnit(1000000, 'tokens')).toBe('1M tok');
    expect(humanizeWithUnit(50, 'images')).toBe('50 img');
    expect(humanizeWithUnit(10000, 'characters')).toBe('10K char');
    expect(humanizeWithUnit(1200, 'seconds')).toBe('1.2K sec');
  });

  it('handles singular unit forms', () => {
    expect(humanizeWithUnit(1, 'token')).toBe('1 tok');
    expect(humanizeWithUnit(1, 'image')).toBe('1 img');
    expect(humanizeWithUnit(1, 'piece')).toBe('1 img');
    expect(humanizeWithUnit(5, 'pieces')).toBe('5 img');
    expect(humanizeWithUnit(1, 'character')).toBe('1 char');
    expect(humanizeWithUnit(1, 'second')).toBe('1 sec');
  });

  it('handles unknown units', () => {
    expect(humanizeWithUnit(500, 'requests')).toBe('500 requests');
  });
});

describe('formatPrice / formatCost', () => {
  it('formats prices with 2 decimals', () => {
    expect(formatPrice(0.50)).toBe(`${s.currencySymbol}0.50`);
    expect(formatPrice(2.00)).toBe(`${s.currencySymbol}2.00`);
    expect(formatPrice(0.14)).toBe(`${s.currencySymbol}0.14`);
  });

  it('formats costs consistently', () => {
    expect(formatCost(0.38)).toBe(`${s.currencySymbol}0.38`);
    expect(formatCost(2.07)).toBe(`${s.currencySymbol}2.07`);
    expect(formatCost(0.000035)).toBe(`${s.currencySymbol}0.00`); // Very small rounds to ${s.currencySymbol}0.00
  });
});

describe('humanizeCurrency', () => {
  it('formats USD correctly', () => {
    expect(humanizeCurrency(0.38)).toBe(`${s.currencySymbol}0.38`);
    expect(humanizeCurrency(2.07)).toBe(`${s.currencySymbol}2.07`);
    expect(humanizeCurrency(100)).toBe(`${s.currencySymbol}100.00`);
  });

  it('shows more precision for very small amounts', () => {
    expect(humanizeCurrency(0.000035)).toBe(`${s.currencySymbol}0.00003`); // IEEE 754: 0.000035.toFixed(5) = '0.00003'
    expect(humanizeCurrency(0.005)).toBe(`${s.currencySymbol}0.00500`);
  });

  it('supports CNY', () => {
    expect(humanizeCurrency(100, 'CNY')).toBe('¥100.00');
  });
});

describe('humanizePercentage', () => {
  it('rounds to integer', () => {
    expect(humanizePercentage(85)).toBe('85%');
    expect(humanizePercentage(100)).toBe('100%');
    expect(humanizePercentage(0)).toBe('0%');
    expect(humanizePercentage(50.5)).toBe('51%'); // Math.round(50.5) = 51 (rounds half up)
    expect(humanizePercentage(50.6)).toBe('51%');
  });
});

describe('humanizeDuration', () => {
  it('returns "now" for zero or negative', () => {
    expect(humanizeDuration(0)).toBe('now');
    expect(humanizeDuration(-1000)).toBe('now');
  });

  it('formats minutes', () => {
    expect(humanizeDuration(45 * 60 * 1000)).toBe('45m');
  });

  it('formats hours and minutes', () => {
    expect(humanizeDuration((3 * 60 + 24) * 60 * 1000)).toBe('3h 24m');
  });

  it('formats days and hours', () => {
    expect(humanizeDuration((5 * 24 + 8) * 60 * 60 * 1000)).toBe('5d 8h');
  });

  it('supports prefix', () => {
    expect(humanizeDuration(3 * 60 * 60 * 1000, 'in ')).toBe('in 3h');
    expect(humanizeDuration(0, 'in ')).toBe('in now');
  });
});
