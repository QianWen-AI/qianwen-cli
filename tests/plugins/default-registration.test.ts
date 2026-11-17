import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type { InstallResult } from '../../src/plugins/installer.js';
import type { InstalledPlugin, PluginManifest } from '../../src/plugins/manifest.js';
import { readInstalledManifest } from '../../src/plugins/manifest.js';
import { installLocalPlugin } from '../../src/plugins/installer.js';
import { ensureDefaultPlugin, installManagedPlugin } from '../../src/plugins/default-install.js';
import {
  collectReservedNames,
  registerDefaultPluginCommands,
  registerPluginCommands,
  loadInstalledPlugins,
} from '../../src/plugins/loader.js';
import { registerPluginManagementCommands } from '../../src/commands/plugin/index.js';

const state = vi.hoisted(() => ({
  defaults: [] as DefaultPlugin[],
  root: '',
  pluginsDir: '',
  manifestPath: '',
  install: vi.fn<(spec: string, directory: string) => Promise<InstallResult>>(),
}));

vi.mock('../../src/plugins/defaults.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/defaults.js')>()),
  getDefaultPlugins: () => state.defaults,
  getDefaultPlugin: (name: string) => state.defaults.find((item) => item.name === name),
}));
vi.mock('../../src/plugins/installer.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/installer.js')>()),
  installNpmPlugin: state.install,
}));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getPluginsDir: () => state.pluginsDir,
  getPluginsManifestPath: () => state.manifestPath,
}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => state.root;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({ 'output.format': 'json' }),
}));
vi.mock('../../src/auth/credentials.js', () => ({
  getCredentials: () => null,
  resolveCredentials: () => null,
  ensureAuthenticated: () => {
    throw new Error('Registration fixtures must not request credentials');
  },
}));
vi.mock('../../src/api/api-client.js', () => ({
  createApiClient: () => ({ callFlatApi: vi.fn() }),
}));
vi.mock('../../src/ui/render.js', () => ({
  renderWithInk: vi.fn(async () => {}),
  renderWithInkSync: vi.fn(async () => {}),
  renderInteractive: vi.fn(async () => {}),
}));

const catalogName = '@qianwenai/registration-catalog';
const exporterName = '@qianwenai/registration-exporter';
let packages: Map<string, string>;
let output: string[];
let errors: string[];

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    command: 'catalog',
    commandAliases: ['catg'],
    entry: './index.mjs',
    auth: 'optional',
    description: 'Local registration fixture',
    subcommands: [{ command: 'exporter [value]', handlerKey: 'run' }],
    ...overrides,
  };
}

function definition(name = catalogName, declared = manifest()): DefaultPlugin {
  return {
    name,
    version: '1.2.3',
    source: { type: 'npm' },
    command: declared.command,
    commandAliases: declared.commandAliases,
  };
}

function writePackage(directory: string, name: string, version: string, declared: PluginManifest) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version, qianwen: declared }),
  );
  writeFileSync(
    path.join(directory, 'index.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(path.join(state.root, 'imports.jsonl'))}, ${JSON.stringify(name + '\n')});`,
      'export const handlers = { run(context, options, args) {',
      `  console.log(JSON.stringify({ handled: ${JSON.stringify(name)}, args }));`,
      '} };',
    ].join('\n'),
  );
}

function seedInstalled(
  name = catalogName,
  declared = manifest(),
  version = '1.2.3',
): InstalledPlugin {
  writePackage(path.join(state.pluginsDir, 'node_modules', name), name, version, declared);
  return {
    name,
    version,
    enabled: true,
    source: 'npm',
    command: declared.command,
    commandAliases: declared.commandAliases,
  };
}

function writeInstalled(records: InstalledPlugin[]) {
  writeFileSync(state.manifestPath, JSON.stringify({ plugins: records }));
}

function providePackage(name: string, version: string, declared: PluginManifest) {
  const directory = path.join(state.root, 'registry', name, version);
  writePackage(directory, name, version, declared);
  packages.set(`${name}@${version}`, directory);
}

function context(): Parameters<typeof ensureDefaultPlugin>[1] {
  return {
    pluginsDir: state.pluginsDir,
    manifestPath: state.manifestPath,
    cliVersion: '1.10.0',
    definitions: state.defaults,
    reservedNames: collectReservedNames(program()),
  };
}

function program(): Command {
  const cli = new Command()
    .name('qianwen')
    .version('1.10.0')
    .option('--format <format>')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => errors.push(value),
    });
  cli.command('models').alias('m').command('inspect').alias('details');
  registerPluginManagementCommands(cli);
  return cli;
}

