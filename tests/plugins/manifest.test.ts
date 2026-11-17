import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readInstalledManifest,
  writeInstalledManifest,
  readPluginPackageManifest,
  type InstalledManifest,
} from '../../src/plugins/manifest.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(process.cwd(), '.qianwen-plugin-manifest-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readInstalledManifest', () => {
  it('returns an empty plugin list when the manifest file is absent', () => {
    const manifest = readInstalledManifest(path.join(root, 'plugins.json'));
    expect(manifest.plugins).toEqual([]);
  });

  it('reports CONFIG_ERROR for invalid JSON and preserves the original content', () => {
    const p = path.join(root, 'plugins.json');
    writeFileSync(p, '{ not valid json', 'utf8');
    expect(() => readInstalledManifest(p)).toThrow(
      expect.objectContaining({ code: 'CONFIG_ERROR', exitCode: 4 }),
    );
    expect(readFileSync(p, 'utf8')).toBe('{ not valid json');
  });

  it('reads back persisted plugin entries', () => {
    const p = path.join(root, 'plugins.json');
    const m: InstalledManifest = {
      plugins: [{ name: '@qianwenai/plugin-demo', version: '1.0.0', enabled: true, source: 'npm' }],
    };
    writeInstalledManifest(p, m);
    expect(readInstalledManifest(p).plugins[0].name).toBe('@qianwenai/plugin-demo');
  });
});

describe('writeInstalledManifest', () => {
  it('writes the target file atomically without leaving a .tmp file', () => {
    const p = path.join(root, 'plugins.json');
    writeInstalledManifest(p, { plugins: [] });
    expect(existsSync(p)).toBe(true);
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
});

describe('readPluginPackageManifest', () => {
  it('reads the command tree from package.json.qianwen', () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'p',
        qianwen: { command: 'foo', entry: './i.js', handlerKey: 'foo' },
      }),
      'utf8',
    );
    const m = readPluginPackageManifest(root);
    expect(m?.command).toBe('foo');
  });

  it('returns null when package.json or its qianwen field is absent', () => {
    expect(readPluginPackageManifest(root)).toBeNull();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8');
    expect(readPluginPackageManifest(root)).toBeNull();
  });

  it('ignores a leftover qianwen-plugin.manifest.json and reads only package.json.qianwen', () => {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8');
    writeFileSync(
      path.join(root, 'qianwen-plugin.manifest.json'),
      JSON.stringify({ command: 'legacy', entry: './i.js', handlerKey: 'legacy' }),
      'utf8',
    );
    expect(readPluginPackageManifest(root)).toBeNull();
  });

  it('falls back to package.json main/description when entry/description are absent', () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'p',
        main: './index.mjs',
        description: 'from package.json',
        qianwen: { command: 'foo', handlerKey: 'foo' },
      }),
      'utf8',
    );
    const m = readPluginPackageManifest(root);
    expect(m?.entry).toBe('./index.mjs');
    expect(m?.description).toBe('from package.json');
  });

  it('lets explicit qianwen entry/description override top-level main/description', () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'p',
        main: './pkg.js',
        description: 'pkg desc',
        qianwen: {
          command: 'foo',
          entry: './explicit.js',
          description: 'explicit desc',
          handlerKey: 'foo',
        },
      }),
      'utf8',
    );
    const m = readPluginPackageManifest(root);
    expect(m?.entry).toBe('./explicit.js');
    expect(m?.description).toBe('explicit desc');
  });

  it('derives an absent minCliVersion from engines[@qianwenai/qianwen-cli] without the range prefix', () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'p',
        engines: { '@qianwenai/qianwen-cli': '>=1.4.0' },
        qianwen: { command: 'foo', entry: './i.js', handlerKey: 'foo' },
      }),
      'utf8',
    );
    expect(readPluginPackageManifest(root)?.minCliVersion).toBe('1.4.0');
  });

  it('derives an absent minCliVersion from peerDependencies when engines are absent', () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'p',
        peerDependencies: { '@qianwenai/qianwen-cli': '^1.4' },
        qianwen: { command: 'foo', entry: './i.js', handlerKey: 'foo' },
      }),
      'utf8',
    );
    expect(readPluginPackageManifest(root)?.minCliVersion).toBe('1.4');
  });

  it('preserves explicit minCliVersion over engines and peerDependencies', () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'p',
        engines: { '@qianwenai/qianwen-cli': '>=2.0.0' },
        qianwen: { command: 'foo', entry: './i.js', handlerKey: 'foo', minCliVersion: '1.5.0' },
      }),
      'utf8',
    );
    expect(readPluginPackageManifest(root)?.minCliVersion).toBe('1.5.0');
  });
});

describe('manifest document structure', () => {
  it.each([
    'null',
    '[]',
    '{}',
    '{"plugins":null}',
    '{"plugins":{}}',
    '{"plugins":[],"disabledDefaults":{}}',
  ])('rejects an invalid document without overwriting it: %s', (bytes) => {
    const file = path.join(root, 'plugins.json');
    writeFileSync(file, bytes);
    expect(() => readInstalledManifest(file)).toThrow(
      expect.objectContaining({ code: 'CONFIG_ERROR', exitCode: 4 }),
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
});
