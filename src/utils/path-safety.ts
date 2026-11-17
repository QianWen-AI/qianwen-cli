/** Shared path containment and archive entry validation. */
import fs from 'node:fs';
import path from 'node:path';

/**
 * True when an archive entry path is safe to materialize under an extraction root:
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