function packageSnapshot(name = catalogName): string[] {
  return [
    state.manifestPath,
    path.join(state.pluginsDir, 'node_modules', name, 'package.json'),
    path.join(state.pluginsDir, 'node_modules', name, 'index.mjs'),
  ].map((file) => readFileSync(file, 'utf8'));
}

function expectOffline() {
  expect(state.install).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

const invalidTrees: { label: string; declared: PluginManifest }[] = [
  {
    label: 'duplicate sibling command names',
    declared: manifest({
      subcommands: [
        { command: 'search', handlerKey: 'run' },
        { command: 'search [query]', handlerKey: 'run' },
      ],
    }),
  },
  {
    label: 'a sibling alias that hides another command',
    declared: manifest({
      subcommands: [
        { command: 'search', commandAliases: ['lookup'], handlerKey: 'run' },
        { command: 'lookup', handlerKey: 'run' },
      ],
    }),
  },
  {
    label: 'a variadic argument followed by another argument',
    declared: manifest({
      subcommands: [{ command: 'search [queries...] [extra]', handlerKey: 'run' }],
    }),
  },
  {
    label: 'duplicate sibling names in a deeper command group',
    declared: manifest({
      subcommands: [
        {
          command: 'group',
          subcommands: [
            { command: 'search', handlerKey: 'run' },
            { command: 'search [query]', handlerKey: 'run' },
          ],
        },
      ],
    }),
  },
];

beforeEach(() => {
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  state.root = mkdtempSync(path.join(temporaryRoot, 'default-registration-'));
  state.pluginsDir = path.join(state.root, 'plugins');
  state.manifestPath = path.join(state.root, 'plugins.json');
  state.defaults.splice(0, state.defaults.length, definition());
  packages = new Map();
  output = [];
  errors = [];
  state.install.mockReset().mockImplementation(async (spec, directory) => {
    const candidate = packages.get(spec);
    if (!candidate) return { ok: false, error: `No local fixture for ${spec}` };
    return installLocalPlugin(candidate, directory);
  });
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => output.push(String(value)));
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    errors.push(String(value));
    return true;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Registration fixtures forbid network access');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(state.root, { recursive: true, force: true });
});

