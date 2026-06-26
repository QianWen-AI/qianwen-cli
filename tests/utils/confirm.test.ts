import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';

// The vi.mock factory is hoisted above the imports, so the spies it references
// must be created inside vi.hoisted to exist by the time the factory runs.
const { mockQuestion, mockClose, mockCreateInterface, rlHolder } = vi.hoisted(() => {
  const { EventEmitter: EE } = require('node:events') as typeof import('events');
  const rlHolder: { instance: EventEmitter } = { instance: new EE() };
  const mockQuestion = vi.fn();
  const mockClose = vi.fn();
  const mockCreateInterface = vi.fn(() => {
    const rl = new EE();
    (rl as Record<string, unknown>).close = mockClose;
    (rl as Record<string, unknown>).question = mockQuestion;
    rlHolder.instance = rl;
    return rl;
  });
  return { mockQuestion, mockClose, mockCreateInterface, rlHolder };
});

vi.mock('readline', () => ({
  createInterface: mockCreateInterface,
}));

import {
  confirmPrompt,
  setActivePromptInterface,
  clearActivePromptInterface,
} from '../../src/utils/confirm.js';

describe('confirmPrompt', () => {
  let originalIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let originalIsPaused: (() => boolean) | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    originalIsPaused = process.stdin.isPaused;
    vi.clearAllMocks();
    // Ensure no active REPL interface leaks into the standalone path tests.
    clearActivePromptInterface();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, writable: true });
    process.stdin.isPaused = originalIsPaused!;
    clearActivePromptInterface();
  });

  it('should return false in non-TTY stdin environment', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    const result = await confirmPrompt('Continue?');
    expect(result).toBe(false);
  });

  it('should return false in non-TTY stdout environment', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const result = await confirmPrompt('Continue?');
    expect(result).toBe(false);
  });

  it('should return true when user answers y', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('y');
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(true);
  });

  it('one-shot path refs stdin on entry and unrefs on finish (no unsettled await)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;
    const refSpy = vi.spyOn(process.stdin, 'ref').mockImplementation(() => process.stdin);
    const unrefSpy = vi.spyOn(process.stdin, 'unref').mockImplementation(() => process.stdin);

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('y');
    });

    const result = await confirmPrompt('Continue?');

    expect(result).toBe(true);
    // Entry ref keeps the event loop alive while awaiting the answer; finish
    // unref lets the process exit after this final interactive step.
    expect(refSpy).toHaveBeenCalled();
    expect(unrefSpy).toHaveBeenCalled();

    refSpy.mockRestore();
    unrefSpy.mockRestore();
  });

  it('REPL path (active interface) does not touch stdin ref/unref', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockImplementation(() => process.stdin);
    const unrefSpy = vi.spyOn(process.stdin, 'unref').mockImplementation(() => process.stdin);

    setActivePromptInterface({ question: (_q: string, cb: (a: string) => void) => cb('y') });
    const result = await confirmPrompt('Continue?');

    expect(result).toBe(true);
    expect(refSpy).not.toHaveBeenCalled();
    expect(unrefSpy).not.toHaveBeenCalled();

    clearActivePromptInterface();
    refSpy.mockRestore();
    unrefSpy.mockRestore();
  });

  it('should return true when user answers Y', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('Y');
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(true);
  });

  it('should return false when user answers n', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('n');
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(false);
  });

  it('should return false when user presses enter (empty input)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('');
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(false);
  });

  it('should return false when user enters arbitrary text', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('yes');
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(false);
  });

  it('should return false on SIGINT', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation(() => {
      // Simulate SIGINT after question is asked
      setTimeout(() => rlHolder.instance.emit('SIGINT'), 0);
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(false);
  });

  it('should return false on close event', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation(() => {
      // Simulate close (EOF) after question is asked
      setTimeout(() => rlHolder.instance.emit('close'), 0);
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(false);
  });

  it('should resume stdin if it is paused', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => true;
    const resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('y');
    });

    await confirmPrompt('Continue?');
    expect(resumeSpy).toHaveBeenCalled();
    resumeSpy.mockRestore();
  });

  it('should trim whitespace from user input', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    process.stdin.isPaused = () => false;

    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('  y  ');
    });

    const result = await confirmPrompt('Continue?');
    expect(result).toBe(true);
  });
});

describe('confirmPrompt — active interface reuse (REPL path)', () => {
  let originalIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  /** Build a fake readline that immediately answers via the question callback. */
  function fakeRl(answer: string): {
    question: ReturnType<typeof vi.fn>;
  } {
    return {
      question: vi.fn((_query: string, cb: (a: string) => void) => cb(answer)),
    };
  }

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    vi.clearAllMocks();
    clearActivePromptInterface();
    // Active-interface path must not depend on TTY: force a non-TTY environment
    // so a regression to the standalone path would short-circuit to false.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, writable: true });
    clearActivePromptInterface();
  });

  it('reuses the registered interface: calls its question once with the message', async () => {
    const rl = fakeRl('y');
    setActivePromptInterface(rl);

    const result = await confirmPrompt('Close ticket?');

    expect(result).toBe(true);
    expect(rl.question).toHaveBeenCalledTimes(1);
    const query = rl.question.mock.calls[0][0] as string;
    expect(query).toContain('Close ticket?');
  });

  it('does NOT create a new readline interface when an active one is registered', async () => {
    const rl = fakeRl('y');
    setActivePromptInterface(rl);

    await confirmPrompt('Close ticket?');

    expect(mockCreateInterface).not.toHaveBeenCalled();
  });

  it('resolves true for "Y" via the registered interface (case-insensitive)', async () => {
    const rl = fakeRl('Y');
    setActivePromptInterface(rl);

    const result = await confirmPrompt('Close ticket?');
    expect(result).toBe(true);
  });

  it('resolves true for "  y  " via the registered interface (trimmed)', async () => {
    const rl = fakeRl('  y  ');
    setActivePromptInterface(rl);

    const result = await confirmPrompt('Close ticket?');
    expect(result).toBe(true);
  });

  it('resolves false for "n" via the registered interface', async () => {
    const rl = fakeRl('n');
    setActivePromptInterface(rl);

    const result = await confirmPrompt('Close ticket?');
    expect(result).toBe(false);
  });

  it('resolves false for empty input via the registered interface', async () => {
    const rl = fakeRl('');
    setActivePromptInterface(rl);

    const result = await confirmPrompt('Close ticket?');
    expect(result).toBe(false);
  });

  it('resolves false for "yes" via the registered interface (only "y" means yes)', async () => {
    const rl = fakeRl('yes');
    setActivePromptInterface(rl);

    const result = await confirmPrompt('Close ticket?');
    expect(result).toBe(false);
  });

  it('falls back to the standalone non-TTY path after the interface is cleared', async () => {
    const rl = fakeRl('y');
    setActivePromptInterface(rl);
    clearActivePromptInterface();

    const result = await confirmPrompt('Close ticket?');

    // Standalone path in a non-TTY environment resolves false without reusing rl.
    expect(result).toBe(false);
    expect(rl.question).not.toHaveBeenCalled();
  });
});
