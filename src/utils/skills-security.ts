/**
 * Path & slug safety helpers for the skills install engine.
 *
 * Every directory the installer writes to or removes must pass through these
 * checks: slug allow-list, full-slug (`@ns/name`) parsing, base-directory
 * boundary containment (separator aware), traversal rejection and
 * symlink-escape detection. The helpers are pure except for the realpath
 * probe, which consults the filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';

export const MAX_PROVIDER_LENGTH = 64;
export const MAX_SKILL_NAME_LENGTH = 128;
export const MAX_FULL_SLUG_LENGTH = MAX_PROVIDER_LENGTH + MAX_SKILL_NAME_LENGTH + 2;

// Lowercase letters/digits with hyphens or underscores; no dots, no separators,
// so a valid slug can never traverse or hide relative segments.
const BARE_SLUG_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{1,${MAX_SKILL_NAME_LENGTH}}$`);

export const PROVIDER_PATTERN = new RegExp(`^@[a-zA-Z0-9_-]{1,${MAX_PROVIDER_LENGTH}}$`);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED.test(name);
}

export interface FullSlug {
  /** Provider ID with the leading `@`, e.g. `"@qianwen-ai"`. */
  provider: string;
  skillName: string;
  raw: string;
}

/** True when `value` is a valid bare slug (lowercase, 1-128). */
export function isValidBareSlug(value: string): boolean {
  return (
    typeof value === 'string' && BARE_SLUG_PATTERN.test(value) && !isWindowsReservedName(value)
  );
}

/** Join a provider (`@ns`) and a skill name into the full-slug string. */
export function toFullSlugString(provider: string, skillName: string): string {
  return `${provider}/${skillName}`;
}

/** Parse `@ns/name`; returns null for a bare slug or malformed input. */
export function parseFullSlug(value: string): FullSlug | null {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  if (slash <= 0) return null;
  const provider = value.slice(0, slash);
  const skillName = value.slice(slash + 1);
  if (!skillName || skillName.includes('/')) return null;
  if (!PROVIDER_PATTERN.test(provider)) return null;
  if (!BARE_SLUG_PATTERN.test(skillName)) return null;
  if (isWindowsReservedName(skillName)) return null;
  return { provider, skillName, raw: value };
}

/**
 * True when a zip entry path is safe to materialize under an extraction root:
 * relative, forward-slash separated, free of drive letters, NUL bytes,
 * backslashes and `.`/`..` segments.
 */
export function isSafeRelativeEntryPath(entryPath: string): boolean {
  if (typeof entryPath !== 'string' || entryPath.length === 0) return false;
  if (entryPath.includes('\0') || entryPath.includes('\\')) return false;
  if (entryPath.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(entryPath)) return false;
  const segments = entryPath.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // Only the last segment may be empty (trailing '/' on directory entries).
    if (segment === '' && i !== segments.length - 1) return false;
    if (segment === '.' || segment === '..') return false;
  }
  return true;
}

/**
 * Resolve `relPath` against `baseDir` and enforce the boundary: the resolved
 * path must be the base itself or live strictly inside it (separator-aware,
 * so `/base-evil` never passes for base `/base`). Returns the resolved
 * absolute path, or null when the boundary is violated.
 */
export function resolveWithinBase(baseDir: string, relPath: string): string | null {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relPath);
  if (target === base) return target;
  return target.startsWith(base + path.sep) ? target : null;
}

/**
 * Symlink-escape guard: walk the already-existing prefix of `candidate` and
 * verify its real path still lives inside the real path of `baseDir`. Catches
 * a symlinked intermediate directory redirecting writes outside the base.
 * `baseDir` must exist.
 */
export function isRealPathWithinBase(baseDir: string, candidate: string): boolean {
  const realBase = fs.realpathSync(baseDir);
  let probe = path.resolve(candidate);
  // Find the deepest existing ancestor of the candidate path.
  while (!fs.existsSync(probe)) {
    try {
      fs.lstatSync(probe);
      return false;
    } catch {
      // Path truly absent — keep climbing.
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  return realProbe === realBase || realProbe.startsWith(realBase + path.sep);
}
