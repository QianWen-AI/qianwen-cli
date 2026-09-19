/**
 * Tests for the skill metadata state manager — brand-derived file name,
 * tri-state directory assessment (absent / managed / unmanaged with reason),
 * schemaVersion boundaries, unknown-field tolerance, atomic writes and the
 * install outcome decision.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SKILL_META_SCHEMA_VERSION,
  skillMetaFileName,
  skillMetaPath,
  assessSkillDir,
  writeSkillMeta,
  decideInstallOutcome,
} from '../../../src/services/skills-state-manager.js';
import { site } from '../../../src/site.js';
import type { SkillMetadataV1 } from '../../../src/types/skills.js';

function validMeta(overrides: Partial<SkillMetadataV1> = {}): SkillMetadataV1 {
  return {
    schemaVersion: 1,
    slug: 'pdf-extractor',
    version: '1.2.0',
    sha256: 'ab'.repeat(32),
    installMethod: 'copy',
    installedAt: '2026-07-27T00:00:00.000Z',
    clientVersion: '1.5.0',
    ...overrides,
  };
}

let root: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qianwen-skillmeta-'));
  target = path.join(root, 'pdf-extractor');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('skillMetaFileName — brand derivation', () => {
  it('derives the hidden file name from site.key', () => {
    expect(skillMetaFileName()).toBe(`.${site.key}-skill.meta.json`);
  });

  it('joins the metadata path under the target directory', () => {
    expect(skillMetaPath(target)).toBe(path.join(target, skillMetaFileName()));
  });
});

describe('assessSkillDir — tri-state classification', () => {
  it('returns absent when the directory does not exist', () => {
    expect(assessSkillDir(target)).toEqual({ kind: 'absent' });
  });

  it('returns unmanaged/missing-metadata for a plain file occupant', () => {
    writeFileSync(target, 'not a directory');
    expect(assessSkillDir(target)).toEqual({ kind: 'unmanaged', reason: 'missing-metadata' });
  });

  it('returns unmanaged/missing-metadata for a symlink occupant', () => {
    mkdirSync(path.join(root, 'real'));
    symlinkSync(path.join(root, 'real'), target);
    expect(assessSkillDir(target)).toEqual({ kind: 'unmanaged', reason: 'missing-metadata' });
  });

  it('returns unmanaged/missing-metadata for a directory without the meta file', () => {
    mkdirSync(target);
    expect(assessSkillDir(target)).toEqual({ kind: 'unmanaged', reason: 'missing-metadata' });
  });

  it('returns unmanaged/metadata-parse-failed for invalid JSON', () => {
    mkdirSync(target);
    writeFileSync(skillMetaPath(target), '{ broken json');
    expect(assessSkillDir(target)).toEqual({
      kind: 'unmanaged',
      reason: 'metadata-parse-failed',
    });
  });

  it('returns unmanaged/metadata-parse-failed for a non-object payload', () => {
    mkdirSync(target);
    writeFileSync(skillMetaPath(target), '[1,2,3]');
    expect(assessSkillDir(target)).toEqual({
      kind: 'unmanaged',
      reason: 'metadata-parse-failed',
    });
  });

  it('returns unmanaged/schema-version-too-new above the supported version', () => {
    mkdirSync(target);
    writeFileSync(
      skillMetaPath(target),
      JSON.stringify({ ...validMeta(), schemaVersion: SKILL_META_SCHEMA_VERSION + 1 }),
    );
    expect(assessSkillDir(target)).toEqual({
      kind: 'unmanaged',
      reason: 'schema-version-too-new',
    });
  });

  it.each(['slug', 'version', 'sha256', 'installMethod'] as const)(
    'returns unmanaged/missing-required-fields when %s is missing',
    (field) => {
      mkdirSync(target);
      const meta: Record<string, unknown> = { ...validMeta() };
      delete meta[field];
      writeFileSync(skillMetaPath(target), JSON.stringify(meta));
      expect(assessSkillDir(target)).toEqual({
        kind: 'unmanaged',
        reason: 'missing-required-fields',
      });
    },
  );

  it('returns unmanaged/missing-required-fields for a non-integer schemaVersion', () => {
    mkdirSync(target);
    writeFileSync(
      skillMetaPath(target),
      JSON.stringify(validMeta({ schemaVersion: 1.5 as never })),
    );
    expect(assessSkillDir(target)).toEqual({
      kind: 'unmanaged',
      reason: 'missing-required-fields',
    });
  });

  it('returns unmanaged/missing-required-fields for an unknown installMethod', () => {
    mkdirSync(target);
    writeFileSync(
      skillMetaPath(target),
      JSON.stringify(validMeta({ installMethod: 'link' as never })),
    );
    expect(assessSkillDir(target)).toEqual({
      kind: 'unmanaged',
      reason: 'missing-required-fields',
    });
  });

  it('returns managed with the parsed record for valid metadata', () => {
    mkdirSync(target);
    writeFileSync(skillMetaPath(target), JSON.stringify(validMeta()));
    expect(assessSkillDir(target)).toEqual({ kind: 'managed', meta: validMeta() });
  });

  it('tolerates unknown extra fields (forward compatibility)', () => {
    mkdirSync(target);
    writeFileSync(
      skillMetaPath(target),
      JSON.stringify({ ...validMeta(), futureField: { nested: true } }),
    );
    const state = assessSkillDir(target);
    expect(state.kind).toBe('managed');
  });
});

describe('writeSkillMeta — atomic write', () => {
  it('writes pretty JSON with a trailing newline', () => {
    mkdirSync(target);
    writeSkillMeta(target, validMeta());

    const text = readFileSync(skillMetaPath(target), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(validMeta());
  });

  it('leaves no .tmp file behind', () => {
    mkdirSync(target);
    writeSkillMeta(target, validMeta());

    expect(readdirSync(target)).toEqual([skillMetaFileName()]);
  });

  it('round-trips through assessSkillDir', () => {
    mkdirSync(target);
    writeSkillMeta(target, validMeta());

    expect(assessSkillDir(target)).toEqual({ kind: 'managed', meta: validMeta() });
  });
});

describe('decideInstallOutcome — tri-state decision', () => {
  it('returns installed for an absent target', () => {
    expect(decideInstallOutcome({ kind: 'absent' }, '1.0.0')).toBe('installed');
  });

  it('returns noop when the managed version matches', () => {
    expect(decideInstallOutcome({ kind: 'managed', meta: validMeta() }, '1.2.0')).toBe('noop');
  });

  it('returns updated when the managed version differs', () => {
    expect(decideInstallOutcome({ kind: 'managed', meta: validMeta() }, '2.0.0')).toBe('updated');
  });
});

describe('assessSkillDir — provider read compatibility', () => {
  it('reads legacy metadata without provider as managed with provider undefined', () => {
    mkdirSync(target);
    writeFileSync(skillMetaPath(target), JSON.stringify(validMeta()));

    const state = assessSkillDir(target);

    expect(state.kind).toBe('managed');
    if (state.kind === 'managed') {
      expect(state.meta.provider).toBeUndefined();
    }
  });

  it('reads new metadata with provider as managed preserving the value', () => {
    mkdirSync(target);
    writeFileSync(skillMetaPath(target), JSON.stringify(validMeta({ provider: '@qianwen-ai' })));

    const state = assessSkillDir(target);

    expect(state.kind).toBe('managed');
    if (state.kind === 'managed') {
      expect(state.meta.provider).toBe('@qianwen-ai');
    }
  });

  it('drops a non-string provider value to undefined (defensive parse)', () => {
    mkdirSync(target);
    writeFileSync(skillMetaPath(target), JSON.stringify({ ...validMeta(), provider: 123 }));

    const state = assessSkillDir(target);

    expect(state.kind).toBe('managed');
    if (state.kind === 'managed') {
      expect(state.meta.provider).toBeUndefined();
    }
  });
});

describe('writeSkillMeta — provider write extension', () => {
  it('serializes provider into the JSON file when present', () => {
    mkdirSync(target);
    writeSkillMeta(target, validMeta({ provider: '@qianwen-ai' }));

    const parsed = JSON.parse(readFileSync(skillMetaPath(target), 'utf8'));
    expect(parsed.provider).toBe('@qianwen-ai');
  });

  it('omits the provider key entirely for legacy metadata', () => {
    mkdirSync(target);
    writeSkillMeta(target, validMeta());

    const parsed = JSON.parse(readFileSync(skillMetaPath(target), 'utf8'));
    expect('provider' in parsed).toBe(false);
  });

  it('round-trips provider through assessSkillDir', () => {
    mkdirSync(target);
    writeSkillMeta(target, validMeta({ provider: '@qianwen-ai' }));

    const state = assessSkillDir(target);
    expect(state).toEqual({ kind: 'managed', meta: validMeta({ provider: '@qianwen-ai' }) });
    if (state.kind === 'managed') {
      expect(state.meta.schemaVersion).toBe(1);
    }
  });
});
