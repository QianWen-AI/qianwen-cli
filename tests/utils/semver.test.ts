/**
 * Tests for the strict semver helpers backing the install downgrade warning:
 * conservative parsing (unparsable input → null, never a guess) and the
 * strictly-greater comparison used to detect a local version newer than hub.
 */
import { describe, it, expect } from 'vitest';
import { parseSemVer, isSemVerGreater } from '../../src/utils/semver.js';

describe('parseSemVer', () => {
  it('parses a plain dotted version', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('accepts an optional leading v and surrounding whitespace', () => {
    expect(parseSemVer('v2.0.1')).toEqual({ major: 2, minor: 0, patch: 1 });
    expect(parseSemVer('  1.0.0  ')).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('defaults missing segments to 0', () => {
    expect(parseSemVer('2')).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(parseSemVer('1.4')).toEqual({ major: 1, minor: 4, patch: 0 });
  });

  it('ignores prerelease and build suffixes', () => {
    expect(parseSemVer('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer('1.2.3+build.5')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it.each(['', '   ', 'abc', '1.x.0', 'release-2026', '1..2', '.1.2', 'v'])(
    'returns null for unparsable input %j',
    (bad) => {
      expect(parseSemVer(bad)).toBeNull();
    },
  );
});

describe('isSemVerGreater', () => {
  it('detects a strictly greater version on each segment', () => {
    expect(isSemVerGreater('2.0.0', '1.9.9')).toBe(true);
    expect(isSemVerGreater('1.3.0', '1.2.9')).toBe(true);
    expect(isSemVerGreater('1.2.4', '1.2.3')).toBe(true);
  });

  it('returns false when lower or equal', () => {
    expect(isSemVerGreater('1.2.3', '2.0.0')).toBe(false);
    expect(isSemVerGreater('1.2.3', '1.2.3')).toBe(false);
    expect(isSemVerGreater('v1.2.3', '1.2.3')).toBe(false);
  });

  it('normalizes missing segments before comparing', () => {
    expect(isSemVerGreater('1.2', '1.2.0')).toBe(false);
    expect(isSemVerGreater('2', '1.9.9')).toBe(true);
  });

  it('returns false when either side is unparsable (one-sided)', () => {
    expect(isSemVerGreater('not-a-version', '1.0.0')).toBe(false);
    expect(isSemVerGreater('2.0.0', 'not-a-version')).toBe(false);
    expect(isSemVerGreater('', '1.0.0')).toBe(false);
    expect(isSemVerGreater('2.0.0', '')).toBe(false);
  });

  it('returns false when both sides are unparsable', () => {
    expect(isSemVerGreater('alpha', 'beta')).toBe(false);
  });
});
