/**
 * Tests for safeRemove — guarded deletion for the skills install engine:
 * real-path boundary containment, kind-specific sentinels (staging prefix,
 * temp-file shape, managed metadata + slug match), idempotence for missing
 * paths and the three successful removal kinds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeRemove, skillStagingPrefix } from '../../../src/services/skills-removal.js';
import { writeSkillMeta } from '../../../src/services/skills-state-manager.js';
import type { SkillMetadataV1 } from '../../../src/types/skills.js';
import { canCreateSymlinks } from '../../helpers/symlink-capability.js';

// Pass-through mock boundary: tests must never touch real system directories,
// so specific real paths are declared "protected" on demand while every other
// path falls through to the actual blocklist implementation.
const { forcedSystemRoots } = vi.hoisted(() => ({ forcedSystemRoots: new Set<string>() }));
vi.mock('../../../src/utils/system-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/system-paths.js')>();
  return {
    ...actual,
    isSystemRootPath: (realPath: string) =>
      forcedSystemRoots.has(realPath) || actual.isSystemRootPath(realPath),
  };
});

let root: string;
let baseDir: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qianwen-removal-'));
  baseDir = path.join(root, 'skills');
  outside = path.join(root, 'outside');
  mkdirSync(baseDir);
  mkdirSync(outside);
});

afterEach(() => {
  forcedSystemRoots.clear();
  rmSync(root, { recursive: true, force: true });
});

function makeStaging(parent: string, suffix = 'abc123'): string {
  const dir = path.join(parent, `${skillStagingPrefix()}${suffix}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'skill.zip'), 'zip-bytes');
  return dir;
}

function makeManaged(slug: string, provider?: string, dirName?: string): string {
  const dir = path.join(baseDir, dirName ?? slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '# skill');
  const meta: SkillMetadataV1 = {
    schemaVersion: 1,
    slug,
    ...(provider ? { provider } : {}),
    version: '1.0.0',
    sha256: 'aa'.repeat(32),
    installMethod: 'copy',
    installedAt: '2026-07-01T00:00:00.000Z',
    clientVersion: '1.5.0',
  };
  writeSkillMeta(dir, meta);
  return dir;
}

describe('safeRemove — boundary check rejections', () => {
  it('rejects a path outside baseDir even when its name carries the staging prefix', () => {
    const evil = makeStaging(outside);

    expect(() => safeRemove(evil, { baseDir, expectKind: 'staging' })).toThrowError(
      expect.objectContaining({ code: 'REMOVAL_REFUSED' }),
    );
    expect(existsSync(evil)).toBe(true);
  });

  it('rejects baseDir itself', () => {
    expect(() => safeRemove(baseDir, { baseDir, expectKind: 'staging' })).toThrowError(
      expect.objectContaining({ code: 'REMOVAL_REFUSED' }),
    );
    expect(existsSync(baseDir)).toBe(true);
  });

  // Symlink creation needs SeCreateSymbolicLinkPrivilege / Developer Mode on
  // Windows; skip where the scenario cannot be set up at all.
  it.skipIf(!canCreateSymlinks())('rejects removal escaping baseDir via a symlink', () => {
    writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    const link = path.join(baseDir, `${skillStagingPrefix()}via-link`);
    symlinkSync(outside, link);

    expect(() => safeRemove(link, { baseDir, expectKind: 'staging' })).toThrowError(
      expect.objectContaining({ code: 'REMOVAL_REFUSED' }),
    );
    expect(existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it('rejects removal when baseDir does not exist', () => {
    const target = makeStaging(outside);

    expect(() =>
      safeRemove(target, { baseDir: path.join(root, 'missing'), expectKind: 'staging' }),
    ).toThrowError(expect.objectContaining({ code: 'REMOVAL_REFUSED' }));
    expect(existsSync(target)).toBe(true);
  });
});

describe('safeRemove — protected system directory rejections', () => {
  it('rejects when the base directory realpath is a protected system root', () => {
    const staging = makeStaging(baseDir);
    forcedSystemRoots.add(realpathSync(baseDir));

    expect(() => safeRemove(staging, { baseDir, expectKind: 'staging' })).toThrowError(
      expect.objectContaining({
        code: 'REMOVAL_REFUSED',
        message: expect.stringContaining('protected system directory'),
      }),
    );
    expect(existsSync(staging)).toBe(true);
  });

  it('rejects when the target realpath is a protected system root', () => {
    const staging = makeStaging(baseDir);
    forcedSystemRoots.add(realpathSync(staging));

    expect(() => safeRemove(staging, { baseDir, expectKind: 'staging' })).toThrowError(
      expect.objectContaining({
        code: 'REMOVAL_REFUSED',
        message: expect.stringContaining('protected system directory'),
      }),
    );
    expect(existsSync(staging)).toBe(true);
  });
});

describe('safeRemove — sentinel check rejections', () => {
  it('staging: rejects a directory without the staging prefix', () => {
    const dir = path.join(baseDir, 'pdf-extractor');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'SKILL.md'), '# skill');

    expect(() => safeRemove(dir, { baseDir, expectKind: 'staging' })).toThrowError(
      expect.objectContaining({ code: 'REMOVAL_REFUSED' }),
    );
    expect(existsSync(dir)).toBe(true);
  });

  it('temp-file: rejects a directory target', () => {
    const staging = makeStaging(baseDir);
    const inner = path.join(staging, 'content');
    mkdirSync(inner);

    expect(() => safeRemove(inner, { baseDir, expectKind: 'temp-file' })).toThrowError(
      expect.objectContaining({ code: 'REMOVAL_REFUSED' }),
    );
    expect(existsSync(inner)).toBe(true);
  });

  it('temp-file: rejects a file whose parent is not a staging directory', () => {
    const file = path.join(baseDir, 'stray.zip');
    writeFileSync(file, 'zip-bytes');

    expect(() => safeRemove(file, { baseDir, expectKind: 'temp-file' })).toThrowError(
      expect.objectContaining({ code: 'REMOVAL_REFUSED' }),
    );
    expect(existsSync(file)).toBe(true);
  });

  it('managed-skill: rejects a directory without valid metadata', () => {
    const dir = path.join(baseDir, 'pdf-extractor');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'user-file.txt'), 'precious');

    expect(() =>
      safeRemove(dir, { baseDir, expectKind: 'managed-skill', expectedSlug: 'pdf-extractor' }),
    ).toThrowError(expect.objectContaining({ code: 'REMOVAL_REFUSED' }));
    expect(existsSync(path.join(dir, 'user-file.txt'))).toBe(true);
  });

  it('managed-skill: rejects a directory whose metadata slug does not match', () => {
    const dir = makeManaged('other-skill');

    expect(() =>
      safeRemove(dir, { baseDir, expectKind: 'managed-skill', expectedSlug: 'pdf-extractor' }),
    ).toThrowError(expect.objectContaining({ code: 'REMOVAL_REFUSED' }));
    expect(existsSync(dir)).toBe(true);
  });

  it('managed-skill: rejects a call missing expectedSlug', () => {
    const dir = makeManaged('pdf-extractor');

    expect(() => safeRemove(dir, { baseDir, expectKind: 'managed-skill' })).toThrowError(
      expect.objectContaining({ code: 'REMOVAL_REFUSED' }),
    );
    expect(existsSync(dir)).toBe(true);
  });
});

describe('safeRemove — idempotence', () => {
  it('returns silently without throwing when the target does not exist', () => {
    const missing = path.join(baseDir, `${skillStagingPrefix()}gone`);

    expect(() => safeRemove(missing, { baseDir, expectKind: 'staging' })).not.toThrow();
    expect(() => safeRemove(missing, { baseDir, expectKind: 'temp-file' })).not.toThrow();
    expect(() =>
      safeRemove(missing, { baseDir, expectKind: 'managed-skill', expectedSlug: 'x' }),
    ).not.toThrow();
  });
});

describe('safeRemove — successful removals', () => {
  it('staging: recursively removes a valid staging directory', () => {
    const staging = makeStaging(baseDir);
    mkdirSync(path.join(staging, 'content'));
    writeFileSync(path.join(staging, 'content', 'SKILL.md'), '# skill');

    safeRemove(staging, { baseDir, expectKind: 'staging' });

    expect(existsSync(staging)).toBe(false);
    expect(existsSync(baseDir)).toBe(true);
  });

  it('temp-file: removes a single file inside staging and keeps the directory', () => {
    const staging = makeStaging(baseDir);
    const file = path.join(staging, 'skill.zip');

    safeRemove(file, { baseDir, expectKind: 'temp-file' });

    expect(existsSync(file)).toBe(false);
    expect(existsSync(staging)).toBe(true);
  });

  it('managed-skill: recursively removes a managed directory when the slug matches', () => {
    const dir = makeManaged('pdf-extractor');

    safeRemove(dir, { baseDir, expectKind: 'managed-skill', expectedSlug: 'pdf-extractor' });

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(baseDir)).toBe(true);
  });
});

describe('safeRemove — managed-skill at a full-slug flat path', () => {
  it('removes a managed @ns/slug directory when the full slug matches', () => {
    const dir = makeManaged('@qianwen-ai/pdf-extractor', '@qianwen-ai', 'pdf-extractor');

    safeRemove(dir, {
      baseDir,
      expectKind: 'managed-skill',
      expectedSlug: '@qianwen-ai/pdf-extractor',
    });

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(baseDir)).toBe(true);
  });

  it('rejects when the metadata slug does not match the expected full slug', () => {
    const dir = makeManaged('@qianwen-ai/other-skill', '@qianwen-ai', 'other-skill');

    expect(() =>
      safeRemove(dir, {
        baseDir,
        expectKind: 'managed-skill',
        expectedSlug: '@qianwen-ai/pdf-extractor',
      }),
    ).toThrowError(expect.objectContaining({ code: 'REMOVAL_REFUSED' }));
    expect(existsSync(dir)).toBe(true);
  });
});
