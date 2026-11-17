import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type { InstalledPlugin, PluginManifest } from '../../src/plugins/manifest.js';
import { registerDefaultPluginCommands } from '../../src/plugins/loader.js';

const state = vi.hoisted(() => ({
  defaults: [] as DefaultPlugin[],
  root: '',
  pluginsDir: '',
  manifestPath: '',
  ensure: vi.fn(),
  usable: vi.fn(),
}));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => state.defaults,
  getDefaultPlugin: (name: string) => state.defaults.find((item) => item.name === name),
}));
vi.mock('../../src/plugins/default-install.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/default-install.js')>()),
  ensureDefaultPlugin: state.ensure,
  readUsableDefaultPlugin: state.usable,
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
    throw new Error('An optional-auth fixture must not request real credentials');
  },
}));
vi.mock('../../src/api/api-client.js', () => ({
  createApiClient: () => ({ callFlatApi: vi.fn() }),
}));

let directory: string;
let marker: string;
let configured: DefaultPlugin;
let currentRecord: InstalledPlugin;
let currentManifest: PluginManifest;
let output: string[];

function manifest(): PluginManifest {
  return {
    command: 'catalog',
    commandAliases: ['catg'],
    entry: './index.mjs',
    auth: 'optional',
    minCliVersion: '1.0.0',
    description: 'Catalog from the installed package',
    subcommands: [
      {
        command: 'explore [query]',
        description: 'New independently shipped exploration command',
        handlerKey: 'explore',
        options: [
          { flag: '--locale <locale>', description: 'Result language' },
          { flag: '--query <query>', description: 'Query expression' },
        ],
      },
    ],
  };
}

function publishInstalled(version = configured.version, installedManifest = manifest()): void {
  currentManifest = installedManifest;
  currentRecord = {
    name: configured.name,
    version,
    source: 'npm',
    enabled: true,
    command: installedManifest.command,
    commandAliases: installedManifest.commandAliases,
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: configured.name,
      version,
      main: './index.mjs',
      qianwen: installedManifest,
    }),
  );
  writeFileSync(
    path.join(directory, 'index.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      'appendFileSync(marker, JSON.stringify({ event: "import" }) + "\\n");',
      'export const handlers = {',
      '  explore(context, options, args) {',
      '    appendFileSync(marker, JSON.stringify({ event: "handler", format: context.format, options, args }) + "\\n");',
      '  },',
      '  old() { appendFileSync(marker, JSON.stringify({ event: "old-handler" }) + "\\n"); },',
      '};',
    ].join('\n'),
  );
  writeFileSync(state.manifestPath, JSON.stringify({ plugins: [currentRecord] }));
  state.usable.mockReturnValue({
    record: currentRecord,
    pkgDir: directory,
    manifest: currentManifest,
  });
}

interface Event {
  event: string;
  format?: string;
  options?: Record<string, unknown>;
  args?: (string | null)[];
}

function events(): Event[] {
  if (!existsSync(marker)) return [];
  return readFileSync(marker, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event);
}

