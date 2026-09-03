import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { site } from '../../src/site.js';

type ReplEventHandler = (...args: unknown[]) => unknown;

interface FakeReadline {
  handlers: Map<string, ReplEventHandler>;
  on: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  setPrompt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

const {
  clearActivePromptInterfaceSpy,
  clearDebugBufferSpy,
  createInterfaceSpy,
  createProgramSpy,
  flushDebugReportSpy,
  interruptActiveCommandSpy,
  parseAsyncSpy,
  resolveCredentialsSpy,
  setActivePromptInterfaceSpy,
  setReplModeSpy,
} = vi.hoisted(() => ({
  clearActivePromptInterfaceSpy: vi.fn(),
  clearDebugBufferSpy: vi.fn(),
  createInterfaceSpy: vi.fn(),
  createProgramSpy: vi.fn(),
  flushDebugReportSpy: vi.fn(),
  interruptActiveCommandSpy: vi.fn<() => boolean>(() => false),
  parseAsyncSpy: vi.fn<(argv: string[]) => Promise<void>>(),
  resolveCredentialsSpy: vi.fn(() => null),
  setActivePromptInterfaceSpy: vi.fn(),
  setReplModeSpy: vi.fn(),
}));

vi.mock('readline', () => ({
  createInterface: createInterfaceSpy,
  emitKeypressEvents: vi.fn(),
}));
vi.mock('../../src/cli.js', () => ({
  createProgram: createProgramSpy,
}));
vi.mock('../../src/auth/credentials.js', () => ({
  resolveCredentials: resolveCredentialsSpy,
}));
vi.mock('../../src/api/debug-buffer.js', () => ({
  flushDebugReport: flushDebugReportSpy,
  clearDebugBuffer: clearDebugBufferSpy,
}));
vi.mock('../../src/utils/runtime-mode.js', () => ({
  setReplMode: setReplModeSpy,
}));
vi.mock('../../src/utils/confirm.js', () => ({
  setActivePromptInterface: setActivePromptInterfaceSpy,
  clearActivePromptInterface: clearActivePromptInterfaceSpy,
}));
vi.mock('../../src/utils/command-interrupt.js', () => ({
  interruptActiveCommand: interruptActiveCommandSpy,
}));

const { startRepl } = await import('../../src/repl.js');

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const processExitDescriptor = Object.getOwnPropertyDescriptor(process, 'exit');
let fakeReadline: FakeReadline;

function createFakeReadline(): FakeReadline {
  const handlers = new Map<string, ReplEventHandler>();
  const instance: FakeReadline = {
    handlers,
    on: vi.fn((event: string, handler: ReplEventHandler) => {
      handlers.set(event, handler);
      return instance;
    }),
    prompt: vi.fn(),
    setPrompt: vi.fn(),
    close: vi.fn(),
    write: vi.fn(),
  };
  return instance;
}

function getHandler(event: string): ReplEventHandler {
  const handler = fakeReadline.handlers.get(event);
  expect(handler, `${event} handler should be registered`).toBeDefined();
  return handler as ReplEventHandler;
}

beforeEach(() => {
  fakeReadline = createFakeReadline();
  createInterfaceSpy.mockReset();
  createInterfaceSpy.mockReturnValue(fakeReadline);
  parseAsyncSpy.mockReset();
  parseAsyncSpy.mockResolvedValue(undefined);
  createProgramSpy.mockReset();
  createProgramSpy.mockReturnValue({
    exitOverride: vi.fn(),
    configureOutput: vi.fn(),
    parseAsync: parseAsyncSpy,
  });
  interruptActiveCommandSpy.mockReset();
  interruptActiveCommandSpy.mockReturnValue(false);
  resolveCredentialsSpy.mockClear();
  flushDebugReportSpy.mockClear();
  clearDebugBufferSpy.mockClear();
  setActivePromptInterfaceSpy.mockClear();
  clearActivePromptInterfaceSpy.mockClear();
  setReplModeSpy.mockClear();
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
  if (processExitDescriptor) Object.defineProperty(process, 'exit', processExitDescriptor);
  vi.restoreAllMocks();
});

describe('startRepl command wiring', () => {
  it('removes one CLI prefix from a pasted qianwen command before passing it to Commander', async () => {
    await startRepl();

    await getHandler('line')(`${site.cliName} billing balance`);

    expect(parseAsyncSpy).toHaveBeenCalledWith(['node', site.cliName, 'billing', 'balance']);
    expect(flushDebugReportSpy).toHaveBeenCalledOnce();
    expect(clearDebugBufferSpy).toHaveBeenCalledOnce();
  });

  it('forwards SIGINT to the active command while a command is running', async () => {
    let resolveCommand: () => void = () => {};
    parseAsyncSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    interruptActiveCommandSpy.mockReturnValue(true);
    await startRepl();

    const linePromise = getHandler('line')('billing balance');
    await vi.waitFor(() => expect(parseAsyncSpy).toHaveBeenCalledOnce());
    getHandler('SIGINT')();

    expect(interruptActiveCommandSpy).toHaveBeenCalledOnce();
    resolveCommand();
    await linePromise;
  });
});
