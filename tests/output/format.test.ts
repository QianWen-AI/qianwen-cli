import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveFormat,
  resolveFormatFromCommand,
  resolveExplicitFormat,
} from '../../src/output/format.js';
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
    expect(parsed.error.exit_code).toBe(1);
    expect(parsed.error).not.toHaveProperty('exitCode');

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

describe('resolveExplicitFormat', () => {
  it('returns the format value when explicitly set on the command', () => {
    const cmd = new Command();
    cmd.option('--format <fmt>');
    (cmd as any)._optionValues = { format: 'json' };

    expect(resolveExplicitFormat(cmd)).toBe('json');
  });

  it('walks up the parent chain to find --format', () => {
    const program = new Command();
    program.option('--format <fmt>');
    (program as any)._optionValues = { format: 'text' };
    const sub = program.command('usage');

    expect(resolveExplicitFormat(sub)).toBe('text');
  });

  it('returns undefined when no explicit --format is set', () => {
    const cmd = new Command();
    expect(resolveExplicitFormat(cmd)).toBeUndefined();
  });
});
