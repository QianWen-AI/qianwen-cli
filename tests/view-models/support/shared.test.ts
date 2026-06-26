/**
 * Unit tests for the `maskEmail` view-model helper (BUG-8).
 *
 * Contract:
 *   • Contains '@'  → first char of local-part + '***' + '@' + full domain.
 *     (local empty → '***@domain')
 *   • No '@'        → returned verbatim (non-email nicknames are not masked).
 *   • Empty string  → returned verbatim ('').
 *
 * This is a pure function: no mocks. The SUT's own structure-aware masking is
 * exercised directly.
 */
import { describe, it, expect } from 'vitest';
import { maskEmail } from '../../../src/view-models/support/shared.js';

describe('maskEmail — email masking', () => {
  it('masks a standard email keeping the first local char and full domain', () => {
    expect(maskEmail('alice@mock-api.test.qwencloud.com')).toBe(
      'a***@mock-api.test.qwencloud.com',
    );
  });

  it('masks a single-char local part', () => {
    expect(maskEmail('b@mock-api.test.qwencloud.com')).toBe('b***@mock-api.test.qwencloud.com');
  });

  it('degrades to ***@domain when the local part is empty', () => {
    expect(maskEmail('@mock-api.test.qwencloud.com')).toBe('***@mock-api.test.qwencloud.com');
  });

  it('preserves the first char before the FIRST @ when multiple @ are present', () => {
    // Split on the first '@'; everything after it is treated as the domain.
    expect(maskEmail('user@name@mock-api.test.qwencloud.com')).toBe(
      'u***@name@mock-api.test.qwencloud.com',
    );
  });
});

describe('maskEmail — non-email passthrough', () => {
  it('returns a plain nickname without @ verbatim', () => {
    expect(maskEmail('Service Assistant')).toBe('Service Assistant');
  });

  it('returns a role-style nickname verbatim', () => {
    expect(maskEmail('Customer Support Engineer')).toBe('Customer Support Engineer');
  });

  it('returns an empty string verbatim', () => {
    expect(maskEmail('')).toBe('');
  });
});
