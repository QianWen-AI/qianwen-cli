import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import { registerPluginManagementCommands } from '../../../src/commands/plugin/index.js';
import { loadInstalledPlugins, registerPluginCommands } from '../../../src/plugins/loader.js';
import { renderWithInk } from '../../../src/ui/render.js';
import { CliError } from '../../../src/utils/errors.js';
import type { PluginManifest } from '../../../src/plugins/manifest.js';
import { runCommand, type RunResult } from '../../helpers/run-command.js';
import { clearRenderedFrames, lastRenderedFrame } from '../../helpers/ink-render-mock.js';
import { projectTmpdir } from '../../fixtures/plugin-temporary-root.js';

const state = vi.hoisted(() => ({ root: '', repl: false }));
vi.mock('../../../src/utils/runtime-mode.js', async (original) => ({
  ...(await original<typeof import('../../../src/utils/runtime-mode.js')>()),
  isReplMode: () => state.repl,
}));
vi.mock('../../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../../src/config/paths.js')>()),
  getConfigDir: () => state.root,
  getPluginsDir: () => join(state.root, 'plugins'),
  getPluginsManifestPath: () => join(state.root, 'plugins.json'),
}));
vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  getCredentials: () => null,
  resolveCredentials: () => null,
  ensureAuthenticated: () => {
    throw new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Fixture authentication rejected',
      exitCode: 2,
    });
  },
}));
vi.mock('../../../src/ui/render.js', async () => {
  const { renderInkForTest } = await import('../../helpers/ink-render-mock.js');
  return {
    renderWithInk: vi.fn(renderInkForTest),
    renderWithInkSync: vi.fn(),
    renderInteractive: vi.fn(),
  };
});

const formats = ['json', 'text', 'table'] as const;
type Format = (typeof formats)[number];
const restartWarning =
  'warning: Restart this REPL session for the installed plugin code and its dependencies to take effect.\n';
const localWarning =
  'warning: local plugins are unreviewed and run in the same process as the CLI (full credential access).\n';
let originalExitCode: typeof process.exitCode;
let name: string;
let source: string;
let marker: string;
let manifest: PluginManifest;

beforeEach(() => {
  state.root = mkdtempSync(join(projectTmpdir(), 'install-restart-'));
  name = `@qianwenai/${basename(state.root).toLowerCase()}`;
  source = join(state.root, 'source');
  marker = join(state.root, 'evaluated.txt');
  manifest = {
    command: 'probe',
    commandAliases: ['p'],
    entry: './entry.mjs',
    handlerKey: 'run',
    auth: 'optional',
  };
  mkdirSync(source);
  writePackage();
  writeFileSync(
    join(source, 'entry.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'evaluated'); export const handlers = { run() { console.log('executed'); } };`,
  );
  writeFileSync(join(state.root, 'plugins.json'), JSON.stringify({ plugins: [] }));
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  state.repl = false;
  clearRenderedFrames();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network');
    }),
  );
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.repl = false;
    process.exitCode = originalExitCode;
    rmSync(state.root, { recursive: true, force: true });
  }
});

function writePackage(
  version = '1.0.0',
  packageName = name,
  directory = source,
  pluginManifest = manifest,
): void {
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: packageName, version, qianwen: pluginManifest }),
  );
}

function build(program: Command): void {
  registerPluginManagementCommands(program);
  registerPluginCommands(
    program,
    loadInstalledPlugins(join(state.root, 'plugins.json'), join(state.root, 'plugins')),
  );
}

function install(format: Format = 'json', directory = source): Promise<RunResult> {
  return runCommand(build, ['plugin', 'install', directory, '--format', format]);
}

async function installAndExecute(command = 'probe'): Promise<void> {
  const installed = await install();
  expect(installed.exitCode).toBeUndefined();
  const executed = await runCommand(build, [command, '--format', 'json']);
  expect(executed.exitCode).toBeUndefined();
  expect(executed.stdout).toBe('executed');
  expect(readFileSync(marker, 'utf8')).toBe('evaluated');
}

function expectSuccess(
  result: RunResult,
  format: Format,
  restart: boolean,
  packageName = name,
  version = '1.0.0',
): void {
  expect(result.exitCode).toBeUndefined();
  expect(process.exitCode).toBe(0);
  expect(result.stderr).toBe(restart ? `${localWarning}\n${restartWarning}` : localWarning);
  if (format === 'json') {
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ installed: packageName, source: 'local' });
    if (restart) expect(payload.restartRequired).toBe(true);
    else expect(payload).not.toHaveProperty('restartRequired');
  } else if (format === 'text') {
    expect(result.stdout).toContain(`Installed ${packageName}`);
    expect(result.stdout).not.toContain('\u001b[');
  } else {
    expect(result.stdout).toBe('');
    expect(renderWithInk).toHaveBeenCalledOnce();
    expect(lastRenderedFrame()).toContain(`Installed ${packageName}`);
    expect(lastRenderedFrame()).toContain('(local)');
  }
  const installed = JSON.parse(readFileSync(join(state.root, 'plugins.json'), 'utf8')) as {
    plugins: Array<{ name: string; version: string }>;
  };
  expect(installed.plugins.find((plugin) => plugin.name === packageName)?.version).toBe(version);
}

