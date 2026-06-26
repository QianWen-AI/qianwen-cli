import { isReplMode } from './runtime-mode.js';

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
  if (process.stdin.isPaused()) {
    process.stdin.resume();
  }
  process.stdin.ref();
}
