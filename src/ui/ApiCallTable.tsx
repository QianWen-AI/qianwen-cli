import React from 'react';
import type { ApiCallViewModel } from '../view-models/api-call.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import { breakByDisplayWidth, visibleWidth } from './textWrap.js';
import { useTerminalSize } from './useTerminalSize.js';

function ApiCallTable({ vm }: { vm: ApiCallViewModel }) {
  const { columns } = useTerminalSize();
  // Reserve padding, divider and a trailing column; wrap without dropping data or spaces.
  const available = Math.max(10, columns - 7);
  const fieldWidth = Math.max(
    5,
    Math.min(
      Math.floor(available / 3),
      vm.rows.reduce((width, row) => Math.max(width, visibleWidth(row.field)), 5),
    ),
  );
  const valueWidth = available - fieldWidth;
  const rows = vm.rows.flatMap((row) => {
    const fields = breakByDisplayWidth(row.field, fieldWidth);
    const values = breakByDisplayWidth(row.value, valueWidth);
    return Array.from({ length: Math.max(fields.length, values.length) }, (_, index) => ({
      field: fields[index] ?? '',
      value: values[index] ?? '',
    }));
  });
  return (
    <Table
      columns={[
        { key: 'field', header: 'FIELD', width: fieldWidth },
        { key: 'value', header: 'VALUE', width: valueWidth },
      ]}
      data={rows}
    />
  );
}

export async function renderApiCallInk(vm: ApiCallViewModel): Promise<void> {
  await renderWithInk(<ApiCallTable vm={vm} />);
}
