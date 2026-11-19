import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  interruptActiveCommand,
  registerCommandInterrupt,
} from '../../src/utils/command-interrupt.js';

let cleanups: Array<() => void> = [];

function register(handler: () => void): () => void {
  const cleanup = registerCommandInterrupt(handler);
  cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  cleanups = [];
  expect(interruptActiveCommand()).toBe(false);
});

afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  expect(interruptActiveCommand()).toBe(false);
});

describe('command interrupt registrations', () => {
  it('returns false without registrations', () => {
    expect(interruptActiveCommand()).toBe(false);
  });

  it('interrupts a single handler until its registration is cleaned up', () => {
    const handler = vi.fn();
    const cleanup = register(handler);

    expect(interruptActiveCommand()).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    cleanup();
    expect(interruptActiveCommand()).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('calls only the inner handler and restores the outer handler after cleanup', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    register(outer);
    const cleanupInner = register(inner);

    expect(interruptActiveCommand()).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();

    cleanupInner();
    expect(interruptActiveCommand()).toBe(true);
    expect(outer).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledOnce();
  });

  it('keeps the inner handler active and never restores a cleaned-up outer registration', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const cleanupOuter = register(outer);
    const cleanupInner = register(inner);

    cleanupOuter();
    expect(interruptActiveCommand()).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();

    cleanupInner();
    expect(interruptActiveCommand()).toBe(false);
    expect(outer).not.toHaveBeenCalled();
  });

  it('skips a cleaned-up middle registration when restoring the outer handler', () => {
    const outer = vi.fn();
    const middle = vi.fn();
    const inner = vi.fn();
    register(outer);
    const cleanupMiddle = register(middle);
    const cleanupInner = register(inner);

    cleanupMiddle();
    expect(interruptActiveCommand()).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(middle).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();

    cleanupInner();
    expect(interruptActiveCommand()).toBe(true);
    expect(outer).toHaveBeenCalledOnce();
    expect(middle).not.toHaveBeenCalled();
  });

  it('keeps restored and newer handlers active after repeated cleanup', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const newest = vi.fn();
    register(outer);
    const cleanupInner = register(inner);
    cleanupInner();
    cleanupInner();

    expect(interruptActiveCommand()).toBe(true);
    expect(outer).toHaveBeenCalledOnce();

    const cleanupNewest = register(newest);
    cleanupInner();
    expect(interruptActiveCommand()).toBe(true);
    expect(newest).toHaveBeenCalledOnce();
    expect(inner).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledOnce();

    cleanupNewest();
    expect(interruptActiveCommand()).toBe(true);
    expect(outer).toHaveBeenCalledTimes(2);
  });

  it.each(['outer', 'inner'])(
    'removes only the %s registration when the same callback is registered twice',
    (firstCleanup) => {
      const handler = vi.fn();
      const cleanupOuter = register(handler);
      const cleanupInner = register(handler);

      expect(interruptActiveCommand()).toBe(true);
      expect(handler).toHaveBeenCalledOnce();

      const first = firstCleanup === 'outer' ? cleanupOuter : cleanupInner;
      const last = firstCleanup === 'outer' ? cleanupInner : cleanupOuter;
      first();
      first();
      expect(interruptActiveCommand()).toBe(true);
      expect(handler).toHaveBeenCalledTimes(2);

      last();
      expect(interruptActiveCommand()).toBe(false);
      expect(handler).toHaveBeenCalledTimes(2);
    },
  );
});
