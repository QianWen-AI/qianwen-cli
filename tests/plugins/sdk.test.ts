import { describe, it, expect } from 'vitest';
import * as sdk from '../../src/plugins/sdk.js';

describe('plugin SDK surface — re-exports present', () => {
  it('exports CliError, handleError, EXIT_CODES, and error factories', () => {
    expect(typeof sdk.CliError).toBe('function');
    expect(typeof sdk.handleError).toBe('function');
    expect(typeof sdk.invalidArgError).toBe('function');
    expect(sdk.EXIT_CODES.GENERAL_ERROR).toBe(1);
  });

  it('exports outputJSON, formatTextTable, and resolveFormatFromCommand without Ink', () => {
    expect(typeof sdk.outputJSON).toBe('function');
    expect(typeof sdk.formatTextTable).toBe('function');
    expect(typeof sdk.resolveFormatFromCommand).toBe('function');
  });

  it('exports VERSION and isSemVerGreater', () => {
    expect(typeof sdk.VERSION).toBe('string');
    expect(sdk.isSemVerGreater('2.0.0', '1.0.0')).toBe(true);
  });

  it('uses CliError.detail without a cause field', () => {
    const e = new sdk.CliError({ code: 'X', message: 'm', exitCode: 1, detail: 'd' });
    expect(e.code).toBe('X');
    expect(e.detail).toBe('d');
    expect('cause' in e && (e as { cause?: unknown }).cause !== undefined).toBe(false);
  });
});
