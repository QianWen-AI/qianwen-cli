/**
 * Tests for skills-security — slug allow-list, full-slug (`@ns/name`) parsing
 * and validation, safe entry paths, boundary containment and the
 * symlink-escape realpath probe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_PROVIDER_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  isValidBareSlug,
  parseFullSlug,
  toFullSlugString,
  isSafeRelativeEntryPath,
  resolveWithinBase,
  isRealPathWithinBase,
} from '../../src/utils/skills-security.js';

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

describe('parseFullSlug — full slug parsing', () => {
  it('parses a valid full slug into provider / skillName / raw', () => {
    expect(parseFullSlug('@qianwen-ai/qianwen-text')).toEqual({
      provider: '@qianwen-ai',
      skillName: 'qianwen-text',
      raw: '@qianwen-ai/qianwen-text',
    });
  });

  it('accepts boundary lengths: 64-char provider and 128-char skillName', () => {
    const provider = '@' + 'p'.repeat(MAX_PROVIDER_LENGTH);
    const skillName = 's'.repeat(MAX_SKILL_NAME_LENGTH);
    const parsed = parseFullSlug(`${provider}/${skillName}`);
    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe(provider);
    expect(parsed?.skillName).toBe(skillName);
  });

  it('allows leading/trailing dash and underscore in both parts', () => {
    expect(parseFullSlug('@-ns-/_slug_')).toEqual({
      provider: '@-ns-',
      skillName: '_slug_',
      raw: '@-ns-/_slug_',
    });
  });

  it('accepts digits and underscore in the provider', () => {
    expect(parseFullSlug('@q_1/x')).toEqual({
      provider: '@q_1',
      skillName: 'x',
      raw: '@q_1/x',
    });
  });

  it('returns null for a bare slug without provider', () => {
    expect(parseFullSlug('qianwen-text')).toBeNull();
  });

  it('parses a full slug with uppercase provider', () => {
    expect(parseFullSlug('@QianWen/abc')).toEqual({
      provider: '@QianWen',
      skillName: 'abc',
      raw: '@QianWen/abc',
    });
  });

  it('parses a full slug with uppercase skillName', () => {
    expect(parseFullSlug('@ns/Abc')).toEqual({
      provider: '@ns',
      skillName: 'Abc',
      raw: '@ns/Abc',
    });
  });

  it('parses a mixed-case Base64-style slug', () => {
    expect(parseFullSlug('@bailian/skill_M2JmMTcyZjA4NzE5NDk0ZDhlMG')).toEqual({
      provider: '@bailian',
      skillName: 'skill_M2JmMTcyZjA4NzE5NDk0ZDhlMG',
      raw: '@bailian/skill_M2JmMTcyZjA4NzE5NDk0ZDhlMG',
    });
  });

  it.each([
    '',
    '@' + 'p'.repeat(MAX_PROVIDER_LENGTH + 1) + '/abc',
    '@ns/' + 's'.repeat(MAX_SKILL_NAME_LENGTH + 1),
    '@/slug',
    '@ns/',
    '/slug',
    'ns/slug',
    '@ns/slug/extra',
    '@ns//slug',
    '@ns/slug/',
    '@ns/abc.def',
    '@ns/abc def',
    '@ns/中文',
    '  @ns/slug',
    '@ns/con',
    '@ns/prn',
    '@ns/aux',
    '@ns/nul',
    '@ns/com1',
    '@ns/lpt1',
  ])('returns null for %j', (input) => {
    expect(parseFullSlug(input)).toBeNull();
  });
});

describe('isValidBareSlug — bare slug validation (new pattern)', () => {
  it.each([
    'qianwen-text',
    'a',
    'my_skill',
    'skill-2_x',
    '-slug-',
    '_slug_',
    'x'.repeat(MAX_SKILL_NAME_LENGTH),
    'QianWen',
    'A1',
    'skill_M2JmMTcyZjA4NzE5NDk0ZDhlMG',
  ])('accepts %s', (value) => {
    expect(isValidBareSlug(value)).toBe(true);
  });

  it.each([
    'x'.repeat(MAX_SKILL_NAME_LENGTH + 1),
    '',
    'has.dot',
    'has/slash',
    'has space',
    'has\\backslash',
    '../evil',
    '中文名',
    'con',
    'prn',
    'aux',
    'nul',
    'com1',
    'lpt1',
    'COM9',
    'LPT9',
  ])('rejects %j', (value) => {
    expect(isValidBareSlug(value)).toBe(false);
  });
});

describe('toFullSlugString — provider + skillName join', () => {
  it('joins provider and skillName with a single slash', () => {
    expect(toFullSlugString('@qianwen-ai', 'qianwen-text')).toBe('@qianwen-ai/qianwen-text');
  });

  it('round-trips through parseFullSlug', () => {
    expect(parseFullSlug(toFullSlugString('@a-b', 'c_d'))).toEqual({
      provider: '@a-b',
      skillName: 'c_d',
      raw: '@a-b/c_d',
    });
  });
});

describe('length constants', () => {
  it('exposes MAX_PROVIDER_LENGTH = 64 and MAX_SKILL_NAME_LENGTH = 128', () => {
    expect(MAX_PROVIDER_LENGTH).toBe(64);
    expect(MAX_SKILL_NAME_LENGTH).toBe(128);
  });
});
