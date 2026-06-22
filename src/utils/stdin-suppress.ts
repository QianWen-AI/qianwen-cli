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

  const wasRaw = process.stdin.isRaw ?? false;
  const savedDataListeners = process.stdin.rawListeners('data').slice();
  const savedKeypressListeners = process.stdin.rawListeners('keypress').slice();

  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');

  try {
    process.stdin.setRawMode(true);
  } catch {
    // some environments may not support raw mode
  }

  process.stdin.resume();

  let _aborted = false;
  let resolveAbort: () => void;
  const onAbort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.stdin.removeListener('data', tempHandler);

    try {
      process.stdin.setRawMode(wasRaw);
    } catch {
      // ignore
    }

    for (const fn of savedDataListeners) {
      process.stdin.on('data', fn as (...args: unknown[]) => void);
    }
    for (const fn of savedKeypressListeners) {
      process.stdin.on('keypress', fn as (...args: unknown[]) => void);
    }

    // suppressStdin() always calls resume(), so undo it and unref the handle.
    // pause() stops data flow but the underlying libuv handle remains ref'd,
    // which prevents the event loop from draining in one-shot CLI mode.
    // unref() tells Node.js this handle should not keep the process alive.
    process.stdin.pause();
    process.stdin.unref();
  };

  const tempHandler = (chunk: Buffer): void => {
    if (chunk[0] === 0x03) {
      // Ctrl+C: signal abort so the polling loop breaks via Promise.race
      _aborted = true;
      resolveAbort();
    }
    // All other bytes: discard silently
  };

  process.stdin.on('data', tempHandler);

  return { restore, aborted: () => _aborted, onAbort };
}
