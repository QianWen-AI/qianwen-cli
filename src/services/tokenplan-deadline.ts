import { CliError } from '../utils/errors.js';

export async function withTokenPlanDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new CliError({
          code: 'TOKENPLAN_TIMEOUT',
          message: 'Token Plan request exceeded its deadline.',
          exitCode: 3,
        }),
      ),
    Math.max(0, timeoutMs),
  );
  let stop: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', stop);
    controller.abort();
  }
}

export function tokenPlanSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
}
