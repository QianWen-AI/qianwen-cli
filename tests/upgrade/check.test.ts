/**
 * Unit tests for src/upgrade/check.ts — GitHub Release version detection.
 *
 * Exercises the four branches that matter:
 *   1. Happy path: fetch returns a release, version parsed and compared.
 *   2. Auth: GITHUB_TOKEN / GH_TOKEN surfaces as an Authorization header.
 *   3. Channel detection: runtime (Bun vs Node) + platform (win32 vs *) decide
 *      whether to point at npm, install.sh or install.ps1.
 *   4. Silent failure: network error / non-2xx / bad JSON all collapse to null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetch } from '../helpers/http-mock.js';
import {
  compareVersions,
  fetchLatestVersion,
  detectChannel,
  detectNodePackageManager,
  getUpgradeHint,
} from '../../src/upgrade/check.js';

describe('compareVersions', () => {
  it('returns -1 when a < b', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.2.3', '2.0.0')).toBe(-1);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });

  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('ignores leading v prefix and prerelease suffix', () => {
    expect(compareVersions('v1.2.3', 'v1.2.3-beta.1')).toBe(0);
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareVersions('v1.0.0', 'v2.0.0')).toBe(-1);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });
});

describe('fetchLatestVersion', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
  });

  it('returns the version string stripped of leading v', async () => {
    const mock = mockFetch({
      'api.github.com/repos/QianWen-AI/qianwen-cli/releases/latest': {
        body: { tag_name: 'v1.2.3' },
      },
    });
    try {
      const result = await fetchLatestVersion();
      expect(result).toBe('1.2.3');
      expect(mock.calls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  it('does not attach Authorization header when no token is set', async () => {
    const mock = mockFetch({
      'api.github.com': { body: { tag_name: 'v1.0.0' } },
    });
    try {
      await fetchLatestVersion();
      const req = mock.lastRequest('api.github.com');
      expect(req?.headers.Authorization).toBeUndefined();
    } finally {
      mock.restore();
    }
  });

  it('attaches Authorization header when GITHUB_TOKEN is set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token_123';
    const mock = mockFetch({
      'api.github.com': { body: { tag_name: 'v1.0.0' } },
    });
    try {
      await fetchLatestVersion();
      const req = mock.lastRequest('api.github.com');
      expect(req?.headers.Authorization).toBe('Bearer ghp_test_token_123');
    } finally {
      mock.restore();
    }
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is absent', async () => {
    process.env.GH_TOKEN = 'gh_fallback_token';
    const mock = mockFetch({
      'api.github.com': { body: { tag_name: 'v1.0.0' } },
    });
    try {
      await fetchLatestVersion();
      const req = mock.lastRequest('api.github.com');
      expect(req?.headers.Authorization).toBe('Bearer gh_fallback_token');
    } finally {
      mock.restore();
    }
  });

  it('returns null on non-2xx response (silent)', async () => {
    const mock = mockFetch({
      'api.github.com': { body: { message: 'rate limited' }, init: { status: 403 } },
    });
    try {
      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it('returns null when response has no tag_name', async () => {
    const mock = mockFetch({
      'api.github.com': { body: { some_other_field: 'value' } },
    });
    try {
      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it('returns null on network failure (silent)', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('returns null when JSON parsing fails (silent)', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response('<html>not json</html>', { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('detectChannel', () => {
  const originalPlatform = process.platform;
  const originalVersions = process.versions;

  function setRuntime(opts: { bun?: string; platform: NodeJS.Platform }): void {
    Object.defineProperty(process, 'platform', {
      value: opts.platform,
      configurable: true,
    });
    const versions: Record<string, string> = { ...(originalVersions as Record<string, string>) };
    if (opts.bun) {
      versions.bun = opts.bun;
    } else {
      delete versions.bun;
    }
    Object.defineProperty(process, 'versions', {
      value: versions,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      configurable: true,
    });
  });

  it('returns npm under Node runtime regardless of platform', () => {
    setRuntime({ platform: 'linux' });
    expect(detectChannel()).toBe('npm');
    setRuntime({ platform: 'darwin' });
    expect(detectChannel()).toBe('npm');
    setRuntime({ platform: 'win32' });
    expect(detectChannel()).toBe('npm');
  });

  it('returns ps1 under Bun runtime on Windows', () => {
    setRuntime({ bun: '1.1.0', platform: 'win32' });
    expect(detectChannel()).toBe('ps1');
  });

  it('returns sh under Bun runtime on non-Windows platforms', () => {
    setRuntime({ bun: '1.1.0', platform: 'darwin' });
    expect(detectChannel()).toBe('sh');
    setRuntime({ bun: '1.1.0', platform: 'linux' });
    expect(detectChannel()).toBe('sh');
  });

  it('treats an empty Bun version string as Node runtime', () => {
    setRuntime({ bun: '', platform: 'darwin' });
    expect(detectChannel()).toBe('npm');
  });
});

describe('getUpgradeHint', () => {
  it('emits npm install command for npm channel by default', () => {
    const text = getUpgradeHint('npm', '1.2.3', 'npm').join('\n');
    expect(text).toContain('npm install -g @qianwenai/qianwen-cli@latest');
    expect(text).not.toContain('pnpm add');
    expect(text).not.toContain('bun add');
  });

  it('emits bun add command when bun package manager is detected', () => {
    const text = getUpgradeHint('npm', '1.2.3', 'bun').join('\n');
    expect(text).toContain('bun add -g @qianwenai/qianwen-cli@latest');
    expect(text).not.toContain('npm install');
    expect(text).not.toContain('pnpm add');
  });

  it('emits pnpm add command when pnpm package manager is detected', () => {
    const text = getUpgradeHint('npm', '1.2.3', 'pnpm').join('\n');
    expect(text).toContain('pnpm add -g @qianwenai/qianwen-cli@latest');
    expect(text).not.toContain('npm install');
    expect(text).not.toContain('bun add');
  });

  it('emits curl install.sh command for sh channel without pinning a version', () => {
    const text = getUpgradeHint('sh', '1.2.3').join('\n');
    expect(text).toContain('curl -fsSL');
    expect(text).toContain('install.sh');
    expect(text).toContain('| sh');
    expect(text).not.toContain('--version');
  });

  it('emits irm install.ps1 | iex command for ps1 channel', () => {
    const text = getUpgradeHint('ps1', '1.2.3').join('\n');
    expect(text).toContain('irm');
    expect(text).toContain('install.ps1');
    expect(text).toContain('| iex');
    expect(text).not.toContain('--version');
  });

  it('does not emit a release notes line', () => {
    const hints = [
      getUpgradeHint('npm', '1.2.3', 'npm'),
      getUpgradeHint('npm', '1.2.3', 'bun'),
      getUpgradeHint('npm', '1.2.3', 'pnpm'),
      getUpgradeHint('sh', '1.2.3'),
      getUpgradeHint('ps1', '1.2.3'),
    ];
    for (const lines of hints) {
      const text = lines.join('\n');
      expect(text).not.toMatch(/release notes/i);
      expect(text).not.toContain('/releases/tag/');
    }
  });
});

describe('detectNodePackageManager', () => {
  it('returns bun when module URL contains a /.bun/ directory segment', () => {
    expect(
      detectNodePackageManager(
        'file:///Users/u/.bun/install/global/node_modules/@qianwenai/qianwen-cli/dist/upgrade/check.js',
      ),
    ).toBe('bun');
  });

  it('returns pnpm when module URL contains a /.pnpm/ directory segment', () => {
    expect(
      detectNodePackageManager(
        'file:///Users/u/project/node_modules/.pnpm/@qianwenai+qianwen-cli@1.0.0/node_modules/@qianwenai/qianwen-cli/dist/upgrade/check.js',
      ),
    ).toBe('pnpm');
  });

  it('prefers bun over pnpm when both markers are present', () => {
    expect(
      detectNodePackageManager(
        'file:///Users/u/.bun/install/global/node_modules/.pnpm/foo/dist/check.js',
      ),
    ).toBe('bun');
  });

  it('returns npm for a plain global node_modules path', () => {
    expect(
      detectNodePackageManager(
        'file:///usr/local/lib/node_modules/@qianwenai/qianwen-cli/dist/upgrade/check.js',
      ),
    ).toBe('npm');
  });

  it('requires real path separators around the marker directory', () => {
    // Incidental substrings like `my.bun.demo` or `fake.pnpm.dir` must not match.
    expect(
      detectNodePackageManager(
        'file:///Users/u/my.bun.demo/node_modules/@qianwenai/qianwen-cli/dist/check.js',
      ),
    ).toBe('npm');
    expect(
      detectNodePackageManager(
        'file:///Users/u/fake.pnpm.dir/node_modules/@qianwenai/qianwen-cli/dist/check.js',
      ),
    ).toBe('npm');
  });

  it('matches Windows-style backslash paths', () => {
    expect(
      detectNodePackageManager(
        'C:\\Users\\u\\.bun\\install\\global\\node_modules\\@qianwenai\\qianwen-cli\\dist\\check.js',
      ),
    ).toBe('bun');
    expect(
      detectNodePackageManager('C:\\Users\\u\\project\\node_modules\\.pnpm\\foo\\check.js'),
    ).toBe('pnpm');
  });

  it('falls back to npm on an unparseable input', () => {
    expect(detectNodePackageManager('not a url')).toBe('npm');
  });
});
