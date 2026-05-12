import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveFormat, resolveFormatFromCommand } from '../../src/output/format.js';
import { Command } from 'commander';

describe('resolveFormat', () => {
  it('uses explicit flag when provided', () => {
    expect(resolveFormat('json', 'auto')).toBe('json');
    expect(resolveFormat('table', 'auto')).toBe('table');
    expect(resolveFormat('text', 'auto')).toBe('text');
  });

  it('treats "auto" flag as TTY detection', () => {
    // TTY → table
    vi.stubGlobal('process', { ...process, stdout: { isTTY: true } });
    expect(resolveFormat('auto', 'auto')).toBe('table');

    // Non-TTY → json
    vi.stubGlobal('process', { ...process, stdout: { isTTY: false } });
    expect(resolveFormat('auto', 'auto')).toBe('json');

    vi.unstubAllGlobals();
  });

  it('uses config when flag is not provided', () => {
    expect(resolveFormat(undefined, 'json')).toBe('json');
    expect(resolveFormat(undefined, 'table')).toBe('table');
  });

  it('auto-detects when neither flag nor config is set', () => {
    vi.stubGlobal('process', { ...process, stdout: { isTTY: true } });
    expect(resolveFormat(undefined, undefined)).toBe('table');

    vi.stubGlobal('process', { ...process, stdout: { isTTY: false } });
    expect(resolveFormat(undefined, undefined)).toBe('json');

    vi.unstubAllGlobals();
  });

  it('rejects invalid formats with INVALID_FORMAT error to stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as any);

    expect(() => resolveFormat('yaml', 'auto')).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = (stderrSpy.mock.calls[0] as any[])[0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.error.code).toBe('INVALID_FORMAT');
    expect(parsed.error.message).toContain("'yaml'");

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('resolveFormatFromCommand', () => {
  it('finds --format flag on the command itself', () => {
    const cmd = new Command();
    cmd.option('--format <fmt>');
    // Directly set the option value to avoid Commander v14 strict argument parsing
    (cmd as any)._optionValues = { format: 'json' };

    const result = resolveFormatFromCommand(cmd, { 'output.format': 'auto' } as any);
    expect(result).toBe('json');
  });

  it('finds --format flag on parent command', () => {
    const program = new Command();
    program.option('--format <fmt>');
    (program as any)._optionValues = { format: 'json' };

    const sub = program.command('usage');

    const result = resolveFormatFromCommand(sub, { 'output.format': 'auto' } as any);
    expect(result).toBe('json');
  });

  it('falls back to config when no flag found', () => {
    const cmd = new Command();
    // No --format option set, no opts

    const result = resolveFormatFromCommand(cmd, { 'output.format': 'text' } as any);
    expect(result).toBe('text');
  });
});
