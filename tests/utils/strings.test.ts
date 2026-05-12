import { describe, it, expect } from 'vitest';
import { levenshtein, didYouMean } from '../../src/utils/strings.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('foo', 'foo')).toBe(0);
  });

  it('returns length when one side is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single-character edits', () => {
    expect(levenshtein('cat', 'cot')).toBe(1);   // substitution
    expect(levenshtein('cat', 'cats')).toBe(1);  // insertion
    expect(levenshtein('cats', 'cat')).toBe(1);  // deletion
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
