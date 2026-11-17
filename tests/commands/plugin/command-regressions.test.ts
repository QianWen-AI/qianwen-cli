import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../../helpers/run-command.js';
import { registerPluginManagementCommands } from '../../../src/commands/plugin/index.js';
import { loadInstalledPlugins, registerPluginCommands } from '../../../src/plugins/loader.js';
import { Command } from 'commander';
import type { DefaultPlugin } from '../../../src/plugins/defaults.js';

const dirs = vi.hoisted(() => ({ pluginsDir: '', manifestPath: '' }));
const mode = vi.hoisted(() => ({ repl: false, defaults: [] as DefaultPlugin[] }));
vi.mock('../../../src/utils/runtime-mode.js', async (original) => ({
  ...(await original<typeof import('../../../src/utils/runtime-mode.js')>()),
  isReplMode: () => mode.repl,
}));
vi.mock('../../../src/plugins/npm-registry.js', () => ({
  resolveRegistryForPackage: () => ({ registry: 'https://registry.test.qianwenai.com/' }),
}));
vi.mock('../../../src/plugins/installer.js', async (original) => {
  const actual = await original<typeof import('../../../src/plugins/installer.js')>();
  return {
    ...actual,
    getRegistryPluginMetadata: (name: string) =>
      actual.getRegistryPluginMetadata(name, { fetchImpl: globalThis.fetch }),
  };
});
vi.mock('../../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../../src/config/paths.js')>()),
  getPluginsDir: () => dirs.pluginsDir,
  getPluginsManifestPath: () => dirs.manifestPath,
}));
vi.mock('../../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => mode.defaults,
  getDefaultPlugin: (name: string) => mode.defaults.find((plugin) => plugin.name === name),
}));
vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: vi.fn(async () => {}),
  renderWithInkSync: vi.fn(async () => {}),
}));
let root: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.plugin-command-'));
  dirs.pluginsDir = path.join(root, 'plugins');
  dirs.manifestPath = path.join(root, 'plugins.json');
  fs.writeFileSync(dirs.manifestPath, JSON.stringify({ plugins: [] }));
  exitCode = process.exitCode;
  process.exitCode = 0;
  mode.repl = false;
  mode.defaults = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('unexpected network');
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = exitCode;
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(name: string, metadata: Record<string, unknown>, installed = false) {
  const dir = installed ? path.join(dirs.pluginsDir, 'node_modules', name) : path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      qianwen: { command: name, entry: './index.mjs', handlerKey: 'run', ...metadata },
    }),
  );
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const handlers = { run: async () => {} };');
  return dir;
}

describe('plugin input validation', () => {
  it('accepts the documented abbreviated minimum version', async () => {
    const dir = fixture('valid-minimum', { minCliVersion: '1.0' });
    const result = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'validate',
      dir,
      '--format',
      'json',
    ]);
    expect(JSON.parse(result.stdout).summary.errors).toBe(0);
    expect(result.exitCode).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });
  it.each(['', ' ', '\t\n'])(
    'rejects blank init command %j without creating files',
    async (command) => {
      const target = path.join(root, 'new-scaffold');
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'init',
        target,
        '--command',
        command,
        '--format',
        'json',
      ]);
      expect(result.exitCode ?? process.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/command/i);
      expect(fs.existsSync(target)).toBe(false);
      expect(result.stdout).not.toContain('"selfCheckOk":true');
    },
  );

  it.each(['invalid', '01.0.0', 42, {}, null])(
    'reports invalid minimum %j as a failing check',
    async (minCliVersion) => {
      const dir = fixture('invalid-minimum', { minCliVersion });
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'validate',
        dir,
        '--format',
        'json',
      ]);
      const payload = JSON.parse(result.stdout) as { summary: { errors: number } };
      expect(payload.summary.errors).toBeGreaterThan(0);
      expect(result.exitCode ?? process.exitCode).not.toBe(0);
      expect(result.stderr).not.toMatch(/TypeError|\n\s+at /);
    },
  );

  it('fails self-validation without declaring scaffold success', async () => {
    const target = path.join(root, 'scaffold');
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(target, 'index.mjs'));
    const result = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'init',
      target,
      '--force',
      '--format',
      'json',
    ]);
    expect(result.exitCode ?? process.exitCode).not.toBe(0);
    expect(result.stdout).not.toMatch(/"selfCheckOk"\s*:\s*true/);
  });
});

describe('host command reservations', () => {
  it('does not exempt a reinstall from host alias reservation', async () => {
    const source = fixture('reinstall-fixture', {});
    const first = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'install',
      source,
      '--format',
      'json',
    ]);
    expect(first.exitCode).toBeUndefined();
    const original = fs.readFileSync(dirs.manifestPath, 'utf8');
    fixture('reinstall-fixture', { commandAliases: ['q'] });
    const result = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'install',
      source,
      '--format',
      'json',
    ]);
    expect(result.exitCode ?? process.exitCode).not.toBe(0);
    expect(fs.readFileSync(dirs.manifestPath, 'utf8')).toBe(original);
  });
  it.each([
    'help',
    'clear',
    'cls',
    'exit',
    'quit',
    'q',
    'Help',
    'CLEAR',
    'Cls',
    'Exit',
    'QUIT',
    'Q',
  ])('rejects host command and alias %s on install', async (reserved) => {
    for (const metadata of [{ command: reserved }, { commandAliases: [reserved] }]) {
      const dir = fixture('reserved-fixture', metadata);
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'install',
        dir,
        '--format',
        'json',
      ]);
      expect(result.exitCode ?? process.exitCode).not.toBe(0);
      expect(JSON.parse(fs.readFileSync(dirs.manifestPath, 'utf8'))).toEqual({ plugins: [] });
      expect(fs.existsSync(path.join(dirs.pluginsDir, 'node_modules', 'reserved-fixture'))).toBe(
        false,
      );
    }
  });
  it.each([
    'help',
    'clear',
    'cls',
    'exit',
    'quit',
    'q',
    'Help',
    'CLEAR',
    'Cls',
    'Exit',
    'QUIT',
    'Q',
  ])('does not load host command or alias %s', (reserved) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const metadata of [{ command: reserved }, { commandAliases: [reserved] }]) {
      fixture('reserved-fixture', metadata, true);
      fixture('healthy-fixture', {}, true);
      fs.writeFileSync(
        dirs.manifestPath,
        JSON.stringify({
          plugins: [
            { name: 'reserved-fixture', version: '1.0.0', source: 'npm', enabled: true },
            { name: 'healthy-fixture', version: '1.0.0', source: 'npm', enabled: true },
          ],
        }),
      );
      const program = new Command();
      registerPluginCommands(program, loadInstalledPlugins(dirs.manifestPath, dirs.pluginsDir));
      expect(program.commands.map((command) => command.name())).toEqual(['healthy-fixture']);
    }
  });
});

