import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Table } from './Table.js';
import type { Column } from './Table.js';
import { Section } from './Section.js';
import { theme } from './theme.js';
import { useTerminalSize } from './useTerminalSize.js';
import { isConHost } from './terminalCompat.js';
import { CliError } from '../utils/errors.js';

export interface InteractiveTableProps {
  columns: Column[];
  totalItems: number;
  perPage: number;
  /** Async function to load rows for a given page number. */
  loadPage: (page: number) => Promise<Record<string, string>[]>;
  initialPage?: number;
  /** Pre-loaded rows for the initial page, shown immediately without loading state. */
  initialRows?: Record<string, string>[];
  /** Persistent footer row shown below every page (e.g. totals). */
  footer?: Record<string, string>;
  /** Section decoration */
  title?: string;
  subtitle?: string;
  /** Per-page labels shown in status bar (e.g. period identifiers). */
  pageLabels?: string[];
}

export function InteractiveTable({
  columns,
  totalItems,
  perPage,
  loadPage,
  initialPage,
  initialRows,
  footer,
  title,
  subtitle,
  pageLabels,
}: InteractiveTableProps) {
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const startPage = initialPage ?? 1;
  const [page, setPage] = useState(startPage);
  const hasInitialRows = initialRows != null && initialRows.length > 0;
  const [rows, setRows] = useState<Record<string, string>[]>(hasInitialRows ? initialRows : []);
  const [loading, setLoading] = useState(!hasInitialRows);
  const [error, setError] = useState<string | null>(null);
  // Row-level scroll position within the current page's viewport.
  const [scrollOffset, setScrollOffset] = useState(0);

  // Decoration rows reserved around the table viewport: title, table header,
  // separator, footer status bar, scroll hint, and surrounding margin.
  const RESERVED = 8;
  const visibleRows = Math.max(1, termRows - RESERVED);
  const maxOffset = Math.max(0, rows.length - visibleRows);
  // Use Map to cache already-loaded page data
  const pageCacheRef = useRef(new Map<number, Record<string, string>[]>());
  // Write initialRows to cache on first render
  const initializedRef = useRef(false);
  const stableFooterRef = useRef('');
  if (!initializedRef.current && hasInitialRows) {
    pageCacheRef.current.set(startPage, initialRows);
    initializedRef.current = true;
  }

  const totalPages = Math.ceil(totalItems / perPage);

  // Clamp initial page to valid range
  useEffect(() => {
    if (page > totalPages && totalPages > 0) {
      setPage(totalPages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally clamp only when totalPages changes; including 'page' would cause infinite loop
  }, [totalPages]);

  useEffect(() => {
    let cancelled = false;
    const cache = pageCacheRef.current;

    if (cache.has(page)) {
      setRows(cache.get(page)!);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    loadPage(page)
      .then((newRows) => {
        if (!cancelled) {
          cache.set(page, newRows);
          setRows(newRows);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // If the error is a CliError, show only the user-friendly message
          // (no internal URLs / response bodies leaking into the UI)
          const message =
            err instanceof CliError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          setError(message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page, loadPage]);

  useInput((input, key) => {
    // Ctrl+C: explicit exit. With exitOnCtrlC: false at the renderer level,
    // each interactive component must opt in or the signal is silently swallowed.
    if (input === 'c' && key.ctrl) {
      exit();
      return;
    }

    // Exit: q, Escape, or Enter
    if (input === 'q' || key.escape || key.return) {
      exit();
      return;
    }

    if (loading) return; // Ignore navigation while loading

    // Navigate: → or 'n' for next page (reset viewport to top of new page)
    if ((input === 'n' || key.rightArrow) && page < totalPages) {
      setPage((p) => p + 1);
      setScrollOffset(0);
      return;
    }

    // Navigate: ← or 'p' for previous page (reset viewport to top of new page)
    if ((input === 'p' || key.leftArrow) && page > 1) {
      setPage((p) => p - 1);
      setScrollOffset(0);
      return;
    }

    // Scroll viewport up: ↑ or 'k'
    if (input === 'k' || key.upArrow) {
      setScrollOffset((o) => Math.max(0, o - 1));
      return;
    }

    // Scroll viewport down: ↓ or 'j'
    if (input === 'j' || key.downArrow) {
      setScrollOffset((o) => Math.min(maxOffset, o + 1));
      return;
    }

    // All other keys are intentionally ignored / consumed.
    // No-op: prevents unrecognized keystrokes from leaking to stdin.
  });

  // Viewport: render only the slice of the current page that fits the terminal.
  const canScroll = rows.length > visibleRows;
  const safeOffset = Math.min(scrollOffset, maxOffset);
  const visibleData = rows.slice(safeOffset, safeOffset + visibleRows);

  // Status bar (used as Section footer)
  const scrollHint = canScroll ? '↑/↓ scroll' : '';
  const navHints = [
    page > 1 ? '← prev' : '',
    page < totalPages ? 'next →' : '',
    scrollHint,
    'q/↵ quit',
  ]
    .filter(Boolean)
    .join('  ');

  const sectionTitle = title ?? 'Models';
  const windowInfo = canScroll
    ? `  rows ${safeOffset + 1}-${safeOffset + visibleData.length}/${rows.length}`
    : '';
  const pageLabel = pageLabels?.[page - 1] ?? '';
  const pageInfo = pageLabel
    ? `${pageLabel}  Page ${page}/${totalPages}`
    : `Page ${page}/${totalPages} (${totalItems} items)`;
  const currentFooter = `${pageInfo}${windowInfo}  ${navHints}`;
  if (!loading) {
    stableFooterRef.current = currentFooter;
  }
  const sectionFooter = stableFooterRef.current || currentFooter;

  // ConHost has no alternate screen buffer (entering it closes the window on
  // exit), so Ink falls back to log-update's diff erase — which miscounts
  // physical lines and leaves the title/header duplicated on redraw, anchored
  // at the bottom of the scrollback. Padding the frame to the full terminal
  // height forces Ink onto its clearTerminal full-repaint path instead: clean,
  // top-left-anchored output with no residue. Alt-screen terminals must NOT do
  // this — the padding rows collide with the alt-screen exit erase (residue).
  const fillScreen = isConHost();

  return (
    <Box flexDirection="column" width={termCols} {...(fillScreen ? { minHeight: termRows } : {})}>
      {/* Title - dynamic render to avoid Static residue on resize */}
      {title && (
        <Section title={sectionTitle} subtitle={subtitle} footer="">
          <Box />
        </Section>
      )}

      {/* Table content */}
      {loading && rows.length === 0 ? (
        <Box paddingLeft={2}>
          <Text>{theme.info(`Loading page ${page}...`)}</Text>
        </Box>
      ) : error ? (
        <Box paddingLeft={2}>
          <Text>{theme.error(`${theme.symbols.fail} Error: ${error}`)}</Text>
        </Box>
      ) : (
        <Box paddingLeft={2}>
          <Table columns={columns} data={visibleData} footer={footer} paddingLeft={0} truncate />
        </Box>
      )}

      {/* Footer with page info */}
      <Box paddingLeft={2}>
        <Text wrap="truncate-end">{theme.muted(sectionFooter)}</Text>
      </Box>
    </Box>
  );
}
