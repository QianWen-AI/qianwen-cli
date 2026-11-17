import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import { formatCmd } from '../utils/runtime-mode.js';
import type { PluginListViewModel } from '../view-models/plugin/index.js';

const COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'version', header: 'Version' },
  { key: 'command', header: 'Command' },
  { key: 'source', header: 'Source' },
  { key: 'status', header: 'Status' },
];

function toRows(vm: PluginListViewModel): Record<string, string>[] {
  return vm.rows.map((row) => ({
    name: row.name,
    version: row.version,
    command: row.command,
    source: row.source,
    status: row.status,
  }));
}

export interface PluginListTableProps {
  vm: PluginListViewModel;
}

export function PluginListTable({ vm }: PluginListTableProps) {
  const footer = `${vm.totalCount} plugins  \u00b7  install with: ${formatCmd('plugin install <pkg|path>')}`;
  return (
    <Section title="Installed Plugins" footer={footer}>
      <Table columns={COLUMNS} data={toRows(vm)} paddingLeft={0} truncate />
    </Section>
  );
}

// Plugin counts are small and there is nothing to paginate/scroll, so a
// one-shot static render suffices (no InteractiveTable alt-screen session).
export async function renderPluginListInk(vm: PluginListViewModel): Promise<void> {
  await renderWithInk(<PluginListTable vm={vm} />);
}
