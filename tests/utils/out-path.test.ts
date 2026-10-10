import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
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
    const base = mkdtempSync(join(tmpdir(), 'out-'));
    created.push(base);
    // A regular file occupying an ancestor segment makes mkdir fail on every
    // platform; a drive-root path like '/x/y' is creatable on Windows, so it
    // cannot stand in for an uncreatable parent there.
    const blocker = join(base, 'blocked');
    writeFileSync(blocker, 'x');
    let err: unknown;
    try {
      preflightOutPath(join(blocker, 'sub', 'cat.png'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('IO_ERROR');
  });
});