describe('malformed minimum isolation', () => {
  it.each([42, {}, null])('isolates a malformed preloaded minimum %j', async (minCliVersion) => {
    fixture('default-broken', { minCliVersion }, true);
    fs.writeFileSync(
      dirs.manifestPath,
      JSON.stringify({
        plugins: [{ name: 'default-broken', version: '1.0.0', source: 'npm', enabled: true }],
      }),
    );
    mode.defaults = [
      {
        name: 'default-broken',
        version: '1.0.0',
        command: 'default-broken',
        source: { type: 'npm' },
      },
    ];
    const result = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'list',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout).plugins).toEqual([
      expect.objectContaining({ name: 'default-broken', status: 'broken' }),
    ]);
    expect(result.stderr).not.toMatch(/TypeError|\n\s+at /);
  });
  it.each([42, {}, null])(
    'lists healthy siblings despite malformed minimum %j',
    async (minCliVersion) => {
      fixture('broken', { minCliVersion }, true);
      fixture('healthy', {}, true);
      fs.writeFileSync(
        dirs.manifestPath,
        JSON.stringify({
          plugins: [
            { name: 'broken', version: '1.0.0', source: 'npm', enabled: true },
            { name: 'healthy', version: '1.0.0', source: 'npm', enabled: true },
          ],
        }),
      );
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'list',
        '--format',
        'json',
      ]);
      expect(result.exitCode).toBeUndefined();
      expect(JSON.parse(result.stdout).plugins).toEqual([
        expect.objectContaining({ name: 'broken', status: 'broken' }),
        expect.objectContaining({ name: 'healthy', installed: true, status: 'enabled' }),
      ]);
      expect(result.stderr).not.toMatch(/TypeError|\n\s+at /);
    },
  );
});
describe('registry metadata isolation', () => {
  it.each([42, {}, null])(
    'isolates malformed registry minimum %j and preserves healthy updates',
    async (minCliVersion) => {
      fs.writeFileSync(
        dirs.manifestPath,
        JSON.stringify({
          plugins: [{ name: 'registry-fixture', version: '1.0.0', source: 'npm', enabled: true }],
        }),
      );
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              'dist-tags': { latest: '2.0.0' },
              versions: {
                '2.0.0': { qianwen: { minCliVersion } },
                '1.1.0': { qianwen: { minCliVersion: '0.1.0' } },
              },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal('fetch', fetch);
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'update',
        '--format',
        'json',
      ]);
      const payload = JSON.parse(result.stdout) as {
        updates: Array<{ latest: string }>;
        invalidMetadata: unknown[];
        uncheckable: unknown[];
      };
      expect(fetch, JSON.stringify(payload)).toHaveBeenCalledOnce();
      expect(payload.updates, JSON.stringify(payload)).toHaveLength(1);
      expect(payload.updates[0].latest).toBe('1.1.0');
      expect(payload.invalidMetadata).toEqual([
        expect.objectContaining({ name: 'registry-fixture', version: '2.0.0' }),
      ]);
      expect(payload.uncheckable).toEqual([]);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});

describe('running session plugin replacement', () => {
  it('warns on same-version replacement with a changed static dependency', async () => {
    const source = fixture('reload-fixture', { auth: 'optional' });
    fs.writeFileSync(path.join(source, 'dependency.mjs'), 'export const value = "old";');
    fs.writeFileSync(
      path.join(source, 'index.mjs'),
      'import { value } from "./dependency.mjs"; export const handlers = { run: async () => console.log(value) };',
    );
    const first = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'install',
      source,
      '--format',
      'json',
    ]);
    expect(first.exitCode).toBeUndefined();
    const executed = await runCommand(
      (program) => {
        registerPluginCommands(program, loadInstalledPlugins(dirs.manifestPath, dirs.pluginsDir));
      },
      ['reload-fixture'],
    );
    expect(executed.stdout).toBe('old');

    fs.writeFileSync(path.join(source, 'dependency.mjs'), 'export const value = "new";');
    mode.repl = true;
    const replaced = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'install',
      source,
      '--format',
      'json',
    ]);
    expect(replaced.exitCode).toBeUndefined();
    expect(JSON.parse(replaced.stdout)).toMatchObject({ restartRequired: true });
    expect(replaced.stderr).toMatch(/restart.*REPL|REPL.*restart/i);
    expect(replaced.stderr).toMatch(/dependenc/i);
  });
});
