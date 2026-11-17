import {
  installed,
  pendingInstallation,
  signalResources,
} from '../fixtures/plugin-cancellation.js';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import { initializeDefaultPlugins } from '../../src/plugins/initialize.js';
import { interruptActiveCommand } from '../../src/utils/command-interrupt.js';

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

function execute() {
  const command = new Command('qianwen');
  return initializeDefaultPlugins(command).then(
    () => ({ succeeded: true as const }),
    (error: unknown) => ({ succeeded: false as const, error }),
  );
}

let resources: ReturnType<typeof signalResources>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  state.defaults.splice(
    0,
    state.defaults.length,
    ...['catalog', 'lookup', 'search'].map((command) => ({
      name: `@qianwenai/${command}-cancellation`,
      version: '1.2.3',
      command,
      source: { type: 'npm' as const },
    })),
  );
  state.ensure.mockReset().mockImplementation(async (plugin: DefaultPlugin) => installed(plugin));
  resources = signalResources();
});

afterEach(() => {
  resources.cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('internal plugin initialization cooperative cancellation', () => {
  it('aborts at the shared deadline and waits for rollback before settling', async () => {
    vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', String(Date.now() + 45_000));
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
      await vi.advanceTimersByTimeAsync(250);
      expect(settled).toBe(false);
    } finally {
      pending.release();
    }

    expect((await execution).succeeded).toBe(false);
    expect(state.ensure).toHaveBeenCalledTimes(1);
    resources.expectReleased();
  });

  it('shares one absolute deadline across plugins instead of renewing the budget', async () => {
    vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', String(Date.now() + 45_000));
    state.ensure.mockImplementationOnce(
      (plugin: DefaultPlugin) =>
        new Promise((resolve) => setTimeout(() => resolve(installed(plugin)), 30_000)),
    );
    const pending = pendingInstallation(state.ensure);
    const execution = execute();

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.ensure).toHaveBeenCalledTimes(2);
      expect(pending.signal?.aborted).toBe(false);
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

  it('does not begin an installation when the inherited deadline has already expired', async () => {
    vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', String(Date.now() - 1));

    const result = await execute();

    expect(result.succeeded).toBe(false);
    expect(state.ensure).not.toHaveBeenCalled();
    resources.expectReleased();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'handles %s, awaits rollback, and does not start the remaining plugins',
    async (signal) => {
      const pending = pendingInstallation(state.ensure);
      let settled = false;
      const execution = execute().then((result) => {
        settled = true;
        return result;
      });

      try {
        await vi.advanceTimersByTimeAsync(0);
        const original = resources.original.get(signal) ?? [];
        const ownListeners = process
          .listeners(signal)
          .filter((listener) => !original.includes(listener));
        expect(ownListeners.length).toBeGreaterThan(0);
        for (const listener of ownListeners) Reflect.apply(listener, process, [signal]);
        await vi.advanceTimersByTimeAsync(0);
        expect(pending.signal?.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(state.ensure).toHaveBeenCalledTimes(1);
      } finally {
        pending.release();
      }

      const result = await execution;
      expect(result.succeeded).toBe(false);
      if (signal === 'SIGINT' && !result.succeeded)
        expect(result.error).toMatchObject({ exitCode: 130 });
      expect(state.ensure).toHaveBeenCalledTimes(1);
      resources.expectReleased();
    },
  );

  it('also bounds internal standalone preparation when no deadline was supplied', async () => {
    const pending = pendingInstallation(state.ensure);
    const execution = execute();

    try {
      await vi.advanceTimersByTimeAsync(45_001);
      expect(pending.signal).toBeInstanceOf(AbortSignal);
      expect(pending.signal?.aborted).toBe(true);
    } finally {
      pending.release();
    }

    expect((await execution).succeeded).toBe(false);
    expect(state.ensure).toHaveBeenCalledTimes(1);
    resources.expectReleased();
  });

  it('handles the REPL interrupt, awaits rollback, and releases its command handler', async () => {
    const pending = pendingInstallation(state.ensure);
    let settled = false;
    const execution = execute().then((result) => {
      settled = true;
      return result;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(interruptActiveCommand()).toBe(true);
      expect(pending.signal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(state.ensure).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(settled).toBe(false);
    } finally {
      pending.release();
    }

    const result = await execution;
    expect(result.succeeded).toBe(false);
    if (!result.succeeded) expect(result.error).toMatchObject({ exitCode: 130 });
    expect(state.ensure).toHaveBeenCalledTimes(1);
    expect(interruptActiveCommand()).toBe(false);
    resources.expectReleased();
  });

  it.each([false, true])(
    'releases signal listeners and deadline timer on ordinary failure=%s',
    async (failure) => {
      vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', String(Date.now() + 45_000));
      if (failure) state.ensure.mockRejectedValueOnce(new Error('Fixture download failed'));

      const result = await execute();

      expect(result.succeeded).toBe(!failure);
      expect(state.ensure).toHaveBeenCalledTimes(3);
      resources.expectReleased();
    },
  );
});
