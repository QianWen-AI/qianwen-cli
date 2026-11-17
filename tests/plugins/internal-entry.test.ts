import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Command } from 'commander';

const state = vi.hoisted(() => ({
  createProgram: vi.fn<(options: { loadPlugins: boolean }) => Command>(),
  initialize: vi.fn<(program: Command) => Promise<void>>(),
  startRepl: vi.fn<() => Promise<void>>(),
  flushDebugReport: vi.fn(),
}));

vi.mock('../../src/cli.js', () => ({ createProgram: state.createProgram }));
vi.mock('../../src/plugins/initialize.js', () => ({
  initializeDefaultPlugins: state.initialize,
}));
vi.mock('../../src/repl.js', () => ({ startRepl: state.startRepl }));
vi.mock('../../src/utils/cache.js', () => ({ resetGlobalCache: vi.fn() }));
vi.mock('../../src/api/debug-buffer.js', () => ({
  flushDebugReport: state.flushDebugReport,
}));
vi.mock('../../src/api/request-adapter.js', () => ({
  isNonProdEndpoint: () => false,
  activeApiEndpoint: 'https://cli.test.qianwenai.com',
}));
vi.mock('../../src/utils/api-errors.js', () => ({
  classifyHttpError: vi.fn(() => ({ code: 'UNKNOWN_ERROR', exitCode: 1 })),
}));
vi.mock('../../src/utils/errors.js', () => ({
  HandledError: class extends Error {
    constructor(public exitCode: number) {
      super('Handled initialization failure');
    }
  },
  CliError: class extends Error {},
}));

const internalFlag = '--internal-prepare-default-plugins';
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let program: Command;
let parseAsync: MockInstance<Command['parseAsync']>;

beforeEach(() => {
  vi.resetModules();
  program = new Command('qianwen');
  parseAsync = vi.spyOn(program, 'parseAsync').mockResolvedValue(program);
  state.createProgram.mockReset().mockReturnValue(program);
  state.initialize.mockReset().mockResolvedValue(undefined);
  state.startRepl.mockReset().mockResolvedValue(undefined);
  state.flushDebugReport.mockReset();
  process.exitCode = undefined;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.restoreAllMocks();
});

async function runEntry(args: string[]): Promise<void> {
  process.argv = ['node', 'qianwen', ...args];
  await import('../../bin/qianwen.js');
  await vi.waitFor(() => expect(state.flushDebugReport).toHaveBeenCalledOnce());
}

describe('internal default plugin initialization entry', () => {
  it('initializes only through the sole internal argument without parsing or starting REPL', async () => {
    await runEntry([internalFlag]);

    expect(state.createProgram).toHaveBeenCalledExactlyOnceWith({ loadPlugins: false });
    expect(state.initialize).toHaveBeenCalledExactlyOnceWith(program);
    expect(parseAsync).not.toHaveBeenCalled();
    expect(state.startRepl).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([
    [internalFlag, '--help'],
    ['--help', internalFlag],
    ['plugin', internalFlag],
    ['--', internalFlag],
    [`${internalFlag}=true`],
    ['--internal-prepare-default-plugin'],
    ['plugin', 'prepare'],
    ['plugin', 'list'],
  ])('keeps ordinary parsing and never initializes for %j', async (...args) => {
    await runEntry(args);

    expect(state.createProgram).toHaveBeenCalledExactlyOnceWith({ loadPlugins: true });
    expect(parseAsync).toHaveBeenCalledExactlyOnceWith(process.argv);
    expect(state.initialize).not.toHaveBeenCalled();
    expect(state.startRepl).not.toHaveBeenCalled();
  });

  it.each([4, 130])('preserves initialization failure exit code %i', async (exitCode) => {
    const { HandledError } = await import('../../src/utils/errors.js');
    state.initialize.mockRejectedValue(new HandledError(exitCode));

    await runEntry([internalFlag]);

    expect(state.initialize).toHaveBeenCalledExactlyOnceWith(program);
    expect(process.exitCode).toBe(exitCode);
    expect(parseAsync).not.toHaveBeenCalled();
    expect(state.startRepl).not.toHaveBeenCalled();
  });
});
