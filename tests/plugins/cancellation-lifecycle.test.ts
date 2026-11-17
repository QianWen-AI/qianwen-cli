import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { createPluginExecution } from '../../src/plugins/runtime.js';
import { registerPluginCommands } from '../../src/plugins/loader.js';
import { interruptActiveCommand } from '../../src/utils/command-interrupt.js';

vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('plugin cancellation lifecycle', () => {
  it.each(['registry', 'signal'])(
    'aborts through %s and cleans runtime resources',
    async (kind) => {
      vi.useFakeTimers();
      const listeners = process.listenerCount('SIGINT');
      const execution = createPluginExecution(60_000);
      const rejected = execution.aborted.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        expect(execution.signal.aborted).toBe(false);
        expect(process.listenerCount('SIGINT')).toBe(listeners + 1);
        if (kind === 'registry') expect(interruptActiveCommand()).toBe(true);
        else process.emit('SIGINT');
        expect(execution.signal.aborted).toBe(true);
        expect(await rejected).toMatchObject({ exitCode: 130 });
      } finally {
        execution.dispose();
      }
      expect(interruptActiveCommand()).toBe(false);
      expect(process.listenerCount('SIGINT')).toBe(listeners);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('waits for cooperative handler cleanup after a REPL interruption', async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.plugin-cancellation-'));
    const started = path.join(root, 'started');
    const cleaned = path.join(root, 'cleaned');
    const originalCode = process.exitCode;
    const listeners = process.listenerCount('SIGINT');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      fs.writeFileSync(
        path.join(root, 'entry.mjs'),
        'import fs from "node:fs"; export const handlers = { run: async (ctx) => {' +
          'fs.writeFileSync(' +
          JSON.stringify(started) +
          ', "ready");' +
          'await new Promise(resolve => ctx.abort.addEventListener("abort", resolve, { once: true }));' +
          'await new Promise(resolve => setTimeout(resolve, 20));' +
          'fs.writeFileSync(' +
          JSON.stringify(cleaned) +
          ', "done"); } };',
      );
      const program = new Command().exitOverride();
      registerPluginCommands(program, [
        {
          name: 'cancel-fixture',
          pkgDir: root,
          manifest: {
            command: 'cancel-fixture',
            entry: './entry.mjs',
            handlerKey: 'run',
            auth: 'optional',
          },
        },
      ]);
      const result = program.parseAsync(['cancel-fixture'], { from: 'user' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true));
      expect(interruptActiveCommand()).toBe(true);
      expect(await result).toMatchObject({ exitCode: 130 });
      expect(fs.readFileSync(cleaned, 'utf8')).toBe('done');
      expect(interruptActiveCommand()).toBe(false);
      expect(process.listenerCount('SIGINT')).toBe(listeners);
    } finally {
      process.exitCode = originalCode;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
