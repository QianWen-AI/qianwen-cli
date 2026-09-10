import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import type { ExhibitorListViewModel } from '../view-models/yunqi/index.js';

const COLUMNS = [
  { key: 'id', header: 'ID' },
  { key: 'code', header: 'Code' },
  { key: 'name', header: 'Name' },
  { key: 'hall', header: 'Hall' },
  { key: 'zone', header: 'Zone' },
  { key: 'booth', header: 'Booth' },
  { key: 'description', header: 'Description' },
];

export interface YunqiExhibitorListInkProps {
  vm: ExhibitorListViewModel;
}

export function YunqiExhibitorListInk({ vm }: YunqiExhibitorListInkProps) {
  const data = vm.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    hall: row.hall,
    zone: row.zone,
    booth: row.booth,
    description: row.description,
  }));

  const totalPages = vm.pageSize > 0 ? Math.max(1, Math.ceil(vm.total / vm.pageSize)) : 1;
  const footer = `${vm.total} exhibitors · Page ${vm.page} of ${totalPages}`;

  return (
    <Section title="Exhibitors" footer={footer}>
      <Table columns={COLUMNS} data={data} paddingLeft={0} />
    </Section>
  );
}

export async function renderYunqiExhibitorListInk(vm: ExhibitorListViewModel): Promise<void> {
  await renderWithInk(<YunqiExhibitorListInk vm={vm} />);
}
