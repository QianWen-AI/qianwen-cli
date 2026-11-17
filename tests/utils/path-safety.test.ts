import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSafeRelativeEntryPath,
  resolveWithinBase,
  isRealPathWithinBase,
} from '../../src/utils/path-safety.js';
import { canCreateSymlinks } from '../helpers/symlink-capability.js';

describe('isSafeRelativeEntryPath — archive entry path policy', () => {
  it.each(['file.txt', 'dir/file.txt', 'a/b/c.md', 'dir/', 'a/b/'])('accepts %s', (p) => {
    expect(isSafeRelativeEntryPath(p)).toBe(true);
  });

  it.each([
    '',
    '/etc/passwd',
    '../escape.txt',
    'a/../escape.txt',
    'a/..',
    './relative.txt',
    'a/./b.txt',
    'C:/windows/system32',
    'c:evil',
    'a\\b.txt',
    'a//b.txt',
    'a/\0/b',
  ])('rejects %j', (p) => {
    expect(isSafeRelativeEntryPath(p)).toBe(false);
  });
});

describe('resolveWithinBase — separator-aware boundary', () => {
  // resolveWithinBase() calls path.resolve(), which turns the drive-relative
  // '\base\dir' into '<cwd drive>:\base\dir' on Windows; use a fully
  // qualified absolute base so both platforms resolve identically.
  const base = process.platform === 'win32' ? 'C:\\base\\dir' : '/base/dir';

  it('resolves a normal relative path inside the base', () => {
    expect(resolveWithinBase(base, 'sub/file.txt')).toBe(path.join(base, 'sub', 'file.txt'));
  });

  it('accepts the base itself', () => {
    expect(resolveWithinBase(base, '.')).toBe(base);
  });

  it('rejects traversal that escapes the base', () => {
    expect(resolveWithinBase(base, '../outside.txt')).toBeNull();
    expect(resolveWithinBase(base, 'a/../../outside.txt')).toBeNull();
  });

  it('rejects sibling-prefix escapes (/base/dir-evil for base /base/dir)', () => {
    expect(resolveWithinBase(base, `..${path.sep}dir-evil${path.sep}f`)).toBeNull();
  });
});

describe('isRealPathWithinBase — symlink escape detection', () => {
  let root: string;
  let base: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qianwen-path-safety-'));
    base = path.join(root, 'base');
    outside = path.join(root, 'outside');
    mkdirSync(base);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a not-yet-existing path whose ancestors stay inside the base', () => {
    expect(isRealPathWithinBase(base, path.join(base, 'new', 'deep', 'file.txt'))).toBe(true);
  });

  it('accepts an existing regular subdirectory', () => {
    mkdirSync(path.join(base, 'sub'));
    expect(isRealPathWithinBase(base, path.join(base, 'sub', 'file.txt'))).toBe(true);
  });

  // Symlink creation needs SeCreateSymbolicLinkPrivilege / Developer Mode on
  // Windows; skip where the scenario cannot be set up at all.
  it.skipIf(!canCreateSymlinks())(
    'detects a symlinked intermediate directory pointing outside the base',
    () => {
      symlinkSync(outside, path.join(base, 'link'));
      expect(isRealPathWithinBase(base, path.join(base, 'link', 'evil.txt'))).toBe(false);
    },
  );

  it.skipIf(!canCreateSymlinks())('accepts a symlink that stays inside the base', () => {
    mkdirSync(path.join(base, 'real'));
    symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
    expect(isRealPathWithinBase(base, path.join(base, 'link', 'ok.txt'))).toBe(true);
  });

  it('rejects a dangling symlink ancestor whose target does not exist', () => {
    symlinkSync(path.join(root, 'nonexistent'), path.join(base, 'dangling'));
    expect(isRealPathWithinBase(base, path.join(base, 'dangling', 'file.txt'))).toBe(false);
  });

  it('rejects an active symlink ancestor pointing outside the base', () => {
    symlinkSync(outside, path.join(base, 'escape'));
    expect(isRealPathWithinBase(base, path.join(base, 'escape', 'file.txt'))).toBe(false);
  });

  it('accepts a normal nested non-existing path without any symlinks', () => {
    expect(isRealPathWithinBase(base, path.join(base, 'a', 'b', 'c', 'file.txt'))).toBe(true);
  });

  it('accepts when baseDir itself is a symlink pointing to a real directory', () => {
    const realDir = path.join(root, 'realbase');
    mkdirSync(realDir);
    const symlinkBase = path.join(root, 'symlinkbase');
    symlinkSync(realDir, symlinkBase);
    expect(isRealPathWithinBase(symlinkBase, path.join(symlinkBase, 'new', 'file.txt'))).toBe(true);
  });
});
