/**
 * Tests for the protected-system-directory blocklist. Matching must be
 * exact-equality only: system roots themselves are hits, while any child
 * path (a legitimate work area) must pass. Non-native platform lists are
 * exercised through the injectable policy; the darwin symlink normalization
 * (/etc -> /private/etc) is asserted against the real filesystem.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  isSystemRootPath,
  LINUX_SYSTEM_ROOTS,
  DARWIN_SYSTEM_ROOTS,
  type SystemPathPolicy,
} from '../../src/utils/system-paths.js';

const linux: SystemPathPolicy = { platform: 'linux', env: {} };
const darwin: SystemPathPolicy = { platform: 'darwin', env: {} };
const winEnv: NodeJS.ProcessEnv = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'D:\\Users\\alice',
};
const win32: SystemPathPolicy = { platform: 'win32', env: winEnv };

describe('isSystemRootPath — linux list (injected platform)', () => {
  it.each([...LINUX_SYSTEM_ROOTS])('flags %s as a protected root', (root) => {
    expect(isSystemRootPath(root, linux)).toBe(true);
  });

  it('normalizes a trailing separator before comparing', () => {
    expect(isSystemRootPath('/usr/', linux)).toBe(true);
  });

  it.each(['/tmp', '/home', '/opt'])('leaves the work-area container %s unprotected', (dir) => {
    expect(isSystemRootPath(dir, linux)).toBe(false);
  });

  it.each(['/home/alice', '/home/alice/skills', '/usr/local', '/var/lib/data'])(
    'passes the child path %s (no subtree matching)',
    (child) => {
      expect(isSystemRootPath(child, linux)).toBe(false);
    },
  );
});

describe('isSystemRootPath — darwin list (injected platform)', () => {
  it.each([...DARWIN_SYSTEM_ROOTS])('flags %s as a protected root', (root) => {
    expect(isSystemRootPath(root, darwin)).toBe(true);
  });

  it.each(['/Users', '/tmp', '/opt/homebrew'])('leaves %s unprotected', (dir) => {
    expect(isSystemRootPath(dir, darwin)).toBe(false);
  });

  it.each(['/Users/alice/skills', '/Library/Caches/x', '/private/tmp/work'])(
    'passes the child path %s (no subtree matching)',
    (child) => {
      expect(isSystemRootPath(child, darwin)).toBe(false);
    },
  );

  it.skipIf(!fs.existsSync('/etc'))(
    'flags the realpath form of a listed symlinked entry (symlink normalization)',
    () => {
      // On macOS this resolves /etc to /private/etc; on Linux it stays /etc.
      // Windows has no /etc, so the realpath probe cannot run there.
      const realEtc = fs.realpathSync('/etc');
      expect(isSystemRootPath(realEtc, darwin)).toBe(true);
      const realVar = fs.realpathSync('/var');
      expect(isSystemRootPath(realVar, darwin)).toBe(true);
    },
  );
});

describe('isSystemRootPath — windows logic (injected platform)', () => {
  it.each(['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'])(
    'flags the environment-derived root %s',
    (root) => {
      expect(isSystemRootPath(root, win32)).toBe(true);
    },
  );

  it('compares case-insensitively and ignores trailing separators', () => {
    expect(isSystemRootPath('c:\\WINDOWS\\', win32)).toBe(true);
    expect(isSystemRootPath('C:\\PROGRAM FILES', win32)).toBe(true);
  });

  it.each(['C:\\', 'd:\\', 'E:/'])('flags any bare drive root %s', (root) => {
    expect(isSystemRootPath(root, win32)).toBe(true);
  });

  it('flags Users\\Public on the profile drive derived from USERPROFILE', () => {
    expect(isSystemRootPath('D:\\Users\\Public', win32)).toBe(true);
  });

  it('keeps the fixed fallbacks when environment variables are unset', () => {
    const bare: SystemPathPolicy = { platform: 'win32', env: {} };
    expect(isSystemRootPath('C:\\Windows', bare)).toBe(true);
    expect(isSystemRootPath('C:\\Users\\Public', bare)).toBe(true);
    expect(isSystemRootPath('C:\\Recovery', bare)).toBe(true);
  });

  it.each(['C:\\Users\\alice\\skills', 'C:\\Windows\\Temp', 'D:\\work'])(
    'passes the child path %s (no subtree matching)',
    (child) => {
      expect(isSystemRootPath(child, win32)).toBe(false);
    },
  );
});

describe('isSystemRootPath — default policy (current platform)', () => {
  it('uses process.platform and process.env by default', () => {
    const nativeRoot = process.platform === 'win32' ? 'C:\\' : '/';
    expect(isSystemRootPath(nativeRoot)).toBe(true);
  });

  it('passes the workspace directory itself', () => {
    expect(isSystemRootPath(fs.realpathSync(process.cwd()))).toBe(false);
  });
});
