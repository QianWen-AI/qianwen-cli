import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import {
  readPluginPackageManifest,
  type InstalledPlugin,
  type PluginManifest,
} from '../../src/plugins/manifest.js';
import { registerDefaultPluginCommands } from '../../src/plugins/loader.js';
import { HandledError } from '../../src/utils/errors.js';

const state = vi.hoisted(() => ({
  defaults: [] as DefaultPlugin[],
  ensure: vi.fn(),
  usable: vi.fn(),
}));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => state.defaults,
  getDefaultPlugin: (name: string) => state.defaults.find((plugin) => plugin.name === name),
}));
vi.mock('../../src/plugins/default-install.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/default-install.js')>()),
  ensureDefaultPlugin: state.ensure,
  readUsableDefaultPlugin: state.usable,
}));
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({ 'output.format': 'json' }),
}));

let directory: string;
let configured: DefaultPlugin;
let declared: PluginManifest;
let record: InstalledPlugin;

beforeEach(() => {
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  directory = mkdtempSync(path.join(temporaryRoot, 'lazy-default-'));
  configured = {
    name: '@qianwenai/lazy-default',
    version: '1.2.3',
    source: { type: 'npm' },
    command: 'catalog',
  };
  declared = {
    command: 'catalog',
    entry: './index.mjs',
    description: 'A metadata-only default command',
    subcommands: [
      {
        command: 'search [query]',
        handlerKey: 'search',
        options: [{ flag: '--limit <number>', description: 'Maximum results' }],
      },
    ],
  };
  record = {
    name: configured.name,
    version: configured.version,
    enabled: true,
    source: 'npm',
    path: directory,
    command: 'catalog',
  };
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: record.name,
      version: record.version,
      qianwen: declared,
    }),
  );
  writeFileSync(
    path.join(directory, 'index.mjs'),
    [
      'console.log("default test module imported");',
      'export const handlers = { search(context, options, args) {',
      '  console.log(JSON.stringify({ event: "handler", format: context.format, limit: options.limit, args }));',
      '} };',
    ].join('\n'),
  );
  state.defaults.splice(0, state.defaults.length, configured);
  state.ensure.mockReset();
  state.usable.mockReset().mockReturnValue(null);
  state.ensure.mockImplementation(async () => {
    state.usable.mockReturnValue({
      record,
      pkgDir: directory,
      manifest: readPluginPackageManifest(directory),
    });
    return record;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('lazy default command registration', () => {
  it('shows only the entry and preparation hint when the plugin is absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.fn();
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: write, writeErr: write });

    registerDefaultPluginCommands(program);

    expect(program.helpInformation()).toContain('catalog');
    await expect(
      program.parseAsync(['catalog', 'search', '--help'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
    expect(write.mock.calls.map(([value]) => value).join('')).not.toContain('--limit');
    expect(program.commands[0].description()).toContain('automatically');
    expect(program.commands[0].description()).not.toContain('plugin prepare');
    expect(state.ensure).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('installs a missing plugin and runs its handler in the same command invocation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command().option('--format <format>');
    registerDefaultPluginCommands(program);

    await program.parseAsync(['--format', 'text', 'catalog', 'search', 'pdf', '--limit', '3'], {
      from: 'user',
    });

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(state.ensure.mock.calls[0][0]).toEqual(configured);
    expect(log.mock.calls.map(([value]) => value)).toContain('default test module imported');
    expect(log.mock.calls.map(([value]) => value)).toContain(
      JSON.stringify({ event: 'handler', format: 'text', limit: '3', args: ['pdf'] }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an installed default lazy while rendering its help', () => {
    state.usable.mockReturnValue({
      record,
      pkgDir: directory,
      manifest: readPluginPackageManifest(directory),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();

    registerDefaultPluginCommands(program);

    expect(program.commands[0].helpInformation()).toContain('search');
    expect(state.ensure).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('exposes commands added by an independently upgraded compatible plugin', async () => {
    const upgraded = { ...record, version: '3.0.0' };
    const manifest = {
      ...declared,
      subcommands: [...(declared.subcommands ?? []), { command: 'list', handlerKey: 'search' }],
    };
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: upgraded.name, version: upgraded.version, qianwen: manifest }),
    );
    state.usable.mockReturnValue({
      record: upgraded,
      pkgDir: directory,
      manifest: readPluginPackageManifest(directory),
    });
    state.ensure.mockResolvedValue(upgraded);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();

    registerDefaultPluginCommands(program);

    expect(program.commands[0].commands.map((command) => command.name())).toContain('list');
    expect(state.ensure).not.toHaveBeenCalled();
    await program.parseAsync(['catalog', 'list'], { from: 'user' });
    expect(log.mock.calls.map(([value]) => value)).toContain(
      JSON.stringify({ event: 'handler', format: 'json', args: [] }),
    );
  });

  it('rejects a concurrent API policy change at the same version before importing', async () => {
    declared.apiPolicy = [{ product: 'TestPortal', actions: ['ReadEntry'], auth: 'optional' }];
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: record.name, version: record.version, qianwen: declared }),
    );

    state.usable.mockReturnValue({
      record,
      pkgDir: directory,
      manifest: readPluginPackageManifest(directory),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command();
    registerDefaultPluginCommands(program);
    state.ensure.mockImplementation(async () => {
      const manifest = { ...declared, apiPolicy: undefined };
      writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({ name: record.name, version: record.version, qianwen: manifest }),
      );
      return record;
    });

    await expect(
      program.parseAsync(['catalog', 'search', 'pdf'], { from: 'user' }),
    ).rejects.toBeInstanceOf(HandledError);

    expect(log).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([value]) => value).join('')).toMatch(/retry|(?:run|try).*again/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces an explicit-disable failure without importing or executing the handler', async () => {
    state.ensure.mockRejectedValue(
      Object.assign(new Error('Default plugin was explicitly removed'), {
        code: 'PLUGIN_DEFAULT_DISABLED',
        exitCode: 4,
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command();
    registerDefaultPluginCommands(program);

    await expect(
      program.parseAsync(['catalog', 'search', 'pdf'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 4 });

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
