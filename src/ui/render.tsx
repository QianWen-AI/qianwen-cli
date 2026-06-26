import { PassThrough } from 'stream';
import React, { useEffect } from 'react';
import { render, useApp } from 'ink';
import { isReplMode } from '../utils/runtime-mode.js';
import { isConHost } from './terminalCompat.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

// Alternative screen buffer ANSI sequences. Entering switches the terminal to a
// blank, scrollback-isolated canvas (vim/less behaviour); exiting restores the
// previous content. Writing the literal sequences avoids pulling ansi-escapes
// as a direct dependency — pnpm hoists it transitively only for ink.
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

// Clear the visible screen and home the cursor. Used as the ConHost fallback
// for the clean-exit behaviour the alternate screen buffer provides elsewhere:
// ConHost cannot enter the alt-screen (doing so closes the window on exit), so
// on teardown we wipe the rendered TUI and let the next prompt start fresh
// instead of leaving the last frame stranded on the main screen.
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

// React context exposing whether the current interactive render runs on the
// alternative screen buffer. Full-screen components read this to skip the
// height-padding that would otherwise push Ink into its clearTerminal path —
// that path emits \x1b[3J, which wipes terminal scrollback on Terminal.app /
// iTerm2. On the alt-screen the buffer switch already guarantees a clean exit,
// so the padding is unnecessary there and the scrollback stays intact.
export const AltScreenContext = React.createContext<boolean>(false);

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

interface InkErrorBoundaryProps {
  readonly onError: (error: unknown) => void;
  readonly children: React.ReactNode;
}

/**
 * Catches render-time exceptions thrown by any descendant so the host
 * {@link renderInteractive} / {@link renderWithInk} call can surface them as a
 * normal rejected promise. Without it, Ink's built-in `InternalApp` boundary
 * swallows the error, prints a raw React component stack to the terminal, and
 * leaves `waitUntilExit()` pending — which is exactly how the support `rate`
 * picker and `reply` ticket view crashed with an unreadable dump instead of a
 * graceful CLI error.
 */
export class InkErrorBoundary extends React.Component<
  InkErrorBoundaryProps,
  { failed: boolean }
