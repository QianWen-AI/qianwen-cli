/**
 * Unit tests for AsyncWaiter — polls a status function until it reports a
 * terminal state or the timeout elapses. Timeout is not a failure.
 *
 * A virtual clock is injected (sleep advances `now`), so the real logic runs
 * without wall-clock delays.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AsyncWaiter,
  type AsyncWaiterDeps,
  type PollResult,
} from '../../src/services/async-waiter.js';

function makeClock(): { deps: AsyncWaiterDeps; sleeps: number[]; nowValue: () => number } {
  let clock = 0;
  const sleeps: number[] = [];
  const deps: AsyncWaiterDeps = {
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    }),
  };
  return { deps, sleeps, nowValue: () => clock };
}

describe('AsyncWaiter.wait', () => {
  it('queries immediately and returns completed when the first poll is terminal', async () => {
    const { deps, sleeps } = makeClock();
    const poll = vi
      .fn<[], Promise<PollResult<string>>>()
      .mockResolvedValue({ status: 'terminal', value: 'done' });

    const result = await new AsyncWaiter(deps).wait(poll, {
      timeoutMs: 10_000,
      pollIntervalMs: 2000,
    });

    expect(result).toEqual({ completed: true, value: 'done' });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('does not sleep before the first query', async () => {
    const { deps, sleeps } = makeClock();
    const poll = vi
      .fn<[], Promise<PollResult<string>>>()
      .mockResolvedValue({ status: 'terminal', value: 'x' });

    await new AsyncWaiter(deps).wait(poll, { timeoutMs: 1000, pollIntervalMs: 500 });

    expect(sleeps).toEqual([]);
  });

  it('polls repeatedly with the interval until a terminal state', async () => {
    const { deps, sleeps } = makeClock();
    const poll = vi
      .fn<[], Promise<PollResult<string>>>()
      .mockResolvedValueOnce({ status: 'pending', value: 'p1' })
      .mockResolvedValueOnce({ status: 'pending', value: 'p2' })
      .mockResolvedValueOnce({ status: 'terminal', value: 'ok' });

    const result = await new AsyncWaiter(deps).wait(poll, {
      timeoutMs: 60_000,
      pollIntervalMs: 2000,
    });

    expect(result).toEqual({ completed: true, value: 'ok' });
    expect(poll).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('returns not-completed with the last value when the timeout elapses', async () => {
    const { deps } = makeClock();
    const poll = vi
      .fn<[], Promise<PollResult<string>>>()
      .mockResolvedValue({ status: 'pending', value: 'still-running' });

    const result = await new AsyncWaiter(deps).wait(poll, {
      timeoutMs: 5000,
      pollIntervalMs: 2000,
    });

    expect(result.completed).toBe(false);
    expect(result.value).toBe('still-running');
  });

  it('never throws on timeout', async () => {
    const { deps } = makeClock();
    const poll = vi
      .fn<[], Promise<PollResult<number>>>()
      .mockResolvedValue({ status: 'pending', value: 1 });

    await expect(
      new AsyncWaiter(deps).wait(poll, { timeoutMs: 3000, pollIntervalMs: 1000 }),
    ).resolves.toBeDefined();
  });

  it('does not sleep past the deadline', async () => {
    const { deps, sleeps } = makeClock();
    // deadline 5000, interval 2000: poll@0(pending), sleep2000, poll@2000(pending),
    // sleep2000, poll@4000(pending); next sleep to 6000 would cross deadline -> stop.
    const poll = vi
      .fn<[], Promise<PollResult<string>>>()
      .mockResolvedValue({ status: 'pending', value: 'p' });

    const result = await new AsyncWaiter(deps).wait(poll, {
      timeoutMs: 5000,
      pollIntervalMs: 2000,
    });

    expect(result.completed).toBe(false);
    // three queries at t=0,2000,4000; two sleeps of 2000 each; no third sleep.
    expect(poll).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('returns completed on a terminal state reached on the final allowed poll', async () => {
    const { deps } = makeClock();
    const poll = vi
      .fn<[], Promise<PollResult<string>>>()
      .mockResolvedValueOnce({ status: 'pending', value: 'p' })
      .mockResolvedValueOnce({ status: 'terminal', value: 'late' });

    const result = await new AsyncWaiter(deps).wait(poll, {
      timeoutMs: 5000,
      pollIntervalMs: 2000,
    });

    expect(result).toEqual({ completed: true, value: 'late' });
  });
});
