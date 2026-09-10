import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import type {
  ForumSummaryListViewModel,
  ForumSummaryRowViewModel,
} from '../view-models/yunqi/index.js';

const COLUMNS = [
  { key: 'forumId', header: 'Forum ID' },
  { key: 'summary', header: 'Summary' },
];

export interface YunqiForumSummaryListInkProps {
  vm: ForumSummaryListViewModel;
}

export function YunqiForumSummaryListInk({ vm }: YunqiForumSummaryListInkProps) {
  const data = vm.rows.map((row: ForumSummaryRowViewModel) => ({
    forumId: row.forumId,
    summary: row.summary,
  }));

  const footer = `${vm.total} summaries`;

  return (
    <Section title="Forum Summaries" footer={footer}>
      <Table columns={COLUMNS} data={data} paddingLeft={0} />
    </Section>
  );
}

export async function renderYunqiForumSummaryListInk(vm: ForumSummaryListViewModel): Promise<void> {
  await renderWithInk(<YunqiForumSummaryListInk vm={vm} />);
}
