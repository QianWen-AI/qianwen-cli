import React, { useCallback, useEffect, useRef } from 'react';
import { useApp, useStdin, useStdout } from 'ink';
import type { RechargeResultFinalViewModel } from '../view-models/billing/recharge.js';

// End-of-text (Ctrl+C) byte, built from its code so no literal control
// character sits in the source.
const ETX = String.fromCharCode(3);

/** Properties accepted by the payment-result waiting frame. */
export interface RechargePaymentWaitInkProps {
  readonly resultPromise: Promise<RechargeResultFinalViewModel>;
  readonly onCancel: () => void;
  /** Whether the terminal can hand keystrokes to Ink for cancellation. */
  readonly interactive: boolean;
  /** Append a previously hidden QR after the terminal becomes wide enough. */
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
  const { stdin, isRawModeSupported } = useStdin();
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
  onWidthChangeRef.current = onWidthChange;

  const handleCtrlC = useCallback(() => {
    onCancelRef.current();
    exitRef.current();
  }, []);

  // Own stdin directly rather than through Ink's useInput. Ink reads input from
  // a paused-mode `readable` listener, which on Windows can withhold the first
  // keystroke and release it only once the next one arrives — the off-by-one
  // that made a single Ctrl+C unreliable. A `data` listener puts the TTY in
  // flowing mode, where every keystroke is delivered the instant it is typed.
  // Non-TTY waits skip this: Ink rejects raw mode there and no signal reaches
  // this frame anyway.
  useEffect(() => {
    if (!interactive) return;
    const canRawMode = isRawModeSupported && typeof stdin.setRawMode === 'function';
    if (canRawMode) stdin.setRawMode(true);
    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.includes(ETX)) handleCtrlC();
    };
    stdin.on('data', onData);

    // Terminal resize on Windows can knock stdin out of flowing/raw mode
    // (libuv reinitialises the console input handle when processing
    // WINDOW_BUFFER_SIZE_EVENT records).  Re-assert raw + flowing after
    // every resize so the first post-resize Ctrl+C is delivered immediately.
    const onResize = () => {
      if (canRawMode) stdin.setRawMode(true);
      stdin.resume();
      onWidthChangeRef.current?.(stdout.columns ?? 80);
    };
    stdout.on('resize', onResize);
    // Cover a resize that happened after the initial static write but before
    // this effect attached its listener.
    onWidthChangeRef.current?.(stdout.columns ?? 80);

    return () => {
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      if (canRawMode) stdin.setRawMode(false);
    };
  }, [interactive, stdin, isRawModeSupported, handleCtrlC, stdout]);

  useEffect(() => {
    let active = true;
    // Defer one tick so Ink finishes mounting before the renderer is closed,
    // which matters when the promise is already settled.
    const finish = () => {
      if (active) setImmediate(exit);
    };
    void resultPromise.then(finish, finish);
    return () => {
      active = false;
    };
  }, [exit, resultPromise]);

  // The wait renders nothing: all visible lines are static main-screen text.
  return <></>;
}
