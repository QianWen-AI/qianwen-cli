/**
 * Symlink capability probe for tests that exercise symlink-escape guards.
 *
 * Creating symbolic links on Windows requires SeCreateSymbolicLinkPrivilege
 * or Developer Mode; unprivileged accounts get EPERM. The probe detects the
 * capability once per worker so affected tests skip instead of failing on
 * hosts where the scenario is physically impossible to set up.
 */
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let cached: boolean | undefined;

const SYMLINK_UNAVAILABLE_CODES = new Set(['EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

function isSymlinkUnavailable(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && SYMLINK_UNAVAILABLE_CODES.has(code);
}

export function canCreateSymlinks(): boolean {
  if (cached !== undefined) return cached;
  let probe: string | undefined;
  let result: boolean | undefined;
  let failure: unknown;
  try {
    probe = mkdtempSync(path.join(tmpdir(), 'qianwen-symlink-probe-'));
    mkdirSync(path.join(probe, 'target'));
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    result = true;
  } catch (error) {
    if (isSymlinkUnavailable(error)) result = false;
    else failure = error;
  }
  if (probe) {
    try {
      rmSync(probe, { recursive: true, force: true });
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw new AggregateError([failure, cleanupError], 'Symlink capability probe failed');
      }
      throw cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
  cached = result;
  return cached;
}
