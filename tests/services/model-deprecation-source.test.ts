/**
 * Tests for the CDN deprecation source consumed by the pre-request guard: the
 * lookup's retiring predicate and the long-date helper.
 */
import { describe, it, expect } from 'vitest';
import {
  DeprecationLookup,
  formatRetireDateLong,
} from '../../src/services/model-deprecation-source.js';

const NOW = Date.parse('2026-06-01T00:00:00+08:00');
const lookup = new DeprecationLookup(
  [
    { id: 'qwen-retiring', expiredTime: '2026-06-20T23:59:59+08:00' },
    { id: 'qwen-expired', expiredTime: '2026-01-01T00:00:00+08:00' },
    { id: 'qwen-far', expiredTime: '2026-10-10T23:59:59+08:00' },
    { id: 'qwen-undated' },
  ],
  () => NOW,
);

describe('DeprecationLookup', () => {
  it('flags only future-dated entries within 30-day window as retiring', () => {
    expect(lookup.isRetiring('qwen-retiring')).toBe(true);
    expect(lookup.isRetiring('qwen-expired')).toBe(false);
    expect(lookup.isRetiring('qwen-far')).toBe(false);
    expect(lookup.isRetiring('qwen-undated')).toBe(false);
    expect(lookup.isRetiring('qwen-absent')).toBe(false);
  });

  it('formats an ISO instant as a long English date', () => {
    expect(formatRetireDateLong('2026-10-10T23:59:59+08:00')).toBe('October 10, 2026');
  });
});
