import { expect, vi, type Mock } from 'vitest';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';

export function installed(plugin: DefaultPlugin) {
  return { name: plugin.name, version: plugin.version, source: 'npm', enabled: true };
}

export function pendingInstallation(ensure: Mock) {
  let context: { signal?: AbortSignal } | undefined;
  let release: (() => void) | undefined;
  ensure.mockImplementationOnce((plugin: DefaultPlugin, options?: typeof context) => {
    context = options;
    return new Promise((resolve, reject) => {
      release = () => {
        if (options?.signal?.aborted) reject(new Error('Fixture rollback completed after abort'));
        else resolve(installed(plugin));
      };
    });
  });
  return {
    get signal() {
      return context?.signal;
    },
    release: () => release?.(),
  };
}

export function signalResources() {
  const original = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, process.listeners(signal)]),
  );
  return {
    original,
    expectReleased() {
      for (const [signal, previous] of original)
        expect(process.listeners(signal)).toEqual(previous);
      expect(vi.getTimerCount()).toBe(0);
    },
    cleanup() {
      for (const [signal, previous] of original) {
        for (const listener of process.listeners(signal)) {
          if (!previous.includes(listener)) process.removeListener(signal, listener);
        }
      }
    },
  };
}
