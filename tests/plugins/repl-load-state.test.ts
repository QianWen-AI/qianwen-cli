import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import * as loader from '../../src/plugins/loader.js';
import type { PluginManifest } from '../../src/plugins/manifest.js';
import { registerPluginManagementCommands } from '../../src/commands/plugin/index.js';
import { CliError } from '../../src/utils/errors.js';
import { runCommand } from '../helpers/run-command.js';
import { projectTmpdir } from '../fixtures/plugin-temporary-root.js';

const state = vi.hoisted(() => ({ root: '', authCode: 'AUTH_REQUIRED' }));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getConfigDir: () => state.root,
  getPluginsDir: () => join(state.root, 'plugins'),
  getPluginsManifestPath: () => join(state.root, 'plugins.json'),
}));
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../src/auth/credentials.js', () => ({
  getCredentials: () => null,
  resolveCredentials: () => null,
  ensureAuthenticated: () => {
    throw new CliError({
      code: state.authCode,
      message: 'Fixture authentication rejected',
      exitCode: 2,
    });
  },
}));

let originalExitCode: typeof process.exitCode;
let name: string;
let pkgDir: string;
let marker: string;
let manifest: PluginManifest;

beforeEach(() => {
  state.root = mkdtempSync(join(projectTmpdir(), 'repl-load-'));
  state.authCode = 'AUTH_REQUIRED';
  name = `@qianwenai/${basename(state.root).toLowerCase()}`;
  pkgDir = join(state.root, 'plugins', 'node_modules', name);
  marker = join(state.root, 'evaluated.txt');
  manifest = {
    command: 'probe',
    commandAliases: ['p'],
    entry: './entry.mjs',
    handlerKey: 'run',
    auth: 'optional',
  };
  mkdirSync(pkgDir, { recursive: true });
  writePackage();
  writeFileSync(
    join(state.root, 'plugins.json'),
    JSON.stringify({ plugins: [{ name, version: '1.0.0', source: 'local', enabled: true }] }),
  );
  writeEntry();
  originalExitCode = process.exitCode;
  process.exitCode = 0;
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
    process.exitCode = originalExitCode;
    rmSync(state.root, { recursive: true, force: true });
  }
});

function writePackage(version = '1.0.0'): void {
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, qianwen: manifest }));
}

