import { isReplMode } from './runtime-mode.js';
import type { EventEmitter } from 'node:events';

/** Run one terminal operation without preventing the remaining cleanup steps. */
export function attemptTerminalCleanup(operation: () => void): void {
  try {
    operation();
  } catch {
    // Closed or redirected terminal handles must not strand another resource.
  }
}

/** Read the optional libuv reference state without depending on it being present. */
function readReferenceState(stdin: NodeJS.ReadStream): boolean | undefined {
  try {
    const handle: unknown = Reflect.get(stdin, '_handle');
    if (typeof handle !== 'object' || handle === null) return undefined;
    const hasRef: unknown = Reflect.get(handle, 'hasRef');
    if (typeof hasRef !== 'function') return undefined;
    const referenced: unknown = Reflect.apply(hasRef, handle, []);
    return typeof referenced === 'boolean' ? referenced : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture raw/flow/ref state and return an idempotent, exception-safe restorer.
 * An untouched stream (flow=null) is restored to quiescent pause/unref: Node's
 * public API cannot recreate null after reading, and retaining that new read
 * handle would require an extra keystroke to exit a one-shot command.
 */
export function captureStdinState(stdin: NodeJS.ReadStream = process.stdin): () => void {
  const raw = stdin.isRaw;
  const flowing = stdin.readableFlowing;
  const referenced = readReferenceState(stdin) ?? (flowing === true || isReplMode());
  let restored = false;

  return () => {
    if (restored) return;
    restored = true;
    if (typeof raw === 'boolean' && stdin.isTTY) {
      attemptTerminalCleanup(() => stdin.setRawMode(raw));
    }
    attemptTerminalCleanup(() => {
      if (flowing === true) stdin.resume();
      else stdin.pause();
    });
    attemptTerminalCleanup(() => {
      if (flowing !== null && referenced) stdin.ref();
      else stdin.unref();
    });
  };
}

/**
 * Temporarily detach only listeners present at entry, preserving once wrappers.
 * Restoration leaves listeners installed by other owners during the session intact.
 */
export function isolateTerminalListeners(emitter: EventEmitter, events: string[]): () => void {
  const detached: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const { event, listener } of detached) {
      attemptTerminalCleanup(() => emitter.on(event, listener));
    }
  };
  try {
    for (const event of events) {
      for (const listener of emitter.rawListeners(event)) {
        emitter.removeListener(event, listener);
        detached.push({ event, listener: listener as (...args: unknown[]) => void });
      }
    }
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

/**
 * Reconcile stdin state after an interactive Ink render returns.
 *
 * In REPL mode the process must stay alive for the next prompt, so stdin is
 * re-referenced and resumed. In one-shot mode nothing else will read from
 * stdin, so it is left paused/unref'd (as the renderer left it) allowing the
 * event loop to drain and the process to exit naturally.
 */
export function releaseOrKeepStdin(): void {
  if (!isReplMode()) return;
  attemptTerminalCleanup(() => {
    if (process.stdin.isPaused()) process.stdin.resume();
  });
  attemptTerminalCleanup(() => process.stdin.ref());
}
