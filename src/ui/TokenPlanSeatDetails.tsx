import React from 'react';
import { Box, Text } from 'ink';
import type { TokenPlanSeatDetailsViewModel } from '../types/tokenplan-subscription.js';
import { useTerminalSize } from './useTerminalSize.js';
import { Table } from './Table.js';
import { visibleWidth, wrapText } from './textWrap.js';

function StackedSeat({ headers, row, width }: { headers: string[]; row: string[]; width: number }) {
  const labelWidth = Math.min(
    Math.max(...headers.map(visibleWidth)),
    Math.max(1, Math.floor((width - 4) / 2)),
  );
  const valueWidth = Math.max(1, width - labelWidth - 4);
  const lines = headers.flatMap((header, index) => {
    const labels = wrapText(header, labelWidth);
    const values = wrapText(row[index] ?? '', valueWidth);
    return Array.from({ length: Math.max(labels.length, values.length) }, (_, line) => ({
      label: labels[line] ?? '',
      value: values[line] ?? '',
    }));
  });
  return (
    <Table
      columns={[
        { key: 'label', header: lines[0].label, width: labelWidth },
        { key: 'value', header: lines[0].value, width: valueWidth },
      ]}
      data={lines.slice(1)}
      paddingLeft={0}
    />
  );
}

export function TokenPlanSeatDetails({
  details,
  indent = 4,
  titleGap = 0,
}: {
  details: TokenPlanSeatDetailsViewModel;
  indent?: number;
  titleGap?: number;
}) {
  const { columns } = useTerminalSize();
  const width = Math.max(1, columns - indent);
  const tableWidth = details.headers.reduce(
    (sum, header, index) =>
      sum +
      Math.max(visibleWidth(header), ...details.rows.map((row) => visibleWidth(row[index] ?? ''))),
    (details.headers.length - 1) * 3 + 1,
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginBottom={titleGap}>
        <Text bold>{details.title}</Text>
      </Box>
      {!details.noteAfterRows && details.note && <Text>{details.note}</Text>}
      {details.rows.length > 0 &&
        (tableWidth <= width ? (
          <Table
            columns={details.headers.map((header, index) => ({ key: String(index), header }))}
            data={details.rows.map((row) =>
              Object.fromEntries(row.map((value, index) => [String(index), value])),
            )}
            paddingLeft={0}
          />
        ) : (
          <Box flexDirection="column" gap={1}>
            {details.rows.map((row, index) => (
              <StackedSeat key={index} headers={details.headers} row={row} width={width} />
            ))}
          </Box>
        ))}
      {details.noteAfterRows && details.note && <Text>{details.note}</Text>}
    </Box>
  );
}
