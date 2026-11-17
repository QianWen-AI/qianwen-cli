import { stubRegistry } from '../fixtures/plugin-registry.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Registry transport fixtures must not inherit the developer's private npm settings.
vi.mock('../../src/plugins/npm-registry.js', () => ({
  resolveRegistryForPackage: () => ({ registry: 'https://registry.npmjs.org/' }),
}));
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseNpmSpec,
  isSemVerGreater,
  installNpmPlugin,
  installLocalPlugin,
  removePluginArtifacts,
  getRegistryVersion,
  type InstallResult,
  type InstallTransaction,
} from '../../src/plugins/installer.js';
import { buildTarball } from '../fixtures/tar-builder.js';

/** Assert an install succeeded and return its transaction handle. */
function txOf(res: InstallResult): InstallTransaction {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unreachable');
  return res.tx;
}

describe('parseNpmSpec — package names and versions preserve the leading scope marker', () => {
  it('parses an unscoped package without a version', () => {
    expect(parseNpmSpec('foo')).toEqual({ name: 'foo' });
  });
  it('parses an unscoped package with a version', () => {
    expect(parseNpmSpec('foo@1.2.0')).toEqual({ name: 'foo', version: '1.2.0' });
  });
  it('preserves the leading @ in a scoped package without a version', () => {
    expect(parseNpmSpec('@qianwenai/demo')).toEqual({ name: '@qianwenai/demo' });
  });
  it('splits a versioned scoped package at the final @', () => {
    expect(parseNpmSpec('@qianwenai/demo@2.0.1')).toEqual({
      name: '@qianwenai/demo',
      version: '2.0.1',
    });
  });
  it('parses the latest tag', () => {
    expect(parseNpmSpec('foo@latest')).toEqual({ name: 'foo', version: 'latest' });
  });
  it('discards an empty version after a trailing @', () => {
    expect(parseNpmSpec('foo@')).toEqual({ name: 'foo' });
    expect(parseNpmSpec('@scope/pkg@')).toEqual({ name: '@scope/pkg' });
  });
});

describe('isSemVerGreater — semantic version comparison for update checks', () => {
  it('detects a greater major version', () => expect(isSemVerGreater('2.0.0', '1.9.9')).toBe(true));
  it('detects a greater minor version', () => expect(isSemVerGreater('1.2.0', '1.1.9')).toBe(true));
  it('detects a greater patch version', () => expect(isSemVerGreater('1.0.2', '1.0.1')).toBe(true));
  it('returns false for equal versions', () =>
    expect(isSemVerGreater('1.0.0', '1.0.0')).toBe(false));
  it('returns false for an older version', () =>
    expect(isSemVerGreater('1.0.0', '1.0.1')).toBe(false));
  it('pads missing version components with zero', () =>
    expect(isSemVerGreater('1.1', '1.0.9')).toBe(true));
});

