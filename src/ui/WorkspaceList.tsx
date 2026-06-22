import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import type { WorkspaceListViewModel } from '../view-models/workspace/index.js';

const COLUMNS = [
  { key: 'id', header: 'ID' },
  { key: 'name', header: 'Name' },
  { key: 'region', header: 'Region' },
  { key: 'createdAt', header: 'Created' },
  { key: 'isDefault', header: 'Default' },
];

export interface WorkspaceListInkProps {
  vm: WorkspaceListViewModel;
}

export function WorkspaceListInk({ vm }: WorkspaceListInkProps) {
  const data = vm.rows.map((row) => ({
    id: row.id,
    name: row.name,
    region: row.region,
    createdAt: row.createdAt,
    isDefault: row.isDefault ? 'yes' : 'no',
  }));

  const limitText = vm.limit > 0 ? `  ·  Limit ${vm.limit}` : '';
  const footer = `${vm.total} workspaces${limitText}`;

  return (
    <Section title="Workspaces" footer={footer}>
      <Table columns={COLUMNS} data={data} paddingLeft={0} />
    </Section>
  );
}

export async function renderWorkspaceListInk(vm: WorkspaceListViewModel): Promise<void> {
  await renderWithInk(<WorkspaceListInk vm={vm} />);
}
