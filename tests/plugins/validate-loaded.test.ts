import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerPluginManagementCommands } from '../../src/commands/plugin/index.js';
import {
  loadInstalledPlugins,
  registerDefaultPluginCommands,
  registerPluginCommands,
} from '../../src/plugins/loader.js';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type { PluginManifest } from '../../src/plugins/manifest.js';
import { runCommand } from '../helpers/run-command.js';

const defaults = vi.hoisted(() => ({ entries: [] as DefaultPlugin[] }));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => defaults.entries,
  getDefaultPlugin: (name: string) => defaults.entries.find((entry) => entry.name === name),
}));

const paths = vi.hoisted(() => ({ root: '', pluginsDir: '', manifestPath: '' }));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getConfigDir: () => paths.root,
  getPluginsDir: () => paths.pluginsDir,
  getPluginsManifestPath: () => paths.manifestPath,
}));
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));

const originalExitCode = process.exitCode;
const ownName = '@qianwenai/loaded-fixture';
const otherName = '@qianwenai/other-fixture';
let ownDirectory: string;

function packageFixture(
  directory: string,
  name: string,
  command: string,
  aliases: string[] = [],
): void {
  mkdirSync(directory, { recursive: true });
  const manifest: PluginManifest = {
    command,
    commandAliases: aliases,
    entry: './entry.mjs',
    handlerKey: 'run',
    auth: 'optional',
  };
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', qianwen: manifest }),
  );
  writeFileSync(join(directory, 'entry.mjs'), 'export const handlers = { run() {} };');
}

beforeEach(() => {
  const parent = resolve('.local-test-tmp');
  mkdirSync(parent, { recursive: true });
  paths.root = mkdtempSync(join(parent, 'validate-loaded-'));
  paths.pluginsDir = join(paths.root, 'plugins');
  paths.manifestPath = join(paths.root, 'plugins.json');
  ownDirectory = join(paths.pluginsDir, 'node_modules', ownName);
  packageFixture(ownDirectory, ownName, 'loaded-fixture', ['loaded-alias']);
  packageFixture(join(paths.pluginsDir, 'node_modules', otherName), otherName, 'other-fixture', [
    'other-alias',
  ]);
  writeFileSync(
    paths.manifestPath,
    JSON.stringify({
      plugins: [
        {
          name: ownName,
          version: '1.0.0',
          enabled: true,
          source: 'npm',
          command: 'loaded-fixture',
        },
        {
          name: otherName,
          version: '1.0.0',
          enabled: true,
          source: 'npm',
          command: 'other-fixture',
        },
      ],
    }),
  );
  defaults.entries = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network');
    }),
  );
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = originalExitCode;
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(paths.root, { recursive: true, force: true });
});

async function validate(directory: string, loaded = true, trustedDefault = false) {
  const result = await runCommand(
    (program) => {
      program.command('models').alias('m').command('nested-only').alias('nested-alias');
      registerPluginManagementCommands(program);
      registerDefaultPluginCommands(program);
      if (!loaded) return;
      const plugins = loadInstalledPlugins(paths.manifestPath, paths.pluginsDir);
      expect(plugins).toHaveLength(2);
      registerPluginCommands(program, plugins, { trustedDefault });
      expect(program.commands.some((command) => command.name() === 'loaded-fixture')).toBe(true);
      expect(program.commands.some((command) => command.name() === 'other-fixture')).toBe(true);
    },
    ['plugin', 'validate', directory, '--format', 'json'],
  );
  return {
    result,
    report: JSON.parse(result.stdout) as {
      summary: { errors: number };
      checks: Array<{ name: string; status: string; detail?: string }>;
    },
  };
}

describe('validation with already registered plugin commands', () => {
  it.each([false, true])('validates its own package and alias with loaded=%s', async (loaded) => {
    const { result, report } = await validate(ownDirectory, loaded);
    expect(report.summary.errors).toBe(0);
    expect(result.exitCode).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('validates the package registered through the trusted-default path', async () => {
    const { report } = await validate(ownDirectory, true, true);
    expect(report.summary.errors).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  it('validates a same-owner reinstall candidate after loading the installed package', async () => {
    const candidate = join(paths.root, 'candidate');
    packageFixture(candidate, ownName, 'loaded-fixture', ['loaded-alias']);
    const { report } = await validate(candidate);
    expect(report.summary.errors).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  it.each(['nested-only', 'nested-alias'])(
    'keeps nested built-in name %s outside the top-level namespace',
    async (command) => {
      const candidate = join(paths.root, 'candidate');
      packageFixture(candidate, ownName, command);
      const { report } = await validate(candidate);
      expect(report.summary.errors).toBe(0);
      expect(process.exitCode).toBe(0);
    },
  );

  it('rejects taking the command reserved by an absent default plugin', async () => {
    defaults.entries = [
      {
        name: '@qianwenai/default-fixture',
        version: '1.0.0',
        source: { type: 'npm' },
        command: 'default-fixture',
      },
    ];
    const candidate = join(paths.root, 'candidate');
    packageFixture(candidate, ownName, 'default-fixture');
    const { report } = await validate(candidate);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'command-collision', status: 'fail' }),
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['models', []],
    ['m', []],
    ['fresh-command', ['m']],
    ['other-fixture', []],
    ['other-alias', []],
    ['fresh-command', ['other-alias']],
  ] as Array<[string, string[]]>)(
    'rejects a same-name candidate conflicting through %s and %j',
    async (command, aliases) => {
      const candidate = join(paths.root, 'candidate');
      packageFixture(candidate, ownName, command, aliases);
      const { report } = await validate(candidate);
      expect(report.summary.errors).toBeGreaterThan(0);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ name: 'command-collision', status: 'fail' }),
      );
      expect(process.exitCode).toBe(1);
    },
  );
});
