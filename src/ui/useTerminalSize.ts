import { useState, useEffect } from 'react';
import { isConHost } from './terminalCompat.js';

export interface TerminalSize {
  columns: number;
  rows: number;
}

function readSize(): TerminalSize {
  const rawColumns = process.stdout.columns ?? 80;
  // Legacy ConHost wraps a line to the next physical row the instant it fills
  // the final column (eager auto-wrap, no deferred-wrap support). Ink erases the
  // previous frame by logical line count, so any full-width line becomes an
  // un-erased physical row on redraw — surfacing as a duplicated title/header
  // during pagination. Reserving the last column keeps physical lines aligned
  // with Ink's logical count.
  const columns = isConHost() ? Math.max(1, rawColumns - 1) : rawColumns;
  return {
    columns,
    rows: process.stdout.rows ?? 24,
  };
}

/**
 * React hook that returns the current terminal size and re-renders the
 * consuming component whenever the host terminal is resized.
 *
 * Falls back to a sensible default (80×24) when the stream does not expose
 * dimensions (e.g., when output is piped or running in a non-TTY environment).
 */
export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(readSize);

  useEffect(() => {
    const onResize = () => {
      setSize(readSize());
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  return size;
}
