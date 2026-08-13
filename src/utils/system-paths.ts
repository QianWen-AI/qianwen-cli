/**
 * Blocklist of protected system root directories for the skills removal
 * guards. Matching is exact-equality only: a path hits when its normalized
 * real path equals a list entry — child paths (e.g. /Users/x/skills, /home/x)
 * always pass, because subtree matching would block legitimate work areas.
 */

import fs from 'node:fs';
import path from 'node:path';

export const LINUX_SYSTEM_ROOTS: readonly string[] = [
  '/',
  '/bin',
  '/sbin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/libx32',
  '/proc',
  '/run',
  '/root',
  '/srv',
  '/sys',
  '/usr',
  '/var',
];

export const DARWIN_SYSTEM_ROOTS: readonly string[] = [
  '/',
  '/bin',
  '/sbin',
  '/etc',
  '/usr',
  '/var',
  '/System',
  '/Library',
  '/Applications',
  '/Volumes',
  '/private',
  '/cores',
];

/** Injectable platform/environment so non-native lists stay unit-testable. */
export interface SystemPathPolicy {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/**
 * True when `realPath` (already realpath-normalized by the caller) is exactly
 * a protected system root directory for the given platform.
 */
export function isSystemRootPath(
  realPath: string,
  policy: SystemPathPolicy = { platform: process.platform, env: process.env },
): boolean {
  if (policy.platform === 'win32') {
    return isWindowsSystemRoot(realPath, policy.env);
  }
  const normalized = stripTrailingPosixSep(path.posix.normalize(realPath));
  const roots = policy.platform === 'darwin' ? darwinSystemRoots() : linuxSystemRoots();
  return roots.has(normalized);
}

function stripTrailingPosixSep(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

let linuxRootsCache: Set<string> | undefined;
function linuxSystemRoots(): Set<string> {
  linuxRootsCache ??= new Set(LINUX_SYSTEM_ROOTS);
  return linuxRootsCache;
}

let darwinRootsCache: Set<string> | undefined;
function darwinSystemRoots(): Set<string> {
  if (!darwinRootsCache) {
    const roots = new Set(DARWIN_SYSTEM_ROOTS);
    // On macOS /etc and /var are symlinks into /private/*, so callers handing
    // us realpath output present the resolved form; guard both spellings.
    for (const entry of DARWIN_SYSTEM_ROOTS) {
      try {
        roots.add(fs.realpathSync(entry));
      } catch {
        // Entry absent on this machine; its literal form still guards it.
      }
    }
    darwinRootsCache = roots;
  }
  return darwinRootsCache;
}

function isWindowsSystemRoot(realPath: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = normalizeWindowsPath(realPath);
  // Any bare drive root (X:\) is protected regardless of the environment.
  if (/^[a-z]:$/.test(normalized)) return true;
  return windowsSystemRoots(env).has(normalized);
}

// Lowercased because Windows paths are case-insensitive.
function normalizeWindowsPath(p: string): string {
  let normalized = path.win32.normalize(p).toLowerCase();
  while (normalized.length > 1 && (normalized.endsWith('\\') || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function windowsSystemRoots(env: NodeJS.ProcessEnv): Set<string> {
  const roots = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (candidate) roots.add(normalizeWindowsPath(candidate));
  };
  add(env.SystemRoot);
  add(env.ProgramFiles);
  add(env['ProgramFiles(x86)']);
  add(env.ProgramData);
  const profileDrive = env.USERPROFILE ? /^[a-zA-Z]:/.exec(env.USERPROFILE)?.[0] : undefined;
  add(profileDrive ? `${profileDrive}\\Users\\Public` : undefined);
  // Fixed fallbacks keep coverage when the environment variables are unset.
  add('C:\\Windows');
  add('C:\\Program Files');
  add('C:\\Program Files (x86)');
  add('C:\\ProgramData');
  add('C:\\Users\\Public');
  add('C:\\Recovery');
  return roots;
}
