import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import type { ForumListViewModel } from '../view-models/yunqi/index.js';

const COLUMNS = [
  { key: 'id', header: 'ID' },
  { key: 'name', header: 'Name' },
  { key: 'theme', header: 'Theme' },
  { key: 'startTime', header: 'Start' },
  { key: 'endTime', header: 'End' },
  { key: 'location', header: 'Location' },
  { key: 'industry', header: 'Industry' },
  { key: 'interest', header: 'Interest' },
  { key: 'liveAddress', header: 'Live Address' },
  { key: 'topics', header: 'Topics' },
  { key: 'subscribable', header: 'Subscribable' },
  { key: 'description', header: 'Description' },
];

export interface YunqiForumListInkProps {
  vm: ForumListViewModel;
}

export function YunqiForumListInk({ vm }: YunqiForumListInkProps) {
  const data = vm.rows.map((row) => ({
    id: row.id,
    name: row.name,
    theme: row.theme,
    startTime: row.startTime,
    endTime: row.endTime,
    location: row.location,
    industry: row.industry,
    interest: row.interest,
    liveAddress: row.liveAddress,
    topics: row.topics,
    subscribable: row.subscribable,
    description: row.description,
  }));

  const totalPages = vm.pageSize > 0 ? Math.max(1, Math.ceil(vm.total / vm.pageSize)) : 1;
  const footer = `${vm.total} forums · Page ${vm.page} of ${totalPages}`;

  return (
    <Section title="Forums" footer={footer}>
      <Table columns={COLUMNS} data={data} paddingLeft={0} />
    </Section>
  );
}

export async function renderYunqiForumListInk(vm: ForumListViewModel): Promise<void> {
  await renderWithInk(<YunqiForumListInk vm={vm} />);
}