function writeEntry(
  body = 'export const handlers = { run() { console.log("executed"); } };',
): void {
  writeFileSync(
    join(pkgDir, 'entry.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'evaluated');\n${body}`,
  );
}

function register(program: Command): void {
  loader.registerPluginCommands(program, [{ name, version: '1.0.0', pkgDir, manifest }]);
}

describe('plugin import state', () => {
  it('starts false for an unknown package', () => {
    expect(loader.hasLoadedPluginCode(name)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['probe', 'p'])('discovery and %s help do not import code', async (command) => {
    const discovered = loader.loadInstalledPlugins(
      join(state.root, 'plugins.json'),
      join(state.root, 'plugins'),
    );
    expect(discovered).toHaveLength(1);
    const result = await runCommand(
      (program) => loader.registerPluginCommands(program, discovered),
      [command, '--help'],
    );
    expect(result.exitCode).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(loader.hasLoadedPluginCode(name)).toBe(false);
  });

  it('static validation of registered code does not count as an import', async () => {
    const result = await runCommand(
      (program) => {
        registerPluginManagementCommands(program);
        register(program);
      },
      ['plugin', 'validate', pkgDir, '--format', 'json'],
    );
    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout).summary.errors).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(loader.hasLoadedPluginCode(name)).toBe(false);
  });

  it.each(['probe', 'p'])(
    'executing %s records the package rather than its command name',
    async (command) => {
      const result = await runCommand(register, [command, '--format', 'json']);
      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toBe('executed');
      expect(readFileSync(marker, 'utf8')).toBe('evaluated');
      expect(loader.hasLoadedPluginCode(name)).toBe(true);
      expect(loader.hasLoadedPluginCode('probe')).toBe(false);
      expect(loader.hasLoadedPluginCode('p')).toBe(false);
      expect(loader.hasLoadedPluginCode(`${name}-other`)).toBe(false);
    },
  );

  it('records a package when a nested leaf is invoked through aliases', async () => {
    manifest = {
      command: 'probe',
      commandAliases: ['p'],
      entry: './entry.mjs',
      auth: 'optional',
      subcommands: [{ command: 'run', commandAliases: ['r'], handlerKey: 'run' }],
    };
    const result = await runCommand(register, ['p', 'r', '--format', 'json']);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toBe('executed');
    expect(loader.hasLoadedPluginCode(name)).toBe(true);
  });

  it.each(['AUTH_REQUIRED', 'TOKEN_EXPIRED'])(
    'a %s rejection before import leaves state clear',
    async (code) => {
      state.authCode = code;
      manifest.auth = 'required';
      const result = await runCommand(register, ['probe', '--format', 'json']);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr).error.code).toBe(code);
      expect(result.stdout).toBe('');
      expect(existsSync(marker)).toBe(false);
      expect(loader.hasLoadedPluginCode(name)).toBe(false);
    },
  );

  it.each(['traversal', 'symlink'])(
    'a %s entry rejected by containment leaves state clear',
    async (kind) => {
      const outside = join(state.root, 'outside.mjs');
      writeFileSync(
        outside,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'escaped'); export const handlers = {};`,
      );
      if (kind === 'traversal') manifest.entry = '../../../../outside.mjs';
      else {
        manifest.entry = './linked.mjs';
        symlinkSync(outside, join(pkgDir, 'linked.mjs'));
      }
      const result = await runCommand(register, ['probe', '--format', 'json']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('escapes the package directory');
      expect(existsSync(marker)).toBe(false);
      expect(loader.hasLoadedPluginCode(name)).toBe(false);
    },
  );

  it('retains an import attempt when module evaluation fails after evaluating a dependency', async () => {
    writeFileSync(
      join(pkgDir, 'dependency.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'dependency evaluated');`,
    );
    writeFileSync(
      join(pkgDir, 'entry.mjs'),
      'import "./dependency.mjs"; throw new Error("fixture evaluation failed");',
    );
    const result = await runCommand(register, ['probe', '--format', 'json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('fixture evaluation failed');
    expect(readFileSync(marker, 'utf8')).toBe('dependency evaluated');
    expect(loader.hasLoadedPluginCode(name)).toBe(true);
  });

  it('records the import before the entry begins evaluating', async () => {
    let stateDuringEvaluation: boolean | undefined;
    vi.stubGlobal('qianwenImportStateProbe', () => {
      stateDuringEvaluation = loader.hasLoadedPluginCode(name);
    });
    writeEntry('globalThis.qianwenImportStateProbe(); export const handlers = { run() {} };');
    const result = await runCommand(register, ['probe', '--format', 'json']);
    expect(result.exitCode).toBeUndefined();
    expect(readFileSync(marker, 'utf8')).toBe('evaluated');
    expect(stateDuringEvaluation).toBe(true);
    expect(loader.hasLoadedPluginCode(name)).toBe(true);
  });

  it('retains an evaluated module even when its requested handler is absent', async () => {
    writeEntry('export const handlers = {};');
    const result = await runCommand(register, ['probe', '--format', 'json']);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(marker, 'utf8')).toBe('evaluated');
    expect(loader.hasLoadedPluginCode(name)).toBe(true);
  });

  it('keeps state through empty and rebuilt command trees and a different package version', async () => {
    const executed = await runCommand(register, ['probe', '--format', 'json']);
    expect(executed.stdout).toBe('executed');
    loader.registerPluginCommands(new Command(), []);
    writePackage('2.0.0');
    loader.registerPluginCommands(new Command(), [{ name, version: '2.0.0', pkgDir, manifest }]);
    expect(loader.hasLoadedPluginCode(name)).toBe(true);
  });

  it('starts clean in a fresh process after this process has imported the package', async () => {
    const executed = await runCommand(register, ['probe', '--format', 'json']);
    expect(executed.stdout).toBe('executed');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { hasLoadedPluginCode } from './src/plugins/loader.ts'; console.log(hasLoadedPluginCode(${JSON.stringify(name)}));`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          QIANWEN_CONFIG_DIR: state.root,
          TMPDIR: state.root,
          TSX_DISABLE_CACHE: '1',
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('false\n');
    expect(child.stderr).toBe('');
    expect(loader.hasLoadedPluginCode(name)).toBe(true);
  });
});
