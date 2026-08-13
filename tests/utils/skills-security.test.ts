/**
 * Tests for skills-security — slug allow-list, safe entry paths, boundary
 * containment and the symlink-escape realpath probe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_SLUG_LENGTH,
  isValidSlug,
  isSafeRelativeEntryPath,
  resolveWithinBase,
  isRealPathWithinBase,
} from '../../src/utils/skills-security.js';

describe('isValidSlug — allow-list validation', () => {
  it.each(['pdf-extractor', 'a', 'A1', 'my_skill', 'skill-2_x', 'x'.repeat(MAX_SLUG_LENGTH)])(
    'accepts %s',
    (slug) => {
      expect(isValidSlug(slug)).toBe(true);
    },
  );

  it.each([
    '',
    '-leading',
    'trailing-',
    '_leading',
    'trailing_',
    'has.dot',
    'has/slash',
    'has\\backslash',
    'has space',
    '../evil',
    'ha$h',
    '中文名',
    'x'.repeat(MAX_SLUG_LENGTH + 1),
  ])('rejects %j', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
});

describe('isSafeRelativeEntryPath — zip entry path policy', () => {
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
  const base = path.join(path.sep, 'base', 'dir');

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
    root = mkdtempSync(path.join(tmpdir(), 'qianwen-skillsec-'));
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

  it('detects a symlinked intermediate directory pointing outside the base', () => {
    symlinkSync(outside, path.join(base, 'link'));
    expect(isRealPathWithinBase(base, path.join(base, 'link', 'evil.txt'))).toBe(false);
  });

  it('accepts a symlink that stays inside the base', () => {
    mkdirSync(path.join(base, 'real'));
    symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
    expect(isRealPathWithinBase(base, path.join(base, 'link', 'ok.txt'))).toBe(true);
  });
});