> {
  constructor(props: InkErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Wrap a captured Ink render error as a graceful, formattable CliError. */
function toInkRenderError(error: unknown): CliError {
  const message = error instanceof Error ? error.message : String(error);
  return new CliError({
    code: 'RENDER_ERROR',
    message: `Failed to render interactive view: ${message}`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
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

  let capturedError: unknown = null;
  // Holder lets the boundary callback (created in the render() call below) reach
  // the instance's unmount, which only exists once render() returns.
  const ctl: { unmount?: () => void } = {};
  const instance = render(
    <InkErrorBoundary
      onError={(e) => {
        capturedError = e;
        ctl.unmount?.();
      }}
    >
      <AutoExitWrapper>{element}</AutoExitWrapper>
    </InkErrorBoundary>,
    {
      stdout: process.stdout,
      stdin: dummyStdin as any,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  ctl.unmount = instance.unmount;

  // Resolves only after AutoExitWrapper calls app.exit() (or the boundary
  // catches a render error and unmounts).
  await instance.waitUntilExit();

  // Surface any render-time crash as a graceful CLI error instead of letting
  // Ink's boundary dump a raw component stack to the terminal.
  if (capturedError) throw toInkRenderError(capturedError);

  // Write a trailing newline so the shell prompt appears on its own line.
  process.stdout.write('\n');

  // Wait one event-loop tick so Ink's internal async handles fully close.
  // Prevents libuv assertion failures on Windows when process.exit() follows.
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Options for {@link renderInteractive}.
 */
export interface RenderInteractiveOptions {
  /**
   * Whether to switch to the alternative screen buffer for the duration of
   * the render. Defaults to `true`. Set to `false` for inline editors that
   * should stay anchored within the existing terminal scrollback (e.g. the
   * multi-line text editor used by support flows).
   */
  altScreen?: boolean;
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
export async function renderInteractive(
  element: React.ReactElement,
  options: RenderInteractiveOptions = {},
): Promise<void> {
  const { altScreen = true } = options;

  // Save existing stdin listeners registered by readline/REPL,
  // then remove them so only Ink receives keystrokes during pagination.
  const savedDataListeners = process.stdin.rawListeners('data').slice();
  const savedKeypressListeners = process.stdin.rawListeners('keypress').slice();
  // Isolate stdout 'resize' listeners so readline's terminal-mode handler does
  // not redraw its prompt inside the alt-screen, which would corrupt Ink's view.
  const savedResizeListeners = process.stdout.rawListeners('resize').slice();
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');
  process.stdout.removeAllListeners('resize');

  // Switch to the alternative screen buffer so Ink renders on a clean canvas
  // anchored to the top of the viewport. Resize redraws happen in this buffer
  // without leaking residue from the main screen, and the user's original
  // terminal contents are restored automatically on exit. Inline editors
  // opt out by passing `altScreen: false` so the surrounding output stays
  // visible above the editor.
  // Windows ConHost (legacy console host backing PowerShell when neither
  // Windows Terminal nor a TERM_PROGRAM is in effect) closes its window on
  // alt-screen exit, which would terminate the REPL after every interactive
  // command. Detect and skip alt-screen in that environment.
  const wantsAltScreen = altScreen && Boolean(process.stdout.isTTY);
  const useAltScreen = wantsAltScreen && !isConHost();
  // When a full-screen TUI was requested but the alt-screen is unavailable
  // (ConHost), emulate the alt-screen's clean exit by clearing the screen on
  // teardown. Callers that explicitly opt out of the alt-screen (altScreen:
  // false, e.g. inline editors) are excluded so their output stays anchored.
  const clearOnExit = wantsAltScreen && !useAltScreen;
  if (useAltScreen) {
    process.stdout.write(ENTER_ALT_SCREEN);
  }

  let capturedError: unknown = null;
  try {
    const ctl: { unmount?: () => void } = {};
    const instance = render(
      <InkErrorBoundary
        onError={(e) => {
          capturedError = e;
          ctl.unmount?.();
        }}
      >
        <AltScreenContext.Provider value={useAltScreen}>{element}</AltScreenContext.Provider>
      </InkErrorBoundary>,
      {
        stdout: process.stdout,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    ctl.unmount = instance.unmount;

    await instance.waitUntilExit();

    // Drain any residual bytes from stdin buffer
    await drainStdin();
  } finally {
    if (useAltScreen) {
      process.stdout.write(EXIT_ALT_SCREEN);
    } else if (clearOnExit) {
      process.stdout.write(CLEAR_SCREEN);
    }
    // Ensure stdin returns to cooked mode before downstream readline runs.
    // Ink enables raw mode during render and calls setRawMode(false) on
    // unmount, but event-loop ordering can leave stdin still in raw mode by
    // the time this finally block executes — causing readline to receive
    // duplicated keystrokes (e.g. confirmPrompt echoing "yy" for one "y").
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore environments that don't support setRawMode
      }
    }
    // Restore readline's listeners so REPL resumes normal operation
    for (const fn of savedDataListeners) {
      process.stdin.on('data', fn as (...args: any[]) => void);
    }
    for (const fn of savedKeypressListeners) {
      process.stdin.on('keypress', fn as (...args: any[]) => void);
    }

    // Drop any resize listener Ink registered, then restore readline's so the
    // REPL prompt redraws correctly on the main screen again.
    process.stdout.removeAllListeners('resize');
    for (const fn of savedResizeListeners) {
      process.stdout.on('resize', fn as (...args: unknown[]) => void);
    }

    if (isReplMode()) {
      // Ink calls stdin.unref() during cleanup (App.componentWillUnmount),
      // which allows Node's event loop to exit if no other handles are active.
      // Re-ref stdin so subsequent readline/confirmPrompt calls keep the
      // process alive while waiting for user input.
      process.stdin.ref();
      // Pair ref() with resume(): unref() alone leaves the handle present but
      // unobserved on Windows ConHost, where readline can stop pumping data
      // events until the next keystroke. resume() forces the read pump back on.
      process.stdin.resume();
    } else {
      // One-shot mode: nothing else will read from stdin after this point.
      // Pause + unref so the underlying handle stops blocking the event loop;
      // otherwise the shell prompt only re-appears after an extra Enter press.
      try {
        process.stdin.pause();
      } catch {
        // ignore environments that disallow pausing stdin
      }
      process.stdin.unref();
    }
  }

  // Re-throw any captured render error AFTER stdin/terminal state is restored,
  // so the caller's try/catch (and the unified error handler) sees a graceful
  // CliError rather than Ink's raw component-stack dump.
  if (capturedError) throw toInkRenderError(capturedError);
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