function program(): Command {
  return new Command()
    .name('qianwen')
    .version('1.10.0-plugin.5')
    .option('--format <format>')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  state.root = mkdtempSync(path.join(temporaryRoot, 'preload-dispatch-'));
  state.pluginsDir = path.join(state.root, 'plugins');
  state.manifestPath = path.join(state.root, 'plugins.json');
  marker = path.join(state.root, 'events.jsonl');
  configured = {
    name: '@qianwenai/preload-dispatch',
    version: '1.2.3',
    command: 'catalog',
    commandAliases: ['catg'],
    source: { type: 'npm', registry: 'https://registry.test.qianwenai.com/' },
  };
  directory = path.join(state.pluginsDir, 'node_modules', configured.name);
  output = [];
  state.defaults.splice(0, state.defaults.length, configured);
  state.usable.mockReset().mockReturnValue(null);
  state.ensure.mockReset().mockImplementation(async () => {
    publishInstalled();
    return currentRecord;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Dispatch fixtures must never make network requests');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(state.root, { recursive: true, force: true });
});

describe('preload dispatch parses the manifest available after preparation', () => {
  it.each(['catalog', 'catg'])(
    'installs then executes a new subcommand and option once through %s',
    async (command) => {
      const cli = program();
      registerDefaultPluginCommands(cli);
      const argv = ['--format', 'text', command, 'explore', 'pdf', '--locale', 'zh'];
      const originalArgv = [...argv];

      await cli.parseAsync(argv, { from: 'user' });

      expect(state.ensure).toHaveBeenCalledOnce();
      expect(state.ensure.mock.calls[0][0]).toEqual(configured);
      expect(events()).toEqual([
        { event: 'import' },
        expect.objectContaining({
          event: 'handler',
          format: 'text',
          options: expect.objectContaining({ locale: 'zh' }),
          args: ['pdf'],
        }),
      ]);
      expect(argv).toEqual(originalArgv);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('waits for preparation before importing or executing the actual command', async () => {
    const gate = deferred();
    state.ensure.mockImplementation(async () => {
      await gate.promise;
      publishInstalled();
      return currentRecord;
    });
    const cli = program();
    registerDefaultPluginCommands(cli);
    const result = cli.parseAsync(['catalog', 'explore', 'pdf'], { from: 'user' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(state.ensure).toHaveBeenCalledOnce());
    expect(events()).toEqual([]);

    gate.resolve();

    expect(await result).toBeUndefined();
    expect(events().filter((event) => event.event === 'handler')).toHaveLength(1);
  });

  it('upgrades an installed old command tree before checking whether the new subcommand exists', async () => {
    publishInstalled('1.0.0', {
      ...manifest(),
      subcommands: [{ command: 'search [query]', handlerKey: 'old' }],
    });
    const cli = program();
    registerDefaultPluginCommands(cli);

    await cli.parseAsync(['catalog', 'explore', 'new', '--locale=en', '--format=json'], {
      from: 'user',
    });

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(events().filter((event) => event.event === 'old-handler')).toEqual([]);
    expect(events().filter((event) => event.event === 'handler')).toEqual([
      expect.objectContaining({
        format: 'json',
        args: ['new'],
        options: expect.objectContaining({ locale: 'en' }),
      }),
    ]);
  });

  it('uses changed options and handler metadata returned by preparation for an existing command', async () => {
    publishInstalled('1.0.0', {
      ...manifest(),
      subcommands: [{ command: 'explore [query]', handlerKey: 'old' }],
    });
    const cli = program();
    registerDefaultPluginCommands(cli);

    await cli.parseAsync(['catalog', 'explore', 'pdf', '--locale', 'zh'], { from: 'user' });

    expect(events().map((event) => event.event)).toEqual(['import', 'handler']);
    expect(events()[1].options).toMatchObject({ locale: 'zh' });
  });

  it('executes an explicitly declared business subcommand named help', async () => {
    const installedManifest: PluginManifest = {
      ...manifest(),
      subcommands: [{ command: 'help [topic]', handlerKey: 'explore' }],
    };
    publishInstalled(configured.version, installedManifest);
    state.ensure.mockResolvedValue(currentRecord);
    const cli = program();
    registerDefaultPluginCommands(cli);

    await cli.parseAsync(['catalog', 'help', 'tools'], { from: 'user' });

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(events()).toEqual([
      { event: 'import' },
      expect.objectContaining({ event: 'handler', args: ['tools'] }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['catalog', 'explore', 'help'],
    ['catalog', 'explore', '--', 'help'],
  ])('preserves help as an argument of an installed leaf command: %j', async (...args) => {
    publishInstalled();
    state.ensure.mockResolvedValue(currentRecord);
    const cli = program();
    registerDefaultPluginCommands(cli);

    await cli.parseAsync(args, { from: 'user' });

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(events()).toEqual([
      { event: 'import' },
      expect.objectContaining({ event: 'handler', args: ['help'] }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ['catalog', 'explore', '--', '--help'],
      expectedArgs: ['--help'],
      expectedQuery: undefined,
    },
    {
      args: ['catalog', 'explore', '--query=--help'],
      expectedArgs: [null],
      expectedQuery: '--help',
    },
  ])(
    'treats help-like values as business arguments: $args',
    async ({ args, expectedArgs, expectedQuery }) => {
      const cli = program();
      registerDefaultPluginCommands(cli);

      await cli.parseAsync(args, { from: 'user' });

      expect(state.ensure).toHaveBeenCalledOnce();
      const handled = events().filter((event) => event.event === 'handler');
      expect(handled).toHaveLength(1);
      expect(handled[0].args).toEqual(expectedArgs);
      expect(handled[0].options?.query).toBe(expectedQuery);
    },
  );

  it('keeps exitOverride on the actual parser when a newly installed command receives an invalid option', async () => {
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(
      cli.parseAsync(['catalog', 'explore', '--not-a-real-option'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(events()).toEqual([]);
    expect(output.join('')).toContain('--not-a-real-option');
  });

  it.each([
    { code: 'PLUGIN_DEFAULT_DISABLED', exitCode: 4 },
    { code: 'PLUGIN_INSTALL_FAILED', exitCode: 3 },
    { code: 'CANCELLED', exitCode: 130 },
  ])('never imports or executes when preparation fails with $code', async ({ code, exitCode }) => {
    state.ensure.mockRejectedValue(
      Object.assign(new Error(`synthetic ${code}`), { code, exitCode }),
    );
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(
      cli.parseAsync(['catalog', 'explore', 'pdf'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode });

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('help uses available local metadata and never prepares a plugin', () => {
  it.each(['catalog', 'catg'])(
    'uses the root help command to inspect an uninstalled entry offline: %s',
    async (command) => {
      const cli = program();
      registerDefaultPluginCommands(cli);

      await expect(cli.parseAsync(['help', command], { from: 'user' })).rejects.toMatchObject({
        exitCode: 0,
      });

      expect(output.join('')).toMatch(
        /未安装|未下载|not installed|not downloaded|plugin (?:install|prepare)/i,
      );
      expect(output.join('')).not.toContain('--locale');
      expect(state.ensure).not.toHaveBeenCalled();
      expect(events()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('uses the installed group help command to inspect a declared child offline', async () => {
    publishInstalled();
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(
      cli.parseAsync(['catalog', 'help', 'explore'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 0 });

    expect(output.join('')).toContain('--locale');
    expect(state.ensure).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['catalog', '--mode', 'safe', 'help', 'explore'],
    ['catalog', '--mode', 'help', 'help', 'explore'],
    ['catalog', '--mode=help', 'help', 'explore'],
    ['catalog', '-m', 'safe', 'help', 'explore'],
    ['catalog', '-mhelp', 'help', 'explore'],
    ['catalog', '-qmhelp', 'help', 'explore'],
  ])('keeps lower-version group help offline after declared options: %j', async (...args) => {
    publishInstalled('1.0.0', {
      ...manifest(),
      options: [
        { flag: '-m, --mode <mode>', description: 'Catalog mode' },
        { flag: '-q, --quiet', description: 'Quiet output' },
      ],
    });
    const before = readFileSync(path.join(directory, 'package.json'), 'utf8');
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(cli.parseAsync(args, { from: 'user' })).rejects.toMatchObject({ exitCode: 0 });

    expect(output.join('')).toContain('--locale');
    expect(readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(before);
    expect(state.ensure).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a lower-version group help route offline when its separator follows help', async () => {
    publishInstalled('1.0.0');
    const before = readFileSync(path.join(directory, 'package.json'), 'utf8');
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(
      cli.parseAsync(['catalog', 'help', 'explore', '--'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 0 });

    expect(output.join('')).toContain('--locale');
    expect(readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(before);
    expect(state.ensure).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prioritizes real help for an installed child over missing arguments and unknown options', async () => {
    publishInstalled(configured.version, {
      ...manifest(),
      subcommands: [
        {
          command: 'explore <query>',
          handlerKey: 'explore',
          options: [{ flag: '--locale <locale>', description: 'Result language' }],
        },
      ],
    });
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(
      cli.parseAsync(['catalog', 'explore', '--not-a-real-option', '--help'], {
        from: 'user',
      }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });

    expect(output.join('')).toContain('--locale');
    expect(output.join('')).toContain('<query>');
    expect(state.ensure).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['catalog', '--help'],
    ['catg', '--help'],
    ['catalog', 'explore', '--help'],
    ['catalog', 'explore', '--query', '--help'],
  ])('shows only an uninstalled entry and an installation hint for %j', async (...args) => {
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(cli.parseAsync(args, { from: 'user' })).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
    });

    expect(output.join('')).toMatch(
      /未安装|未下载|not installed|not downloaded|plugin (?:install|prepare)/i,
    );
    expect(output.join('')).not.toContain('--locale');
    expect(cli.commands.find((item) => item.name() === 'catalog')?.commands).toHaveLength(0);
    expect(state.ensure).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('can display the actual installed lower-version help without upgrading or importing it', async () => {
    publishInstalled('1.0.0', {
      ...manifest(),
      subcommands: [
        {
          command: 'search [query]',
          handlerKey: 'old',
          options: [{ flag: '--legacy', description: 'Legacy flag' }],
        },
      ],
    });
    const before = readFileSync(path.join(directory, 'package.json'), 'utf8');
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(
      cli.parseAsync(['catalog', 'search', '--help'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' });

    expect(output.join('')).toContain('--legacy');
    expect(output.join('')).not.toContain('--locale');
    expect(readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(before);
    expect(state.ensure).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['--help'], code: 'commander.helpDisplayed' },
    { args: ['--version'], code: 'commander.version' },
  ])('keeps global inspection offline: $args', async ({ args, code }) => {
    const cli = program();
    registerDefaultPluginCommands(cli);

    await expect(cli.parseAsync(args, { from: 'user' })).rejects.toMatchObject({ code });

    expect(state.ensure).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