describe('installNpmPlugin — HTTPS tarball download, integrity checks, and extraction', () => {
  let root: string;
  let pluginsDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qianwen-npm-install-'));
    pluginsDir = path.join(root, 'plugins');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the packument version, downloads and verifies the tarball, then extracts into node_modules/<name>', async () => {
    const tgz = buildTarball([
      { name: 'package/package.json', data: JSON.stringify({ name: 'foo', version: '1.2.0' }) },
      { name: 'package/index.mjs', data: 'export const handlers = {};' },
    ]);
    const fetchImpl = stubRegistry({ pkg: 'foo', version: '1.2.0', tgz });

    const res = await installNpmPlugin('foo@1.2.0', pluginsDir, { fetchImpl });

    const tx = txOf(res);
    expect(tx.name).toBe('foo');
    expect(tx.version).toBe('1.2.0');
    tx.commit();
    const dest = path.join(pluginsDir, 'node_modules', 'foo');
    expect(existsSync(path.join(dest, 'index.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).name).toBe('foo');
  });

  it('resolves an unspecified version through dist-tags.latest', async () => {
    const tgz = buildTarball([
      { name: 'package/package.json', data: JSON.stringify({ name: 'bar', version: '3.0.0' }) },
    ]);
    const fetchImpl = stubRegistry({ pkg: 'bar', version: '3.0.0', tgz });

    const res = await installNpmPlugin('bar', pluginsDir, { fetchImpl });

    expect(txOf(res).version).toBe('3.0.0');
  });

  it('atomically replaces an installed version after fully writing the new content', async () => {
    const dest = path.join(pluginsDir, 'node_modules', 'foo');
    const v1 = buildTarball([
      { name: 'package/package.json', data: JSON.stringify({ name: 'foo', version: '1.0.0' }) },
      { name: 'package/old.mjs', data: 'v1' },
    ]);
    txOf(
      await installNpmPlugin('foo@1.0.0', pluginsDir, {
        fetchImpl: stubRegistry({ pkg: 'foo', version: '1.0.0', tgz: v1 }),
      }),
    ).commit();
    expect(existsSync(path.join(dest, 'old.mjs'))).toBe(true);

    const v2 = buildTarball([
      { name: 'package/package.json', data: JSON.stringify({ name: 'foo', version: '2.0.0' }) },
      { name: 'package/new.mjs', data: 'v2' },
    ]);
    const res = await installNpmPlugin('foo@2.0.0', pluginsDir, {
      fetchImpl: stubRegistry({ pkg: 'foo', version: '2.0.0', tgz: v2 }),
    });

    const tx = txOf(res);
    expect(tx.version).toBe('2.0.0');
    tx.commit();
    // Clean swap: new file present, stale v1 file gone, no leftover staging/backup dirs.
    expect(existsSync(path.join(dest, 'new.mjs'))).toBe(true);
    expect(existsSync(path.join(dest, 'old.mjs'))).toBe(false);
    const leftovers = readdirSync(path.join(pluginsDir, 'node_modules')).filter(
      (e) => e.startsWith('.qianwen-plugin-') || e.includes('.qianwen-bak-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('preserves the installed version when upgrade validation fails', async () => {
    const dest = path.join(pluginsDir, 'node_modules', 'foo');
    const v1 = buildTarball([
      { name: 'package/package.json', data: JSON.stringify({ name: 'foo', version: '1.0.0' }) },
      { name: 'package/old.mjs', data: 'v1' },
    ]);
    await installNpmPlugin('foo@1.0.0', pluginsDir, {
      fetchImpl: stubRegistry({ pkg: 'foo', version: '1.0.0', tgz: v1 }),
    });

    // Corrupt v2: integrity mismatch → install fails before touching dest.
    const v2 = buildTarball([{ name: 'package/new.mjs', data: 'v2' }]);
    const res = await installNpmPlugin('foo@2.0.0', pluginsDir, {
      fetchImpl: stubRegistry({
        pkg: 'foo',
        version: '2.0.0',
        tgz: v2,
        integrity: 'sha512-AAAAwrongAAAA',
      }),
    });

    expect(res.ok).toBe(false);
    // Old version untouched.
    expect(existsSync(path.join(dest, 'old.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).version).toBe('1.0.0');
  });

  it('returns ok:false without writing files when integrity verification fails', async () => {
    const tgz = buildTarball([{ name: 'package/index.mjs', data: 'x' }]);
    const fetchImpl = stubRegistry({
      pkg: 'foo',
      version: '1.0.0',
      tgz,
      integrity: 'sha512-AAAAwrongdigestAAAA',
    });

    const res = await installNpmPlugin('foo@1.0.0', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/integrity mismatch/);
    expect(existsSync(path.join(pluginsDir, 'node_modules', 'foo'))).toBe(false);
  });

  it('returns ok:false when the requested version does not exist', async () => {
    const tgz = buildTarball([{ name: 'package/index.mjs', data: 'x' }]);
    const fetchImpl = stubRegistry({ pkg: 'foo', version: '1.0.0', tgz });

    const res = await installNpmPlugin('foo@9.9.9', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/no matching version/);
  });

  it('returns ok:false with a network error for registry HTTP failures', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;

    const res = await installNpmPlugin('missing', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/registry metadata|HTTP 404/);
  });

  it('returns ok:false and preserves the underlying error detail when the network layer throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.test.qianwenai.com');
    }) as unknown as typeof fetch;

    const res = await installNpmPlugin('foo@1.0.0', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/Failed to fetch registry metadata/);
    expect(res.error).toMatch(/ENOTFOUND registry\.test\.qianwenai\.com/);
  });

  it('rejects tarball entries outside package/ without writing files', async () => {
    const tgz = buildTarball([{ name: 'evil/escape.js', data: 'pwn' }]);
    const fetchImpl = stubRegistry({ pkg: 'foo', version: '1.0.0', tgz });

    const res = await installNpmPlugin('foo@1.0.0', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/refusing to install/);
    expect(existsSync(path.join(pluginsDir, 'node_modules', 'foo'))).toBe(false);
  });

  it('returns ok:false without throwing or writing files for unsupported integrity algorithms (sha3-256)', async () => {
    const tgz = buildTarball([{ name: 'package/index.mjs', data: 'x' }]);
    // A well-formed integrity string with an algorithm createHash would reject
    // must fail closed as a clean result, not a synchronous throw.
    const fetchImpl = stubRegistry({
      pkg: 'foo',
      version: '1.0.0',
      tgz,
      integrity: `sha3-256-${'A'.repeat(43)}`,
    });

    const res = await installNpmPlugin('foo@1.0.0', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/unsupported integrity algorithm/);
    expect(existsSync(path.join(pluginsDir, 'node_modules', 'foo'))).toBe(false);
  });

  it('rejects a legacy SHA-1 shasum without integrity metadata', async () => {
    const tgz = buildTarball([{ name: 'package/index.mjs', data: 'x' }]);
    const tarballUrl = 'https://registry.npmjs.org/foo/-/pkg.tgz';
    const packument = {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { dist: { tarball: tarballUrl, shasum: 'abc123' } } },
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString();
      if (href === tarballUrl) return new Response(new Uint8Array(tgz), { status: 200 });
      return new Response(JSON.stringify(packument), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await installNpmPlugin('foo@1.0.0', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/did not provide an integrity checksum/);
    expect(existsSync(path.join(pluginsDir, 'node_modules', 'foo'))).toBe(false);
  });

  it('rejects an oversized Content-Length before buffering the response body', async () => {
    const tgz = buildTarball([{ name: 'package/index.mjs', data: 'x' }]);
    const tarballUrl = 'https://registry.npmjs.org/foo/-/pkg.tgz';
    const packument = {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { dist: { tarball: tarballUrl, integrity: 'sha512-x' } } },
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString();
      if (href === tarballUrl) {
        // Advertise a body far over the tarball ceiling.
        return new Response(new Uint8Array(tgz), {
          status: 200,
          headers: { 'content-length': String(200 * 1024 * 1024) },
        });
      }
      return new Response(JSON.stringify(packument), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await installNpmPlugin('foo@1.0.0', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/size limit/);
    expect(existsSync(path.join(pluginsDir, 'node_modules', 'foo'))).toBe(false);
  });

  it('SSRF: rejects a tarball URL from a different origin than the registry without downloading or writing files', async () => {
    const tgz = buildTarball([{ name: 'package/index.mjs', data: 'x' }]);
    // Malicious packument points the tarball at an internal metadata address.
    const fetchImpl = stubRegistry({
      pkg: 'foo',
      version: '1.0.0',
      tgz,
      tarballUrl: 'http://169.254.169.254/latest/meta-data/',
    });

    const res = await installNpmPlugin('foo@1.0.0', pluginsDir, { fetchImpl });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('Expected plugin installation to fail');
    expect(res.error).toMatch(/tarball URL origin|non-https/);
    expect(existsSync(path.join(pluginsDir, 'node_modules', 'foo'))).toBe(false);
  });
});

describe('getRegistryVersion — packument dist-tags.latest lookup', () => {
  it('returns dist-tags.latest', async () => {
    const tgz = buildTarball([{ name: 'package/index.mjs', data: 'x' }]);
    const fetchImpl = stubRegistry({ pkg: 'foo', version: '2.5.0', tgz });

    expect(await getRegistryVersion('foo', { fetchImpl })).toBe('2.5.0');
  });

  it('returns null when the registry is unreachable so the update check can skip it', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(await getRegistryVersion('foo', { fetchImpl })).toBeNull();
  });
});

describe('installLocalPlugin / removePluginArtifacts — local copying and cleanup in temporary directories', () => {
  let root: string;
  let src: string;
  let pluginsDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qianwen-installer-'));
    src = path.join(root, 'src-plugin');
    pluginsDir = path.join(root, 'plugins');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({ name: 'localdemo', version: '0.1.0' }),
      'utf8',
    );
    writeFileSync(path.join(src, 'index.mjs'), 'export const handlers = {};', 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies a local directory to <pluginsDir>/node_modules/<name> using package.json.name', () => {
    const res = installLocalPlugin(src, pluginsDir);
    const tx = txOf(res);
    expect(tx.name).toBe('localdemo');
    tx.commit();
    const dest = path.join(pluginsDir, 'node_modules', 'localdemo');
    expect(existsSync(path.join(dest, 'index.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).name).toBe(
      'localdemo',
    );
  });

  it('creates the scope directory before installing a scoped local plugin', () => {
    const scopedName = '@qianwenai/localdemo';
    writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({ name: scopedName, version: '0.1.0' }),
      'utf8',
    );

    const tx = txOf(installLocalPlugin(src, pluginsDir));
    tx.commit();

    expect(
      existsSync(path.join(pluginsDir, 'node_modules', ...scopedName.split('/'), 'index.mjs')),
    ).toBe(true);
  });

  it('preserves backups from other transactions or crash recovery when starting an install', () => {
    const modulesRoot = path.join(pluginsDir, 'node_modules');
    const recovery = path.join(modulesRoot, 'other.qianwen-bak-123');
    mkdirSync(recovery, { recursive: true });
    writeFileSync(path.join(recovery, 'old.mjs'), 'recoverable', 'utf8');

    const tx = txOf(installLocalPlugin(src, pluginsDir));

    expect(readFileSync(path.join(recovery, 'old.mjs'), 'utf8')).toBe('recoverable');
    tx.rollback();
  });

  it('returns ok:false when the source directory has no package.json', () => {
    const bad = path.join(root, 'no-pkg');
    mkdirSync(bad, { recursive: true });
    const res = installLocalPlugin(bad, pluginsDir);
    expect(res.ok).toBe(false);
  });

  it('S1: rejects path traversal (../) in package.json.name without writing outside pluginsDir', () => {
    const evil = path.join(root, 'evil');
    mkdirSync(evil, { recursive: true });
    const escapeTarget = path.join(root, 'ESCAPED');
    // The name attempts to escape pluginsDir/node_modules into root/ESCAPED.
    writeFileSync(
      path.join(evil, 'package.json'),
      JSON.stringify({ name: '../../ESCAPED', version: '1.0.0' }),
      'utf8',
    );
    writeFileSync(path.join(evil, 'index.mjs'), 'export const handlers = {};', 'utf8');
    const res = installLocalPlugin(evil, pluginsDir);
    expect(res.ok).toBe(false);
    expect(existsSync(escapeTarget)).toBe(false);
  });

  it('S1: rejects invalid characters in package.json.name', () => {
    const evil = path.join(root, 'evil2');
    mkdirSync(evil, { recursive: true });
    writeFileSync(
      path.join(evil, 'package.json'),
      JSON.stringify({ name: 'a/b/c', version: '1.0.0' }),
      'utf8',
    );
    const res = installLocalPlugin(evil, pluginsDir);
    expect(res.ok).toBe(false);
  });

  it('removePluginArtifacts(local) removes the copied directory', () => {
    installLocalPlugin(src, pluginsDir);
    const dest = path.join(pluginsDir, 'node_modules', 'localdemo');
    expect(existsSync(dest)).toBe(true);

    removePluginArtifacts(
      { name: 'localdemo', version: '0.1.0', enabled: true, source: 'local' },
      pluginsDir,
    );

    expect(existsSync(dest)).toBe(false);
  });

  it('removePluginArtifacts(npm) removes the node_modules directory without spawning a process', () => {
    const tgzDest = path.join(pluginsDir, 'node_modules', 'foo');
    mkdirSync(tgzDest, { recursive: true });
    writeFileSync(path.join(tgzDest, 'index.mjs'), 'x', 'utf8');
    expect(existsSync(tgzDest)).toBe(true);

    removePluginArtifacts(
      { name: 'foo', version: '1.0.0', enabled: true, source: 'npm' },
      pluginsDir,
    );

    expect(existsSync(tgzDest)).toBe(false);
  });
});
