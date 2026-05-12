import { describe, it, expect } from 'vitest';
import { formatModality, validateModalityFlag, MODALITY_VALUES } from '../../src/utils/modality.js';
import { CliError } from '../../src/utils/errors.js';

describe('formatModality', () => {
  it('formats single input to single output', () => {
    expect(formatModality({ input: ['text'], output: ['text'] })).toBe('Text→Text');
    expect(formatModality({ input: ['text'], output: ['image'] })).toBe('Text→Img');
  });

  it('formats multiple inputs with single output', () => {
    expect(formatModality({ input: ['text', 'image', 'video'], output: ['text'] })).toBe('Text+Img+Video→Text');
  });

  it('formats single input with multiple outputs', () => {
    expect(formatModality({ input: ['text'], output: ['text', 'audio'] })).toBe('Text→Text+Audio');
  });

  it('formats all modalities', () => {
    expect(formatModality({
      input: ['text', 'image', 'video', 'audio'],
      output: ['text', 'audio'],
    })).toBe('Text+Img+Video+Audio→Text+Audio');
  });

  it('handles vector output', () => {
    expect(formatModality({ input: ['text'], output: ['vector'] })).toBe('Text→Vector');
  });

  it('abbreviates modality names correctly', () => {
    expect(formatModality({ input: ['image'], output: ['video'] })).toBe('Img→Video');
    expect(formatModality({ input: ['audio'], output: ['text'] })).toBe('Audio→Text');
  });
});

describe('validateModalityFlag', () => {
  it('accepts every value in MODALITY_VALUES', () => {
    for (const v of MODALITY_VALUES) {
      expect(validateModalityFlag('--input', v)).toBe(v);
    }
  });

  it('rejects unknown values with INVALID_MODALITY CliError', () => {
    let caught: unknown;
    try {
      validateModalityFlag('--input', 'pdf');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    const err = caught as CliError;
    expect(err.code).toBe('INVALID_MODALITY');
    expect(err.message).toContain("'pdf'");
    expect(err.message).toContain('text');
  });

  it('mentions the offending flag name in the error', () => {
    expect(() => validateModalityFlag('--output', 'bogus')).toThrow(/--output/);
  });
});
