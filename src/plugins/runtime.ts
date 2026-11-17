import { registerCommandInterrupt } from '../utils/command-interrupt.js';
import { classifyHttpError } from '../utils/api-errors.js';
import { CliError, type CliErrorOptions } from '../utils/errors.js';
import { EXIT_CODES, type ExitCode } from '../utils/exit-codes.js';
import { captureStdinState } from '../utils/stdin-control.js';

const allowedExitCodes = new Set<number>(Object.values(EXIT_CODES));

/** Restore the host error identity when a plugin carries its own error class. */
export function normalizePluginError(error: unknown): unknown {
  if (error instanceof CliError || !error || typeof error !== 'object') return error;
  const value = error as Record<string, unknown>;
  if (
    typeof value.code !== 'string' ||
    typeof value.message !== 'string' ||
    typeof value.exitCode !== 'number' ||
    !allowedExitCodes.has(value.exitCode) ||
    value.exitCode === EXIT_CODES.SUCCESS
  )
    return error;
  return new CliError({
    code: value.code,
    message: value.message,
    exitCode: value.exitCode as ExitCode,
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.hint === 'string' ? { hint: value.hint } : {}),
  });
}

export type PluginErrorOptions = Omit<CliErrorOptions, 'exitCode'> & { exitCode: number };

export const pluginErrors = {
  create: (options: PluginErrorOptions): CliError =>
    new CliError({
      ...options,
      exitCode:
        allowedExitCodes.has(options.exitCode) && options.exitCode !== 0
          ? (options.exitCode as ExitCode)
          : EXIT_CODES.GENERAL_ERROR,
    }),
  normalize: (error: unknown): CliError => classifyHttpError(normalizePluginError(error)),
};

/** An in-process async deadline. It cannot interrupt synchronous CPU work. */
export function createPluginExecution(timeoutMs: number) {
  const controller = new AbortController();
  let remaining = timeoutMs;
  let startedAt = Date.now();
  let inputDepth = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () =>
    new CliError({
      code: 'PLUGIN_TIMEOUT',
      message: `plugin command timed out after ${timeoutMs}ms of active execution`,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
  let rejectAbort!: (error: CliError) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const interruptedError = () =>
    new CliError({
      code: 'USER_INTERRUPT',
      message: 'Plugin command cancelled.',
      exitCode: EXIT_CODES.USER_INTERRUPT,
    });
  const cancel = () => controller.abort(interruptedError());
  const releaseInterrupt = registerCommandInterrupt(cancel);
  process.on('SIGINT', cancel);
  const failure = () =>
    controller.signal.reason instanceof CliError ? controller.signal.reason : timeoutError();
  const onAbort = () => rejectAbort(failure());
  // Subscribe before starting imports or plugin code so no abort can be missed.
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const arm = () => {
    if (disposed || controller.signal.aborted || inputDepth > 0) return;
    startedAt = Date.now();
    timer = setTimeout(() => controller.abort(timeoutError()), Math.max(0, remaining));
  };
  arm();
  return {
    signal: controller.signal,
    aborted,
    check() {
      if (controller.signal.aborted || disposed) throw failure();
    },
    async withInput<T>(operation: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted || disposed) throw failure();
      const restoreStdin = captureStdinState();
      if (inputDepth++ === 0) {
        clearTimeout(timer);
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      }
      try {
        return await operation();
      } finally {
        restoreStdin();
        inputDepth -= 1;
        if (inputDepth === 0) arm();
      }
    },
    dispose() {
      disposed = true;
      releaseInterrupt();
      process.removeListener('SIGINT', cancel);
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    },
  };
}