describe('installed invalid default command trees do not prevent CLI recovery', () => {
  it.each(invalidTrees)('keeps help and version available for $label', async ({ declared }) => {
    writeInstalled([seedInstalled(catalogName, declared)]);
    const before = packageSnapshot();

    for (const args of [['--help'], ['--version'], ['catalog', '--help'], ['catg', '--help']]) {
      const cli = program();
      expect(() => registerDefaultPluginCommands(cli)).not.toThrow();
      await expect(cli.parseAsync(args, { from: 'user' })).rejects.toMatchObject({ exitCode: 0 });
      const entry = cli.commands.find((command) => command.name() === 'catalog');
      expect(entry).toBeDefined();
      expect(entry?.commands).toHaveLength(0);
    }

    expect(output.join('')).toContain('1.10.0');
    expect(output.join('')).toContain('catalog');
    expect(packageSnapshot()).toEqual(before);
    expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
    expectOffline();
  });

  it('can list and uninstall the invalid installed default through the CLI', async () => {
    writeInstalled([seedInstalled(catalogName, invalidTrees[0].declared)]);
    const cli = program();
    expect(() => registerDefaultPluginCommands(cli)).not.toThrow();

    await cli.parseAsync(['plugin', 'list', '--format', 'json'], { from: 'user' });

    expect(output.join('')).toContain(catalogName);
    output.length = 0;
    await cli.parseAsync(['plugin', 'uninstall', catalogName, '--format', 'json'], {
      from: 'user',
    });

    expect(output.join('')).toContain(catalogName);
    expect(readInstalledManifest(state.manifestPath).plugins).toEqual([]);
    expect(readInstalledManifest(state.manifestPath).disabledDefaults).toContain(catalogName);
    expect(existsSync(path.join(state.pluginsDir, 'node_modules', catalogName))).toBe(false);
    expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
    expectOffline();
  });

  it('keeps a healthy default executable beside an invalid one', async () => {
    const healthy = manifest({
      command: 'exporter',
      commandAliases: [],
      subcommands: [{ command: 'send <value>', handlerKey: 'run' }],
    });
    state.defaults.push(definition(exporterName, healthy));
    writeInstalled([
      seedInstalled(catalogName, invalidTrees[0].declared),
      seedInstalled(exporterName, healthy),
    ]);
    const cli = program();
    expect(() => registerDefaultPluginCommands(cli)).not.toThrow();

    await cli.parseAsync(['exporter', 'send', 'healthy'], { from: 'user' });

    expect(output.join('')).toContain(JSON.stringify({ handled: exporterName, args: ['healthy'] }));
    expect(readFileSync(path.join(state.root, 'imports.jsonl'), 'utf8')).toBe(`${exporterName}\n`);
    expectOffline();
  });

  it('removes a partially registered tree after an unexpected runtime registration failure', async () => {
    writeInstalled([seedInstalled()]);
    const cli = program();
    const createCommand = Command.prototype.createCommand;
    let injected = false;
    vi.spyOn(Command.prototype, 'createCommand').mockImplementation(function (this: Command, name) {
      if (!injected && this.parent === cli && this.name() === 'catalog' && name === 'exporter') {
        injected = true;
        throw new Error('Synthetic command registration failure');
      }
      return createCommand.call(this, name);
    });

    expect(() => registerDefaultPluginCommands(cli)).not.toThrow();

    expect(injected).toBe(true);
    const entries = cli.commands.filter((command) => command.name() === 'catalog');
    expect(entries).toHaveLength(1);
    expect(entries[0].commands).toHaveLength(0);
    expect(entries[0].aliases()).toContain('catg');
    await expect(cli.parseAsync(['catalog', '--help'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 0,
    });
    expect(output.join('')).toMatch(/unavailable|不可用|automatically|plugin install/i);
    expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
    expectOffline();
  });
});

describe('installation rejects invalid command trees before replacing a usable package', () => {
  it.each([
    { command: 'Q', commandAliases: [] },
    { command: 'catalog', commandAliases: ['Exit'] },
  ])('rejects reserved host routes in prepared metadata: %j', async (routes) => {
    providePackage(catalogName, '1.2.3', manifest(routes));
    await expect(ensureDefaultPlugin(state.defaults[0], context())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/reserved by a built-in command/),
    });
    expect(readInstalledManifest(state.manifestPath).plugins).toEqual([]);
    expect(existsSync(path.join(state.pluginsDir, 'node_modules', catalogName))).toBe(false);
    expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(invalidTrees)('rejects a first installation with $label', async ({ declared }) => {
    providePackage(catalogName, '1.2.3', declared);

    await expect(ensureDefaultPlugin(state.defaults[0], context())).rejects.toThrow();

    expect(readInstalledManifest(state.manifestPath).plugins).toEqual([]);
    expect(existsSync(path.join(state.pluginsDir, 'node_modules', catalogName))).toBe(false);
    expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(invalidTrees)('rolls back an explicit update with $label', async ({ declared }) => {
    writeInstalled([seedInstalled()]);
    const before = packageSnapshot();
    providePackage(catalogName, '3.0.0', declared);

    await expect(installManagedPlugin(`${catalogName}@3.0.0`, context())).rejects.toThrow();

    expect(packageSnapshot()).toEqual(before);
    expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves an installed lower version when default preparation receives an invalid tree', async () => {
    writeInstalled([seedInstalled(catalogName, manifest(), '1.0.0')]);
    const before = packageSnapshot();
    providePackage(catalogName, '1.2.3', invalidTrees[0].declared);

    await expect(ensureDefaultPlugin(state.defaults[0], context())).rejects.toThrow();

    expect(packageSnapshot()).toEqual(before);
    expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('plugin child commands occupy their parent namespace only', () => {
  it.each(['inspect', 'details'])(
    'keeps a built-in child route when an installed plugin adds the top-level alias %s',
    async (alias) => {
      writeInstalled([seedInstalled(catalogName, manifest({ commandAliases: ['catg', alias] }))]);
      const cli = program();
      const builtin = vi.fn();
      cli.commands.find((command) => command.name() === 'models')?.commands[0].action(builtin);

      expect(() => registerDefaultPluginCommands(cli)).not.toThrow();
      await cli.parseAsync(['models', alias], { from: 'user' });

      expect(builtin).toHaveBeenCalledOnce();
      expect(cli.commands.some((command) => command.aliases().includes(alias))).toBe(true);
      expect(existsSync(path.join(state.root, 'imports.jsonl'))).toBe(false);
      await cli.parseAsync([alias, 'exporter', 'top-level'], { from: 'user' });
      expect(output).toContain(JSON.stringify({ handled: catalogName, args: ['top-level'] }));
      expect(builtin).toHaveBeenCalledOnce();
      expectOffline();
    },
  );

  it.each(
    [
      { child: 'name', alias: false, reverse: false },
      { child: 'name', alias: false, reverse: true },
      { child: 'alias', alias: true, reverse: false },
      { child: 'alias', alias: true, reverse: true },
    ].flatMap((testCase) =>
      [false, true].map((topAlias) => ({
        ...testCase,
        topAlias,
        label: `child ${testCase.child}, top-level ${topAlias ? 'alias' : 'name'}, ${testCase.reverse ? 'exporter' : 'catalog'} first`,
      })),
    ),
  )('executes both independent routes with $label', async ({ alias, reverse, topAlias }) => {
    const catalog = manifest({
      subcommands: [
        {
          command: alias ? 'search [value]' : 'exporter [value]',
          commandAliases: alias ? ['exporter'] : [],
          handlerKey: 'run',
        },
      ],
    });
    const exporter = manifest({
      command: topAlias ? 'publisher' : 'exporter',
      commandAliases: topAlias ? ['exporter', 'exp'] : ['exp'],
      subcommands: [{ command: 'send <value>', handlerKey: 'run' }],
    });
    const definitions = [definition(catalogName, catalog), definition(exporterName, exporter)];
    state.defaults.splice(
      0,
      state.defaults.length,
      ...(reverse ? definitions.reverse() : definitions),
    );
    writeInstalled([seedInstalled(catalogName, catalog), seedInstalled(exporterName, exporter)]);
    const cli = program();

    expect(() => registerDefaultPluginCommands(cli)).not.toThrow();
    await cli.parseAsync(['catalog', 'exporter', 'nested'], { from: 'user' });
    await cli.parseAsync(['exporter', 'send', 'top'], { from: 'user' });
    await cli.parseAsync(['exp', 'send', 'alias'], { from: 'user' });

    expect(output).toContain(JSON.stringify({ handled: catalogName, args: ['nested'] }));
    expect(output).toContain(JSON.stringify({ handled: exporterName, args: ['top'] }));
    expect(output).toContain(JSON.stringify({ handled: exporterName, args: ['alias'] }));
    expect(cli.commands.filter((command) => command.name() === exporter.command)).toHaveLength(1);
    expectOffline();
  });

  it.each(['catalog', 'catg'])(
    'still rejects a second plugin claiming the top-level name or alias %s',
    async (command) => {
      writeInstalled([seedInstalled()]);
      providePackage(
        exporterName,
        '1.2.3',
        manifest({ command, commandAliases: [], subcommands: undefined, handlerKey: 'run' }),
      );
      const before = packageSnapshot();

      await expect(installManagedPlugin(`${exporterName}@1.2.3`, context())).rejects.toThrow();

      expect(packageSnapshot()).toEqual(before);
      expect(existsSync(path.join(state.pluginsDir, 'node_modules', exporterName))).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['models', 'm'])(
    'continues reserving the existing built-in name or alias %s',
    async (command) => {
      providePackage(
        exporterName,
        '1.2.3',
        manifest({ command, commandAliases: [], subcommands: undefined, handlerKey: 'run' }),
      );

      await expect(installManagedPlugin(`${exporterName}@1.2.3`, context())).rejects.toThrow();

      expect(readInstalledManifest(state.manifestPath).plugins).toEqual([]);
      expect(existsSync(path.join(state.pluginsDir, 'node_modules', exporterName))).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('installed top-level commands coexist with built-in children', () => {
  it.each(['inspect', 'details'])(
    'installs %s and keeps models child routing independent',
    async (command) => {
      providePackage(
        exporterName,
        '1.2.3',
        manifest({ command, commandAliases: [], subcommands: undefined, handlerKey: 'run' }),
      );
      await installManagedPlugin(`${exporterName}@1.2.3`, context());
      const cli = program();
      const builtin = vi.fn();
      cli.commands.find((item) => item.name() === 'models')?.commands[0].action(builtin);
      registerPluginCommands(cli, loadInstalledPlugins(state.manifestPath, state.pluginsDir));
      await cli.parseAsync([command], { from: 'user' });
      expect(output).toContain(JSON.stringify({ handled: exporterName, args: [] }));
      expect(builtin).not.toHaveBeenCalled();
      await cli.parseAsync(['models', command], { from: 'user' });
      expect(builtin).toHaveBeenCalledOnce();
      expect(readInstalledManifest(state.manifestPath).plugins[0].command).toBe(command);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
