/**
 * Guarded deletion for the skills install engine. Every removal must pass
 * real-path containment inside the skills base directory plus a sentinel
 * check specific to what the caller expects to delete — a staging area, a
 * temp file inside staging, or a CLI-managed skill directory. Anything that
 * fails a check is refused; nothing is ever deleted "just in case".
 */

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { isRealPathWithinBase } from '../utils/skills-security.js';
import { isSystemRootPath } from '../utils/system-paths.js';
import { assessSkillDir } from './skills-state-manager.js';
import { site } from '../site.js';

/** Single source of the staging directory prefix (dot-hidden, brand-derived). */
export function skillStagingPrefix(): string {
  return `.${site.key}-skill-staging-`;
}

export type SkillRemovalKind = 'staging' | 'temp-file' | 'managed-skill';

export interface SafeRemoveOptions {
  /** Skills base directory the candidate must live strictly inside of. */
  baseDir: string;
  expectKind: SkillRemovalKind;
  /** Required for 'managed-skill'; must match the on-disk metadata slug. */
  expectedSlug?: string;
}

/**
 * Delete `candidate` after all guards pass. A missing candidate is a no-op
 * (preserves rmSync `force` semantics for cleanup paths); any guard failure
 * throws a CliError and leaves the filesystem untouched.
 */
export function safeRemove(candidate: string, options: SafeRemoveOptions): void {
  const target = path.resolve(candidate);
  const base = path.resolve(options.baseDir);

  if (!fs.existsSync(target)) return;

  let realBase: string;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    refuse(target, 'base directory does not exist');
  }
  if (!isRealPathWithinBase(base, target)) {
    refuse(target, 'path escapes the skills base directory');
  }
  const realTarget = fs.realpathSync(target);
  if (isSystemRootPath(realBase) || isSystemRootPath(realTarget)) {
    refuse(target, 'path is a protected system directory');
  }
  if (realTarget === realBase) {
    refuse(target, 'path is the skills base directory itself');
  }

  switch (options.expectKind) {
    case 'staging':
      assertStagingDir(target);
      fs.rmSync(target, { recursive: true, force: true });
      return;
    case 'temp-file':
      if (!fs.lstatSync(target).isFile()) {
        refuse(target, 'expected a regular file');
      }
      assertStagingDir(path.dirname(target));
      fs.rmSync(target, { force: true });
      return;
    case 'managed-skill': {
      if (!options.expectedSlug) {
        refuse(target, 'expectedSlug is required for managed-skill removal');
      }
      const state = assessSkillDir(target);
      if (state.kind !== 'managed') {
        refuse(target, 'directory is not managed by this CLI');
      }
      if (state.meta.slug !== options.expectedSlug) {
        refuse(
          target,
          `metadata slug '${state.meta.slug}' does not match expected '${options.expectedSlug}'`,
        );
      }
      fs.rmSync(target, { recursive: true, force: true });
      return;
    }
  }
}

// lstat (not stat) so a symlink masquerading as a staging directory is refused
// instead of having its target contents removed.
function assertStagingDir(dir: string): void {
  if (!fs.lstatSync(dir).isDirectory()) {
    refuse(dir, 'staging path is not a directory');
  }
  if (!path.basename(dir).startsWith(skillStagingPrefix())) {
    refuse(dir, 'directory name lacks the staging prefix');
  }
}

function refuse(target: string, reason: string): never {
  throw new CliError({
    code: 'REMOVAL_REFUSED',
    message: `Refusing to remove '${target}': ${reason}.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}
