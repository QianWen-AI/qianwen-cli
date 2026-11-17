import {
  installed,
  pendingInstallation,
  signalResources,
} from '../fixtures/plugin-cancellation.js';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import { initializeDefaultPlugins } from '../../src/plugins/initialize.js';
import { CliError } from '../../src/utils/errors.js';

const state = vi.hoisted(() => ({
  defaults: [] as DefaultPlugin[],
  ensure: vi.fn(),
}));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => state.defaults,
  getDefaultPlugin: (name: string) => state.defaults.find((plugin) => plugin.name === name),
}));
vi.mock('../../src/plugins/default-install.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/default-install.js')>()),
  ensureDefaultPlugin: state.ensure,
  recoverManagedPluginInstalls: vi.fn(async () => {}),
}));
vi.mock('../../src/plugins/manifest.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/manifest.js')>()),
  readInstalledManifest: () => ({ plugins: [], disabledDefaults: [] }),
}));
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({ 'output.format': 'json' }),
}));

let resources: ReturnType<typeof signalResources>;

function execute() {
  return initializeDefaultPlugins(new Command('qianwen')).then(
    () => ({ succeeded: true as const }),
    (error: unknown) => ({ succeeded: false as const, error }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', '');
  vi.stubEnv('QIANWEN_PLUGIN_PREPARE_REPORT', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  state.defaults = ['first', 'second', 'third'].map((name) => ({
    name: `@qianwenai/prepare-${name}`,
    version: '1.0.0',
    command: `prepare${name}`,
    source: { type: 'npm' },
  }));
  state.ensure.mockReset().mockImplementation(async (plugin: DefaultPlugin) => installed(plugin));
  resources = signalResources();
});

afterEach(() => {
  resources.cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('default preparation always has a shared time budget', () => {
  it.each(['', 'invalid', '0'])(
    'falls back to 45 seconds for an absent or invalid inherited deadline %j',
    async (deadline) => {
      vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', deadline);
      const pending = pendingInstallation(state.ensure);
      let settled = false;
      const execution = execute().then((result) => {
        settled = true;
        return result;
      });

      try {
        await vi.advanceTimersByTimeAsync(44_999);
        expect(pending.signal).toBeInstanceOf(AbortSignal);
        expect(pending.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(pending.signal?.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(state.ensure).toHaveBeenCalledTimes(1);
      } finally {
        pending.release();
      }

      expect((await execution).succeeded).toBe(false);
      expect(state.ensure).toHaveBeenCalledTimes(1);
      resources.expectReleased();
    },
  );

  it('shares the implicit 45-second budget across the full plugin list', async () => {
    state.ensure.mockImplementationOnce(
      (plugin: DefaultPlugin) =>
        new Promise((resolve) => setTimeout(() => resolve(installed(plugin)), 30_000)),
    );
    const pending = pendingInstallation(state.ensure);
    const execution = execute();

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.ensure).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(pending.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending.signal?.aborted).toBe(true);
    } finally {
      pending.release();
    }

    expect((await execution).succeeded).toBe(false);
    expect(state.ensure).toHaveBeenCalledTimes(2);
    resources.expectReleased();
  });

  it('honors a shorter explicit absolute deadline', async () => {
    vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', String(Date.now() + 1_200));
    const pending = pendingInstallation(state.ensure);
    const execution = execute();

    try {
      await vi.advanceTimersByTimeAsync(1_199);
      expect(pending.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending.signal?.aborted).toBe(true);
    } finally {
      pending.release();
    }

    expect((await execution).succeeded).toBe(false);
    resources.expectReleased();
  });
});

describe('default preparation reports structured failure categories', () => {
  it('retains the incompatible classification and both CLI versions beside transient failures', async () => {
    const incompatible = Object.assign(
      new CliError({
        code: 'PLUGIN_CLI_INCOMPATIBLE',
        message: 'The plugin requires a newer CLI',
        exitCode: 4,
      }),
      {
        minCliVersion: '99.0.0',
        currentCliVersion: '1.10.0',
      },
    );
    state.ensure.mockRejectedValueOnce(incompatible);
    state.ensure.mockRejectedValueOnce(new Error('Fixture registry temporarily unavailable'));

    const result = await execute();
    const output = vi
      .mocked(console.log)
      .mock.calls.map(([value]) => String(value))
      .join('');
    const payload = JSON.parse(output) as { plugins: unknown[] };

    expect(result.succeeded).toBe(false);
    if (!result.succeeded) expect(result.error).toMatchObject({ exitCode: 4 });
    expect(payload.plugins).toEqual([
      expect.objectContaining({
        name: state.defaults[0].name,
        status: 'failed',
        code: 'PLUGIN_CLI_INCOMPATIBLE',
        minCliVersion: '99.0.0',
        currentCliVersion: '1.10.0',
      }),
      expect.objectContaining({
        name: state.defaults[1].name,
        status: 'failed',
        code: 'PLUGIN_PREPARE_FAILED',
      }),
      expect.objectContaining({ name: state.defaults[2].name, status: 'installed' }),
    ]);
    resources.expectReleased();
  });
});
