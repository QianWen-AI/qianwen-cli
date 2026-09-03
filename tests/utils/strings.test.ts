import { describe, it, expect } from 'vitest';
import {
  PAYMENT_URL_HOSTS,
  didYouMean,
  levenshtein,
  redactPaymentData,
  redactPaymentError,
  validatePaymentUrl,
} from '../../src/utils/strings.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('foo', 'foo')).toBe(0);
  });

  it('returns length when one side is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single-character edits', () => {
    expect(levenshtein('cat', 'cot')).toBe(1); // substitution
    expect(levenshtein('cat', 'cats')).toBe(1); // insertion
    expect(levenshtein('cats', 'cat')).toBe(1); // deletion
  });

  it('handles real model id typos', () => {
    expect(levenshtein('qwen3-ma', 'qwen3-max')).toBe(1);
    expect(levenshtein('qwen3.6-pls', 'qwen3.6-plus')).toBe(1);
  });
});

describe('didYouMean', () => {
  const models = ['qwen3-max', 'qwen3.6-plus', 'qwen3-coder-plus', 'qwen-vl-plus'];

  it('suggests the closest match for short typos', () => {
    expect(didYouMean('qwen3-ma', models)).toBe('qwen3-max');
    expect(didYouMean('qwen3.6-pls', models)).toBe('qwen3.6-plus');
  });

  it('is case-insensitive on input', () => {
    expect(didYouMean('QWEN3-MA', models)).toBe('qwen3-max');
  });

  it('returns null when no candidate is close enough', () => {
    expect(didYouMean('totally-different', models)).toBe(null);
    expect(didYouMean('xyz', models)).toBe(null);
  });

  it('returns null on empty candidate list', () => {
    expect(didYouMean('qwen3-ma', [])).toBe(null);
  });

  it('returns null on empty input', () => {
    expect(didYouMean('', models)).toBe(null);
  });

  it('respects threshold scaled to input length', () => {
    // input length 3 → threshold = max(2, 1) = 2; "abc" → "abz" (d=1) ok
    expect(didYouMean('abc', ['abz'])).toBe('abz');
    // input length 3 → "abc" vs "xyz" (d=3) too far
    expect(didYouMean('abc', ['xyz'])).toBe(null);
  });
});

describe('validatePaymentUrl', () => {
  it.each(['https://pay.test.qianwenai.com/pay?id=1'])(
    'accepts exact HTTPS payment hosts and preserves the original string: %s',
    (value) => {
      expect(validatePaymentUrl(value, PAYMENT_URL_HOSTS).href).toBe(value);
    },
  );

  it.each([
    'http://pay.test.qianwenai.com/checkout/1',
    'https://pay.test.qianwenai.com.evil.test/checkout/1',
    'https://user:password@pay.test.qianwenai.com/checkout/1',
    'https://evil.test/checkout/1',
  ])('rejects payment URLs outside the allowlist: %s', (value) => {
    expect(() => validatePaymentUrl(value, PAYMENT_URL_HOSTS)).toThrow('not allowed');
  });

  it.each([
    ' https://pay.test.qianwenai.com/checkout/1',
    'https://pay.test.qianwenai.com/checkout/1 ',
    'https://pay.test.qianwenai.com/checkout/\t1',
    'https://pay.test.qianwenai.com/checkout/\n1',
    'https://pay.test.qianwenai.com/checkout/\u007f1',
  ])('rejects inputs that the URL parser would silently normalize: %j', (value) => {
    expect(() => validatePaymentUrl(value, PAYMENT_URL_HOSTS)).toThrow('Invalid payment URL');
  });
});

describe('redactPaymentData', () => {
  it('redacts only nested Nbid values and keeps order IDs and payment URLs visible', () => {
    const nbid = 'nbid/value+1';
    const input = {
      nested: { Nbid: nbid },
      message: `Nbid=${nbid}; encoded=${encodeURIComponent(nbid)}`,
      rechargeOrderId: 'order-visible-1',
      paymentUrl: 'https://pay.test.qianwenai.com/visible-1',
      order: 'ordinary-order-field',
      encoded: 'ordinary-encoded-field',
    };

    const output = redactPaymentData(input) as Record<string, unknown>;
    expect(JSON.stringify(output)).not.toContain(nbid);
    expect(JSON.stringify(output)).not.toContain(encodeURIComponent(nbid));
    expect(output).toMatchObject({
      rechargeOrderId: 'order-visible-1',
      paymentUrl: 'https://pay.test.qianwenai.com/visible-1',
      order: 'ordinary-order-field',
      encoded: 'ordinary-encoded-field',
    });
    expect(input.nested.Nbid).toBe(nbid);
  });

  it('supports numeric Nbid values and cyclic objects without mutating the input', () => {
    const input: Record<string, unknown> = { nbid: 123456, message: 'account 123456 failed' };
    input.self = input;

    const output = redactPaymentData(input) as Record<string, unknown>;
    expect(output.nbid).toBe('[REDACTED]');
    expect(output.message).toBe('account [REDACTED] failed');
    expect(output.self).toBe(output);
    expect(input.nbid).toBe(123456);
  });

  it('keeps Error identity, name, code, stack, and cause unchanged', () => {
    const cause = new Error('inner failure');
    const error = Object.assign(new Error('request failed for account-sensitive'), {
      name: 'GatewayEnvelopeError',
      code: '503',
      cause,
    });
    const originalStack = error.stack;

    expect(redactPaymentError(error, { Nbid: 'account-sensitive' })).toBe(error);
    expect(error).toMatchObject({ name: 'GatewayEnvelopeError', code: '503', cause });
    expect(error.stack).toBe(originalStack);

    const output = redactPaymentData(error) as Record<string, unknown>;
    expect(output.message).toBe('request failed for [REDACTED]');
    expect(output.name).toBe('GatewayEnvelopeError');
    expect(output.code).toBe('503');
  });
});
