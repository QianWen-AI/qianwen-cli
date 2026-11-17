import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginContext } from '../../src/plugins/loader.js';
import type { PluginDescriptor } from '../../src/plugins/descriptor.js';
import { registerPluginCommands } from '../../src/plugins/loader.js';
import { getCommandExamples, getLongDescription } from '../../src/utils/commander-helpers.js';
import { CliError, HandledError } from '../../src/utils/errors.js';

const registry = vi.hoisted(() => ({ plugins: [] as PluginDescriptor[] }));
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({ 'output.format': 'json' }),
}));
vi.mock('../../src/api/api-client.js', () => ({
  createApiClient: () => ({ callFlatApi: vi.fn() }),
}));

function descriptor(loadHandlers: PluginDescriptor['loadHandlers']): PluginDescriptor {
  return {
    name: '@qianwenai/default-test',
    version: '1.0.0',
    manifest: {
      command: 'catalog',
      entry: './dist/index.js',
      longDescription: 'Detailed catalog help.',
      examples: ['catalog search pdf'],
      helpOrder: 130,
      subcommands: [{ command: 'search [query]', handlerKey: 'search' }],
    },
    loadHandlers,
  };
}

beforeEach(() => registry.plugins.splice(0));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('default plugin runtime', () => {
  it.each(['manifest', 'version', 'minimum-version', 'incompatible-version'])(
    'fails registration instead of silently dropping a required plugin with invalid %s',
    (kind) => {
      const plugin = descriptor(async () => ({ handlers: {} }));
      if (kind === 'manifest') plugin.manifest.command = '';
      if (kind === 'version') plugin.version = 'latest';
      if (kind === 'minimum-version') plugin.manifest.minCliVersion = 'latest';
      if (kind === 'incompatible-version') plugin.manifest.minCliVersion = '999.0.0';
      registry.plugins.push(plugin);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(() =>
        registerPluginCommands(new Command(), registry.plugins, { trustedDefault: true }),
      ).toThrow(expect.objectContaining({ exitCode: 4 }));
      expect(stderr).not.toHaveBeenCalled();
    },
  );

  it.each(['built-in', 'default'])(
    'fails on a required plugin collision with a %s command',
    (kind) => {
      registry.plugins.push(descriptor(async () => ({ handlers: {} })));
      const program = new Command();
      if (kind === 'built-in') program.command(registry.plugins[0].manifest.command);
      else registry.plugins.push({ ...registry.plugins[0], name: '@example/second-default' });
      expect(() =>
        registerPluginCommands(program, registry.plugins, { trustedDefault: true }),
      ).toThrow(expect.objectContaining({ exitCode: 4 }));
    },
  );

  it('loads a default module through the same ABI and preserves command help', async () => {
    const handler = vi.fn();
    registry.plugins.push(descriptor(async () => ({ handlers: { search: handler } })));
    const program = new Command().option('--format <format>');
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    const catalog = program.commands[0];
    expect(getLongDescription(catalog)).toBe('Detailed catalog help.');
    expect(getCommandExamples(catalog)[0]).toContain('catalog search pdf');
    await program.parseAsync(['--format', 'text', 'catalog', 'search', 'pdf'], { from: 'user' });
    const [context, options, positional] = handler.mock.calls[0];
    expect(context).toMatchObject({ format: 'text', runtime: { isRepl: false } });
    expect(context.runtime.cliVersion).toEqual(expect.any(String));
    expect(context.runtime.language).toEqual(expect.any(String));
    expect(context.errors.create({ code: 'TEST', message: 'bad', exitCode: 4 })).toBeInstanceOf(
      CliError,
    );
    expect(options).toMatchObject({ format: 'text' });
    expect(positional).toEqual(['pdf']);
  });

  it('does not allow a disk plugin to replace the default command', () => {
    registry.plugins.push(descriptor(async () => ({ handlers: {} })));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command();
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    registerPluginCommands(program, [
      { name: 'replacement', pkgDir: '/not-used', manifest: registry.plugins[0].manifest },
    ]);
    expect(program.commands.filter((command) => command.name() === 'catalog')).toHaveLength(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('collides with a built-in'));
  });

  it('includes a stalled module import in the execution deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    registry.plugins.push(descriptor(() => new Promise(() => {})));
    const program = new Command();
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    const execution = program.parseAsync(['catalog', 'search'], { from: 'user' });
    const rejected = expect(execution).rejects.toBeInstanceOf(HandledError);
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
  });

  it('never invokes a handler when an import resolves after its deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handler = vi.fn();
    let resolveImport!: (module: { handlers: { search: typeof handler } }) => void;
    registry.plugins.push(
      descriptor(
        () =>
          new Promise((resolve) => {
            resolveImport = resolve;
          }),
      ),
    );
    const program = new Command();
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    const rejected = expect(
      program.parseAsync(['catalog', 'search'], { from: 'user' }),
    ).rejects.toBeInstanceOf(HandledError);
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
    resolveImport({ handlers: { search: handler } });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it('excludes terminal input waits from the deadline and restores it afterwards', async () => {
    vi.useFakeTimers();
    let finishInput!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finishInput = resolve;
    });
    const handler = vi.fn(async (context: PluginContext) => {
      await context.terminal.withInput(() => waiting);
      expect(context.abort.aborted).toBe(false);
    });
    registry.plugins.push(descriptor(async () => ({ handlers: { search: handler } })));
    const program = new Command();
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    const execution = program.parseAsync(['catalog', 'search'], { from: 'user' });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(handler).toHaveBeenCalledOnce();
    finishInput();
    await execution;
  });

  it('waits for cooperative default-handler cleanup after cancellation', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let cleaned = false;
    const plugin = descriptor(async () => ({
      handlers: {
        search: async (context: PluginContext) => {
          await new Promise<void>((resolve) => {
            context.abort.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  cleaned = true;
                  resolve();
                }, 50);
              },
              { once: true },
            );
          });
        },
      },
    }));
    plugin.manifest.timeoutMs = 10;
    registry.plugins.push(plugin);
    const program = new Command();
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    const execution = program
      .parseAsync(['catalog', 'search'], { from: 'user' })
      .catch((error: unknown) => {
        expect(cleaned).toBe(true);
        throw error;
      });
    const rejected = expect(execution).rejects.toBeInstanceOf(HandledError);
    await vi.advanceTimersByTimeAsync(60);
    await rejected;
  });

  it('finishes real temporary-download cleanup before returning a cancelled default command', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const temporaryRoot = join(__dirname, '../../.local-test-tmp');
    await mkdir(temporaryRoot, { recursive: true });
    const directory = await mkdtemp(join(temporaryRoot, 'qianwen-plugin-cancel-'));
    const staged = join(directory, 'pending-download');
    const plugin = descriptor(async () => ({
      handlers: {
        search: async (context: PluginContext) => {
          try {
            await writeFile(staged, 'partial download');
            await new Promise<void>((_, reject) => {
              const cancel = () =>
                reject(
                  context.errors.create({ code: 'CANCELLED', message: 'cancelled', exitCode: 130 }),
                );
              if (context.abort.aborted) cancel();
              else context.abort.addEventListener('abort', cancel, { once: true });
            });
          } finally {
            await rm(staged, { force: true });
          }
        },
      },
    }));
    plugin.manifest.timeoutMs = 20;
    registry.plugins.push(plugin);
    const program = new Command();
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    try {
      await expect(
        program.parseAsync(['catalog', 'search'], { from: 'user' }),
      ).rejects.toBeInstanceOf(HandledError);
      await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves a structurally compatible error from another package', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    registry.plugins.push(
      descriptor(async () => ({
        handlers: {
          search: () => {
            throw Object.assign(new Error('Skill missing'), {
              code: 'SKILL_NOT_FOUND',
              exitCode: 7,
              hint: 'Search again',
              detail: 'slug',
            });
          },
        },
      })),
    );
    const program = new Command();
    registerPluginCommands(program, registry.plugins, { trustedDefault: true });
    await expect(program.parseAsync(['catalog', 'search'], { from: 'user' })).rejects.toMatchObject(
      {
        exitCode: 7,
      },
    );
    expect(stderr.mock.calls.map(([text]) => text).join('')).toContain('SKILL_NOT_FOUND');
  });
});
