/**
 * Skill metadata state manager — reads, validates and atomically writes the
 * per-skill metadata file that marks a directory as CLI-managed.
 *
 * The file name is brand-derived from site config (`.qianwen-skill.meta.json`
 * for this site). Reads are strict: a parse failure, an unsupported (newer)
 * schemaVersion or a missing required field classifies the directory as
 * unmanaged and the installer refuses to touch it. Unknown extra fields are
 * tolerated for forward compatibility. Writes are atomic (`.tmp` + rename)
 * and deferred by the caller until deployment has fully succeeded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { site } from '../site.js';
import type { SkillDirState, SkillInstallOutcome, SkillMetadataV1 } from '../types/skills.js';

/** Highest metadata schema version this CLI understands. */
export const SKILL_META_SCHEMA_VERSION = 1;

const REQUIRED_FIELDS = ['slug', 'version', 'sha256', 'installMethod'] as const;

/** Brand-derived metadata file name (hidden file inside the skill directory). */
export function skillMetaFileName(): string {
  return `.${site.key}-skill.meta.json`;
}

export function skillMetaPath(targetDir: string): string {
  return path.join(targetDir, skillMetaFileName());
}

/**
 * Classify an install target directory: absent / managed / unmanaged.
 * A newer-than-supported schemaVersion is reported distinctly so callers can
 * suggest upgrading the CLI instead of a generic conflict message.
 */
export function assessSkillDir(targetDir: string): SkillDirState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetDir);
  } catch {
    return { kind: 'absent' };
  }
  // A non-directory occupant (file or symlink) is never CLI-managed.
  if (!stat.isDirectory()) {
    return { kind: 'unmanaged', reason: 'missing-metadata' };
  }

  let rawText: string;
  try {
    rawText = fs.readFileSync(skillMetaPath(targetDir), 'utf8');
  } catch {
    return { kind: 'unmanaged', reason: 'missing-metadata' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { kind: 'unmanaged', reason: 'metadata-parse-failed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unmanaged', reason: 'metadata-parse-failed' };
  }

  const record = parsed as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return { kind: 'unmanaged', reason: 'missing-required-fields' };
  }
  if (schemaVersion > SKILL_META_SCHEMA_VERSION) {
    return { kind: 'unmanaged', reason: 'schema-version-too-new' };
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      return { kind: 'unmanaged', reason: 'missing-required-fields' };
    }
  }

  // v1 knows a single install method; anything else is not interpretable.
  if (record.installMethod !== 'copy') {
    return { kind: 'unmanaged', reason: 'missing-required-fields' };
  }

  const meta: SkillMetadataV1 = {
    schemaVersion: 1,
    slug: record.slug as string,
    version: record.version as string,
    sha256: record.sha256 as string,
    installMethod: 'copy',
    installedAt: typeof record.installedAt === 'string' ? record.installedAt : '',
    clientVersion: typeof record.clientVersion === 'string' ? record.clientVersion : '',
  };
  return { kind: 'managed', meta };
}

/**
 * Atomic metadata write: serialize to a sibling `.tmp` file, then rename over
 * the final path. The caller invokes this only after deployment succeeded.
 */
export function writeSkillMeta(targetDir: string, meta: SkillMetadataV1): void {
  const finalPath = skillMetaPath(targetDir);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Tri-state decision for a managed/absent target given the version about to
 * be installed: same version → noop, different recorded version → updated,
 * no managed record → installed (fresh install or repair of a broken dir).
 */
export function decideInstallOutcome(
  state: SkillDirState,
  targetVersion: string,
): SkillInstallOutcome {
  if (state.kind === 'managed') {
    return state.meta.version === targetVersion ? 'noop' : 'updated';
  }
  return 'installed';
}
