import { describe, it, expect } from 'vitest';
import { normalizeForSearch } from '../../src/utils/search-normalize.js';

describe('normalizeForSearch', () => {
  it('lowercases', () => {
    expect(normalizeForSearch('Function-Calling')).toBe('function calling');
  });

  it('collapses hyphens, underscores, and whitespace runs into a single space', () => {
    expect(normalizeForSearch('function-calling')).toBe('function calling');
    expect(normalizeForSearch('function_calling')).toBe('function calling');
    expect(normalizeForSearch('function   calling')).toBe('function calling');
    expect(normalizeForSearch('function-_-calling')).toBe('function calling');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeForSearch('  text  ')).toBe('text');
  });

  it('makes "function calling" match a "function-calling" feature via includes', () => {
    // The whole point: an Agent searching for the human phrase must hit the
    // hyphenated feature name. After normalization both collapse to the same
    // token, so a substring check succeeds.
    const needle = normalizeForSearch('function calling');
    const haystack = normalizeForSearch('function-calling');
    expect(haystack.includes(needle)).toBe(true);
  });
});
