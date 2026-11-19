import React from 'react';
import { Box, Text } from 'ink';
import { Table } from './Table.js';
import { useTerminalSize } from './useTerminalSize.js';
import type { TokenPlanDisplayTable } from '../view-models/subscription/tokenplan-details.js';
import { visibleWidth } from './textWrap.js';
import { colors } from './theme.js';

export function TokenPlanDetailTables({
  tables,
  paddingLeft = 2,
  maxTotalWidth,
  showNarrowLayoutHint = false,
  recordTitleGap = 1,
}: {
  tables: TokenPlanDisplayTable[];
  paddingLeft?: number;
  maxTotalWidth?: number;
  showNarrowLayoutHint?: boolean;
  recordTitleGap?: number;
}) {
  const { columns } = useTerminalSize();
  const width = Math.max(1, (maxTotalWidth ?? columns - 2) - paddingLeft);
  return (
    <>
      {tables.map((table) => {
        // Match Table's reserved trailing header space when choosing the layout.
        const matrixWidth =
          table.headers.reduce(
            (total, header, index) =>
              total +
              Math.max(
                visibleWidth(header),
                ...table.rows.map((row) => visibleWidth(row[index] ?? '')),
              ),
            0,
          ) +
          (table.headers.length - 1) * 3 +
          1;
        const useRecordLayout = Boolean(table.layout && matrixWidth > width);
        return (
          <Box key={table.title} flexDirection="column" marginTop={1}>
            <Text bold>{table.title}</Text>
            <Box flexDirection="column" paddingLeft={paddingLeft}>
              {table.rows.length === 0 ? (
                <Text>{table.emptyMessage}</Text>
              ) : useRecordLayout ? (
                table.rows.map((row, index) => (
                  <Box
                    key={index}
                    flexDirection="column"
                    marginTop={index === 0 ? recordTitleGap : 1}
                  >
                    <Text bold>
                      {table.layout === 'records' ? `${table.headers[0]}: ${row[0]}` : row[0]}
                    </Text>
                    {table.headers.slice(1).map((header, cell) => (
                      <Text key={cell}>
                        {header}: {row[cell + 1]}
                      </Text>
                    ))}
                  </Box>
                ))
              ) : (
                <Table
                  columns={table.headers.map((header, index) => ({ key: String(index), header }))}
                  data={table.rows.map((row) =>
                    Object.fromEntries(row.map((cell, index) => [String(index), cell])),
                  )}
                  truncate
                  paddingLeft={0}
                  maxTotalWidth={width}
                />
              )}
              {table.note && <Text>{table.note}</Text>}
              {table.rows.length > 0 && useRecordLayout && showNarrowLayoutHint && (
                <Text color={colors.muted}>
                  Note: Widen the terminal to view this section as a table.
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
    </>
  );
}
