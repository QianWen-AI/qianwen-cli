import React, { useCallback, useEffect, useRef } from 'react';
import { useApp, useStdin, useStdout } from 'ink';
import type { RechargeResultFinalViewModel } from '../view-models/billing/recharge.js';
import { attemptTerminalCleanup } from '../utils/stdin-control.js';

// End-of-text (Ctrl+C) byte, built from its code so no literal control
// character sits in the source.
const ETX = String.fromCharCode(3);

/** Properties accepted by the payment-result waiting frame. */
export interface RechargePaymentWaitInkProps {
  readonly resultPromise: Promise<RechargeResultFinalViewModel>;
  readonly onCancel: () => void;
  /** Whether the terminal can hand keystrokes to Ink for cancellation. */
  readonly interactive: boolean;
  /** Append the QR after the terminal becomes wide enough. */
  readonly onWidthChange?: (columns: number) => void;
}

/**
 * Hold a keypress listener open until the order's outcome settles.
 *
 * This frame paints nothing. Everything the user reads — the order, its link,
 * the QR code, the waiting notice, and the final result — is static main-screen
 * text written by the command, because none of it changes while polling.
 *
 * While idle this frame paints nothing, which is what makes the wait
 * resize-proof. Ink re-renders on
 * resize using the strings from the previous layout width before React can
 * recompute them, so any line whose length approaches the terminal width will
 * soft-wrap into two physical rows while Ink still erases one logical row —
 * leaving a residual row on every resize. `truncate-end` does not help, since it
 * only applies after that re-render. An empty frame has no line to mis-erase.
 * Foreground QR output reflows without application-side redraw. When a compact
 * or background QR was initially too wide, the resize callback may append it
 * once; the Ink frame itself remains empty throughout.
 *
 * Cancellation is bound to a keystroke rather than a process signal: the REPL
 * keeps readline in raw mode, where readline consumes Ctrl+C and no SIGINT ever
 * reaches the process. Without this the wait would be uninterruptible and a
 * second Ctrl+C would take down the whole REPL session.
 */
export function RechargePaymentWaitInk({
  resultPromise,
  onCancel,
  interactive,
  onWidthChange,
}: RechargePaymentWaitInkProps): React.ReactElement {
  const { exit } = useApp();
  const { stdin, isRawModeSupported, setRawMode } = useStdin();
  const { stdout } = useStdout();

  // The keystroke listener is attached once and never re-bound, so the latest
  // callbacks are read through refs rather than captured in its closure.
  // Re-binding on every render could drop the very Ctrl+C the listener exists
  // to catch.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const exitRef = useRef(exit);
  exitRef.current = exit;
  const onWidthChangeRef = useRef(onWidthChange);
  useEffect(() => {
    onWidthChangeRef.current = onWidthChange;
  }, [onWidthChange]);
  const canceledRef = useRef(false);

  const handleCtrlC = useCallback(() => {
    if (canceledRef.current) return;
    canceledRef.current = true;
    try {
      onCancelRef.current();
    } finally {
      exitRef.current();
    }
  }, []);

  // The renderer supplies a flowing-input bridge for this frame. Ink manages raw
  // mode on that bridge while the physical Windows TTY remains free of readable
  // listeners, so the first keystroke is delivered without delay.
  useEffect(() => {
    if (!interactive) return;
    let active = true;
    let acquiredRaw = false;
    const onData = (chunk: string | Buffer) => {
      if (!active) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.includes(ETX)) handleCtrlC();
    };
    const onResize = () => {
      if (!active) return;
      onWidthChangeRef.current?.(stdout.columns ?? 80);
    };
    const cleanup = () => {
      active = false;
      attemptTerminalCleanup(() => stdin.off('data', onData));
      attemptTerminalCleanup(() => stdout.off('resize', onResize));
      onWidthChangeRef.current = undefined;
      if (acquiredRaw) attemptTerminalCleanup(() => setRawMode(false));
    };
    try {
      stdin.on('data', onData);
      stdout.on('resize', onResize);
      if (isRawModeSupported) {
        setRawMode(true);
        acquiredRaw = true;
      }
      onResize();
    } catch (error) {
      cleanup();
      throw error;
    }
    return cleanup;
  }, [interactive, stdin, isRawModeSupported, setRawMode, handleCtrlC, stdout]);

  useEffect(() => {
    let active = true;
    let pendingExit: ReturnType<typeof setImmediate> | undefined;
    // Defer one tick so Ink finishes mounting before the renderer is closed,
    // which matters when the promise is already settled.
    const finish = () => {
      if (active) pendingExit = setImmediate(() => active && exit());
    };
    void resultPromise.then(finish, finish);
    return () => {
      active = false;
      if (pendingExit) clearImmediate(pendingExit);
    };
  }, [exit, resultPromise]);

  // The wait renders nothing: all visible lines are static main-screen text.
  return <></>;
}
