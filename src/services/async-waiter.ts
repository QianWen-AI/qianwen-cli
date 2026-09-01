/** Polls a status function until it reports a terminal state or the timeout elapses. */

export interface AsyncWaiterDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface WaitOptions {
  timeoutMs: number;
  pollIntervalMs: number;
}

export type PollStatus = 'pending' | 'terminal';

export interface PollResult<T> {
  status: PollStatus;
  value: T;
}

export interface WaitResult<T> {
  completed: boolean;
  value: T;
}

export class AsyncWaiter {
  constructor(private readonly deps: AsyncWaiterDeps) {}

  async wait<T>(poll: () => Promise<PollResult<T>>, options: WaitOptions): Promise<WaitResult<T>> {
    const deadline = this.deps.now() + options.timeoutMs;

    let latest = await poll();
    while (latest.status !== 'terminal') {
      if (this.deps.now() + options.pollIntervalMs > deadline) {
        return { completed: false, value: latest.value };
      }
      await this.deps.sleep(options.pollIntervalMs);
      latest = await poll();
    }

    return { completed: true, value: latest.value };
  }
}
