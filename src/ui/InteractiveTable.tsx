import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, Static } from 'ink';
import { Table } from './Table.js';
import type { Column } from './Table.js';
import { Section } from './Section.js';
import { theme } from './theme.js';
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
}: InteractiveTableProps) {
  const { exit } = useApp();
  const startPage = initialPage ?? 1;
  const [page, setPage] = useState(startPage);
  const hasInitialRows = initialRows != null && initialRows.length > 0;
  const [rows, setRows] = useState<Record<string, string>[]>(hasInitialRows ? initialRows : []);
  const [loading, setLoading] = useState(!hasInitialRows);
  const [error, setError] = useState<string | null>(null);
  // Use Map to cache already-loaded page data
  const pageCacheRef = useRef(new Map<number, Record<string, string>[]>());
  // Write initialRows to cache on first render
  const initializedRef = useRef(false);
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
          const message = err instanceof CliError
            ? err.message
            : err instanceof Error ? err.message : String(err);
          setError(message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page, loadPage]);

  useInput((input, key) => {
    // Exit: q, Escape, or Enter
    if (input === 'q' || key.escape || key.return) {
      exit();
      return;
    }

    if (loading) return; // Ignore page changes while loading

    // Navigate: → or 'n' for next page
    if ((input === 'n' || key.rightArrow) && page < totalPages) {
      setPage((p) => p + 1);
      return;
    }

    // Navigate: ← or 'p' for previous page
    if ((input === 'p' || key.leftArrow) && page > 1) {
      setPage((p) => p - 1);
      return;
    }

    // All other keys are intentionally ignored / consumed.
    // No-op: prevents unrecognized keystrokes from leaking to stdin.
  });

  // Status bar (used as Section footer)
  const navHints = [page > 1 ? '← prev' : '', page < totalPages ? 'next →' : '', 'q/↵ quit']
    .filter(Boolean)
    .join('  ');

  const sectionTitle = title ?? 'Models';
  const sectionFooter = `Page ${page}/${totalPages} (${totalItems} items)  ${navHints}`;

  return (
    <Box flexDirection="column">
      {/* Title - rendered via Static to guarantee single output on Windows */}
      {title && (
        <Static items={[{ id: 'title' }]}>
          {(item) => (
            <Box key={item.id}>
              <Section title={sectionTitle} subtitle={subtitle} footer="">
                <Box />
              </Section>
            </Box>
          )}
        </Static>
      )}

      {/* Table content */}
      {loading ? (
        <Box paddingLeft={2}>
          <Text>{theme.info(`Loading page ${page}...`)}</Text>
        </Box>
      ) : error ? (
        <Box paddingLeft={2}>
          <Text>{theme.error(`${theme.symbols.fail} Error: ${error}`)}</Text>
        </Box>
      ) : (
        <Box paddingLeft={2}>
          <Table columns={columns} data={rows} footer={footer} paddingLeft={0} />
        </Box>
      )}

      {/* Footer with page info */}
      <Box paddingLeft={2}>
        <Text>{theme.muted(sectionFooter)}</Text>
      </Box>
    </Box>
  );
}
