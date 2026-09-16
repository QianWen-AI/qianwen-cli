import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import type {
  ForumSubscriptionListViewModel,
  ForumSubscriptionRowViewModel,
} from '../view-models/yunqi/index.js';

const COLUMNS = [
  { key: 'forumId', header: 'Forum ID' },
  { key: 'forumName', header: 'Name' },
  { key: 'startTime', header: 'Start' },
  { key: 'endTime', header: 'End' },
  { key: 'statusText', header: 'Status' },
  { key: 'unread', header: 'Unread' },
];

export interface YunqiSubscriptionListInkProps {
  vm: ForumSubscriptionListViewModel;
}

export function YunqiSubscriptionListInk({ vm }: YunqiSubscriptionListInkProps) {
  const data = vm.rows.map((row: ForumSubscriptionRowViewModel) => ({
    forumId: row.forumId,
    forumName: row.forumName,
    startTime: row.startTime,
    endTime: row.endTime,
    statusText: row.statusText,
    unread: row.unread,
  }));

  const footer = `${vm.total} subscriptions · ${vm.countsSummary}`;

  return (
    <Section title="Subscriptions" footer={footer}>
      <Table columns={COLUMNS} data={data} paddingLeft={0} />
    </Section>
  );
}

export async function renderYunqiSubscriptionListInk(
  vm: ForumSubscriptionListViewModel,
): Promise<void> {
  await renderWithInk(<YunqiSubscriptionListInk vm={vm} />);
}
