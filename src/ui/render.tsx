import { PassThrough } from 'stream';
import React, { useEffect } from 'react';
import { render, useApp } from 'ink';

// ── Internal wrapper ──────────────────────────────────────────────────────────

/**
 * Wraps any element and calls `app.exit()` after the first render cycle,
 * signalling Ink that rendering is complete. This lets `waitUntilExit()`
 * resolve precisely when the component has finished writing to stdout.
 */
function AutoExitWrapper({ children }: { children: React.ReactNode }) {
  const app = useApp();
  useEffect(() => {
    // Schedule exit after the current render is committed to stdout.
    // Using setImmediate ensures the paint has flushed before we signal done.
    const handle = setImmediate(() => app.exit());
    return () => clearImmediate(handle);
  }, [app]);
  return <>{children}</>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a static Ink element and wait until it has fully painted to stdout.
 *
 * Passes a dummy PassThrough stream as stdin so Ink never touches the real
 * process.stdin — eliminating all raw-mode / pause / resume races with the
 * REPL's readline interface.
 *
 * Uses `waitUntilExit()` (Ink's official API) so the returned Promise resolves
 * only after the component has rendered and Ink has flushed its output. This
 * guarantees that in REPL mode the shell prompt (`qianwen ▸`) appears on a
 * fresh line — never mid-output.
 *
 * Usage in commands:
 * ```
 * if (format === 'table') {
 *   await renderWithInk(<MyComponent data={vm} />);
 *   return;
 * }
 * ```
 */
export async function renderWithInk(element: React.ReactElement): Promise<void> {
  // Use a dummy stdin so Ink never calls setRawMode / pause / resume on the
  // real process.stdin, which would interfere with the REPL's readline state.
  const dummyStdin = new PassThrough();

  const { waitUntilExit } = render(<AutoExitWrapper>{element}</AutoExitWrapper>, {
    stdout: process.stdout,
    stdin: dummyStdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  // Resolves only after AutoExitWrapper calls app.exit().
  await waitUntilExit();

  // Write a trailing newline so the shell prompt appears on its own line.
  process.stdout.write('\n');

  // Wait one event-loop tick so Ink's internal async handles fully close.
  // Prevents libuv assertion failures on Windows when process.exit() follows.
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Render an interactive Ink element that requires real keyboard input
 * (e.g. InteractiveTable with useInput).
 *
 * Unlike renderWithInk() which uses a dummy stdin for static content,
 * this function uses the real process.stdin so useInput works correctly.
 * After Ink exits, it drains any residual bytes from stdin to prevent
 * them from leaking into subsequent readline / REPL input.
 */
export async function renderInteractive(element: React.ReactElement): Promise<void> {
  // Save existing stdin listeners registered by readline/REPL,
  // then remove them so only Ink receives keystrokes during pagination.
  const savedDataListeners = process.stdin.rawListeners('data').slice();
  const savedKeypressListeners = process.stdin.rawListeners('keypress').slice();
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');

  try {
    const { waitUntilExit } = render(element, {
      stdout: process.stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await waitUntilExit();

    // Drain any residual bytes from stdin buffer
    await drainStdin();
  } finally {
    // Restore readline's listeners so REPL resumes normal operation
    for (const fn of savedDataListeners) {
      process.stdin.on('data', fn as (...args: any[]) => void);
    }
    for (const fn of savedKeypressListeners) {
      process.stdin.on('keypress', fn as (...args: any[]) => void);
    }
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Read and discard any bytes buffered in stdin that were not consumed
 * by Ink's useInput during the interactive session.
 */
function drainStdin(): Promise<void> {
  return new Promise<void>((resolve) => {
    // If stdin is not readable or not a TTY, nothing to drain
    if (!process.stdin.readable || !process.stdin.isTTY) {
      resolve();
      return;
    }

    // Read and discard any buffered data
    const flush = () => {
      while (process.stdin.read() !== null) {
        // discard
      }
    };

    flush();

    // Give a short delay for any in-flight bytes to arrive, then flush again
    setTimeout(() => {
      flush();
      resolve();
    }, 16);
  });
}

/**
 * Alias kept for one-shot mode (non-REPL). Behaviour is identical to
 * `renderWithInk` — both now properly await Ink's exit signal.
 * @deprecated Use renderWithInk directly. This alias exists for backward compatibility.
 */
export const renderWithInkSync = renderWithInk;
