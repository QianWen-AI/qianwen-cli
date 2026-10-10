import {
  attemptTerminalCleanup,
  captureStdinState,
  isolateTerminalListeners,
} from './stdin-control.js';

/** Result of stdin suppression setup: restore, abort detection, and abort promise. */
export interface StdinSuppression {
  restore: () => void;
  aborted: () => boolean;
  onAbort: Promise<void>;
}

/** Suppress stdin during polling, discarding all input except Ctrl+C. Noop in non-TTY. */
export function suppressStdin(): StdinSuppression {
  if (!process.stdin.isTTY) {
    return { restore: () => {}, aborted: () => false, onAbort: new Promise(() => {}) };
  }

  const restoreState = captureStdinState();
  let restoreListeners: (() => void) | undefined;
  let aborted = false;
  let resolveAbort: () => void = () => {};
  const onAbort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    attemptTerminalCleanup(() => process.stdin.removeListener('data', tempHandler));
    restoreListeners?.();
    restoreState();
  };

  const tempHandler = (chunk: Buffer | string): void => {
    if (!restored && !aborted && chunk.includes(String.fromCharCode(3))) {
      // Ctrl+C: signal abort so the polling loop breaks via Promise.race
      aborted = true;
      resolveAbort();
    }
    // All other bytes: discard silently
  };

  try {
    restoreListeners = isolateTerminalListeners(process.stdin, ['data', 'keypress']);
    process.stdin.on('data', tempHandler);
    attemptTerminalCleanup(() => process.stdin.setRawMode(true));
    attemptTerminalCleanup(() => process.stdin.resume());
  } catch (error) {
    restore();
    throw error;
  }

  return { restore, aborted: () => aborted, onAbort };
}
