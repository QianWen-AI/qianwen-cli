import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { preflightOutPath } from '../../src/utils/out-path.js';
import { CliError } from '../../src/utils/errors.js';

const created: string[] = [];

afterEach(() => {
  while (created.length) {
    const p = created.pop();
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe('preflightOutPath', () => {
  it('is a no-op for undefined or empty out', () => {
    expect(() => preflightOutPath(undefined)).not.toThrow();
    expect(() => preflightOutPath('')).not.toThrow();
  });

  it('creates a missing parent directory for a file target', () => {
    const base = mkdtempSync(join(tmpdir(), 'out-'));
    created.push(base);
    const target = join(base, 'a', 'b', 'cat.png');
    preflightOutPath(target);
    expect(statSync(join(base, 'a', 'b')).isDirectory()).toBe(true);
  });

  it('throws IO_ERROR when the parent directory cannot be created', () => {
    let err: unknown;
    try {
      preflightOutPath('/dfdfef/fef/cat.png');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('IO_ERROR');
  });
});
