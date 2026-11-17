import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectTmpdir } from '../fixtures/plugin-temporary-root.js';
import { loadInstalledPlugins } from '../../src/plugins/loader.js';
import { writeInstalledManifest, type InstalledManifest } from '../../src/plugins/manifest.js';

let root: string;
let plugins: string;
let manifest: string;
beforeEach(() => {
  root = mkdtempSync(join(projectTmpdir(), 'containment-'));
  plugins = join(root, 'plugins');
  manifest = join(root, 'plugins.json');
  mkdirSync(join(plugins, 'node_modules'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function pkg(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      qianwen: { command: name, entry: './index.mjs', handlerKey: 'run' },
    }),
  );
}
function entry(
  name: string,
  source: InstalledManifest['plugins'][number]['source'],
  path?: string,
): InstalledManifest['plugins'][number] {
  return { name, source, version: '1.0.0', enabled: true, ...(path ? { path } : {}) };
}
describe('installed package real path containment', () => {
  it.each(['npm', 'local', 'archive'] as const)(
    'rejects an explicit external path for %s sources',
    (source) => {
      const outside = join(root, 'plugins-sibling', 'escaped');
      pkg(outside, 'escaped');
      pkg(join(plugins, 'node_modules', 'healthy'), 'healthy');
      writeInstalledManifest(manifest, {
        plugins: [entry('escaped', source, outside), entry('healthy', 'npm')],
      });
      const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(loadInstalledPlugins(manifest, plugins).map((plugin) => plugin.name)).toEqual([
        'healthy',
      ]);
      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/escaped/i));
    },
  );
  it.each(['npm', 'local', 'archive'] as const)(
    'isolates escaped %s package roots and preserves a healthy sibling',
    (source) => {
      pkg(join(root, 'external'), 'escaped');
      symlinkSync(join(root, 'external'), join(plugins, 'node_modules', 'escaped'), 'dir');
      pkg(join(plugins, 'node_modules', 'healthy'), 'healthy');
      writeInstalledManifest(manifest, {
        plugins: [entry('escaped', source), entry('healthy', 'npm')],
      });
      const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(loadInstalledPlugins(manifest, plugins).map((plugin) => plugin.name)).toEqual([
        'healthy',
      ]);
      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/escaped/i));
    },
  );
  it('rejects an intermediate node_modules symlink escaping the plugins root', () => {
    const alternate = join(root, 'alternate-plugins');
    mkdirSync(alternate);
    pkg(join(root, 'external-modules', 'escaped'), 'escaped');
    symlinkSync(join(root, 'external-modules'), join(alternate, 'node_modules'), 'dir');
    writeInstalledManifest(manifest, { plugins: [entry('escaped', 'npm')] });
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(loadInstalledPlugins(manifest, alternate)).toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/escaped/i));
  });
  it.each(['dangling', 'unreadable'] as const)('isolates a %s root', (kind) => {
    if (kind === 'dangling')
      symlinkSync(join(root, 'absent'), join(plugins, 'node_modules', 'broken'), 'dir');
    else writeFileSync(join(plugins, 'node_modules', 'broken'), 'not a directory');
    pkg(join(plugins, 'node_modules', 'healthy'), 'healthy');
    writeInstalledManifest(manifest, {
      plugins: [entry('broken', 'local'), entry('healthy', 'npm')],
    });
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(loadInstalledPlugins(manifest, plugins).map((plugin) => plugin.name)).toEqual([
      'healthy',
    ]);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/broken/i));
  });
  it('accepts contained symlinks and an aliased plugins directory', () => {
    pkg(join(plugins, 'store', 'contained'), 'contained');
    symlinkSync(
      join(plugins, 'store', 'contained'),
      join(plugins, 'node_modules', 'contained'),
      'dir',
    );
    symlinkSync(plugins, join(root, 'alias'), 'dir');
    writeInstalledManifest(manifest, { plugins: [entry('contained', 'npm')] });
    expect(
      loadInstalledPlugins(manifest, join(root, 'alias')).map((plugin) => plugin.name),
    ).toEqual(['contained']);
  });
  it.each(['link', 'bundle'] as const)('preserves intentional external %s sources', (source) => {
    const directory = join(root, 'external');
    pkg(directory, 'external');
    writeInstalledManifest(manifest, { plugins: [entry('external', source, directory)] });
    expect(loadInstalledPlugins(manifest, plugins).map((plugin) => plugin.name)).toEqual([
      'external',
    ]);
  });
});