describe('REPL installation restart messages', () => {
  it.each(formats)(
    'first install in %s is immediately usable without a restart warning',
    async (format) => {
      state.repl = true;
      const result = await install(format);
      expectSuccess(result, format, false);
      expect(existsSync(marker)).toBe(false);
      const executed = await runCommand(build, ['p', '--format', 'json']);
      expect(executed.exitCode).toBeUndefined();
      expect(executed.stdout).toBe('executed');
    },
  );

  it.each(formats)(
    'replacement in %s after only registration, help and validation needs no restart',
    async (format) => {
      expect((await install()).exitCode).toBeUndefined();
      state.repl = true;
      for (const command of ['probe', 'p']) {
        const help = await runCommand(build, [command, '--help']);
        expect(help.exitCode).toBeUndefined();
      }
      const validated = await runCommand(build, ['plugin', 'validate', source, '--format', 'json']);
      expect(JSON.parse(validated.stdout).summary.errors).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expectSuccess(await install(format), format, false);
    },
  );

  it.each(formats)(
    'replacement in %s after canonical execution requires restart',
    async (format) => {
      await installAndExecute();
      state.repl = true;
      expectSuccess(await install(format), format, true);
    },
  );

  it.each(formats)('replacement in %s after alias execution requires restart', async (format) => {
    await installAndExecute('p');
    state.repl = true;
    expectSuccess(await install(format), format, true);
  });

  it.each(formats)(
    'shell replacement in %s never emits the REPL warning even after import',
    async (format) => {
      await installAndExecute();
      expectSuccess(await install(format), format, false);
    },
  );

  it.each(formats)(
    'installing another package in %s is independent of the imported package',
    async (format) => {
      await installAndExecute();
      const otherName = `${name}-other`;
      const otherSource = join(state.root, 'other');
      mkdirSync(otherSource);
      writePackage('1.0.0', otherName, otherSource, {
        command: 'other-probe',
        entry: './entry.mjs',
        handlerKey: 'run',
        auth: 'optional',
      });
      writeFileSync(join(otherSource, 'entry.mjs'), 'export const handlers = { run() {} };');
      state.repl = true;
      expectSuccess(await install(format, otherSource), format, false, otherName);
    },
  );

  it.each(formats)(
    'failed replacement in %s does not emit a success warning or replace the installation',
    async (format) => {
      await installAndExecute();
      const manifestBefore = readFileSync(join(state.root, 'plugins.json'), 'utf8');
      writeFileSync(join(source, 'package.json'), '{invalid package metadata');
      state.repl = true;
      const result = await install(format);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(restartWarning);
      expect(result.stderr).not.toContain('restartRequired');
      expect(readFileSync(join(state.root, 'plugins.json'), 'utf8')).toBe(manifestBefore);
      expect(renderWithInk).not.toHaveBeenCalled();
    },
  );

  it('keeps restart state across same-version reinstall, upgrade and uninstall/reinstall', async () => {
    await installAndExecute('p');
    state.repl = true;
    expectSuccess(await install(), 'json', true);
    writePackage('2.0.0');
    expectSuccess(await install(), 'json', true, name, '2.0.0');
    const removed = await runCommand(build, ['plugin', 'uninstall', name, '--format', 'json']);
    expect(removed.exitCode).toBeUndefined();
    expect(
      loadInstalledPlugins(join(state.root, 'plugins.json'), join(state.root, 'plugins')),
    ).toHaveLength(0);
    expectSuccess(await install(), 'json', true, name, '2.0.0');
  });

  it('does not require restart after authentication blocks execution before import', async () => {
    manifest.auth = 'required';
    writePackage();
    expect((await install()).exitCode).toBeUndefined();
    const rejected = await runCommand(build, ['p', '--format', 'json']);
    expect(rejected.exitCode).toBe(2);
    expect(JSON.parse(rejected.stderr).error.code).toBe('AUTH_REQUIRED');
    expect(existsSync(marker)).toBe(false);
    state.repl = true;
    expectSuccess(await install(), 'json', false);
  });

  it('requires restart after failed evaluation has already imported a dependency', async () => {
    writeFileSync(
      join(source, 'dependency.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'dependency evaluated');`,
    );
    writeFileSync(
      join(source, 'entry.mjs'),
      'import "./dependency.mjs"; throw new Error("fixture evaluation failed");',
    );
    expect((await install()).exitCode).toBeUndefined();
    const failed = await runCommand(build, ['probe', '--format', 'json']);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('fixture evaluation failed');
    expect(readFileSync(marker, 'utf8')).toBe('dependency evaluated');
    state.repl = true;
    expectSuccess(await install(), 'json', true);
  });
});
