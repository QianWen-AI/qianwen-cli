import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { InteractiveTable } from './InteractiveTable.js';
import { renderWithInk, renderInteractive } from './render.js';
import type { SkillsSearchViewModel } from '../view-models/skills/index.js';

const COLUMNS = [
  { key: 'index', header: '#' },
  { key: 'slug', header: 'Slug' },
  { key: 'name', header: 'Name' },
  { key: 'publisher', header: 'Publisher' },
  { key: 'currentVersion', header: 'Version' },
  { key: 'verified', header: 'Verified' },
];

function toSearchRows(vm: SkillsSearchViewModel): Record<string, string>[] {
  return vm.rows.map((row) => ({
    index: String(row.index),
    slug: row.slug,
    name: row.name,
    publisher: row.publisher,
    currentVersion: row.currentVersion,
    verified: row.verified ? 'yes' : 'no',
  }));
}

export interface SkillsSearchTableProps {
  vm: SkillsSearchViewModel;
}

export function SkillsSearchTable({ vm }: SkillsSearchTableProps) {
  const footer = `${vm.totalCount} skills  \u00b7  install with: skills install <slug>`;

  return (
    <Section title={`Skills Search \u00b7 "${vm.query}"`} footer={footer}>
      <Table columns={COLUMNS} data={toSearchRows(vm)} paddingLeft={0} truncate />
    </Section>
  );
}

export async function renderSkillsSearchInk(vm: SkillsSearchViewModel): Promise<void> {
  // Empty result: nothing to scroll, so avoid stranding the user in an
  // alt-screen session and keep the one-shot static render.
  if (vm.rows.length === 0) {
    await renderWithInk(<SkillsSearchTable vm={vm} />);
    return;
  }

  // Persistent interactive mount: Ink redraws inside the alt-screen on
  // terminal resize instead of leaving re-wrapped scrollback text behind.
  // The full result set (--limit caps at 50) is passed as a single page
  // (perPage === row count ⇒ totalPages === 1), so pagination keys stay
  // inert and loadPage only ever replays the cached rows.
  const rows = toSearchRows(vm);
  await renderInteractive(
    <InteractiveTable
      columns={COLUMNS}
      totalItems={rows.length}
      perPage={rows.length}
      loadPage={() => Promise.resolve(rows)}
      initialRows={rows}
      title={`Skills Search \u00b7 "${vm.query}"`}
      subtitle={`${vm.totalCount} skills \u00b7 install with: skills install <slug>`}
    />,
  );
}
