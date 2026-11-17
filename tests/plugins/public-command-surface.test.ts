import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createProgram } from '../../src/cli.js';

const state = vi.hoisted(() => ({
  root: `${process.cwd()}/.local-test-tmp/plugin-public-surface-uninitialized`,
  ensure: vi.fn(),
}));

vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getConfigDir: () => state.root,
  getGlobalConfigPath: () => path.join(state.root, 'config.json'),
  getLocalConfigPath: () => path.join(state.root, '.qianwen.json'),
  getMigrationStatePath: () => path.join(state.root, '.migrated-projects'),
  getPluginsDir: () => path.join(state.root, 'plugins'),
  getPluginsManifestPath: () => path.join(state.root, 'plugins.json'),
  getCredentialsPath: () => path.join(state.root, 'credentials.json'),
  getCacheDir: () => path.join(state.root, 'cache'),
  getCacheFilePath: (fileName: string) => path.join(state.root, 'cache', fileName),
  getDeviceFlowPendingPath: () => path.join(state.root, 'device-flow-pending.json'),
}));
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../src/plugins/defaults.js', async () => {
  const { defaultPlugin } = await import('../fixtures/default-plugin.js');
  return {
    getDefaultPlugins: () => [defaultPlugin],
    getDefaultPlugin: (name: string) => (name === defaultPlugin.name ? defaultPlugin : undefined),
  };
});
vi.mock('../../src/plugins/default-install.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/default-install.js')>()),
  ensureDefaultPlugin: state.ensure,
  readUsableDefaultPlugin: () => null,
}));

const publicCommands = ['init', 'install', 'list', 'uninstall', 'update', 'validate'];
const internalFlag = '--internal-prepare-default-plugins';
let output: string[];

beforeEach(() => {
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  state.root = mkdtempSync(path.join(temporaryRoot, 'plugin-public-surface-'));
  output = [];
  state.ensure.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Command discovery must remain offline');
    }),
  );
});

afterEach(() => {
  try {
    expect(state.ensure).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(state.root, { recursive: true, force: true });
  }
});

function program() {
  return createProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
}

describe('public plugin command surface', () => {
  it('registers exactly the six public management commands', () => {
    const plugin = program().commands.find((command) => command.name() === 'plugin');

    expect(plugin).toBeDefined();
    expect(plugin?.commands.map((command) => command.name()).sort()).toEqual(publicCommands);
  });

  it('rejects the removed plugin prepare command', async () => {
    await expect(
      program().parseAsync(['plugin', 'prepare'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it.each([['--help'], ['plugin', '--help'], ['catalog', '--help']])(
    'does not advertise prepare or the internal entry in help: %j',
    async (...args) => {
      await expect(program().parseAsync(args, { from: 'user' })).rejects.toMatchObject({
        exitCode: 0,
      });

      expect(output.join('')).not.toMatch(/\bprepare\b/);
      expect(output.join('')).not.toContain(internalFlag);
    },
  );

  it.each(['bash', 'zsh', 'fish'])(
    '%s completion does not expose prepare or the internal entry',
    async (shell) => {
      await program().parseAsync(['completion', 'generate', '--shell', shell], { from: 'user' });

      expect(output.join('')).not.toMatch(/\bprepare\b/);
      expect(output.join('')).not.toContain(internalFlag);
    },
  );
});
