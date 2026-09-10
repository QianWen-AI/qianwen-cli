import type {
  ExhibitorListViewModel,
  ExhibitorRowViewModel,
  ForumListViewModel,
  ForumSubscribeViewModel,
  ForumSubscriptionListViewModel,
  ForumSummaryListViewModel,
} from '../../view-models/yunqi/index.js';
import type {
  ForumRowViewModel,
  ForumSubscriptionRowViewModel,
  ForumSummaryRowViewModel,
} from '../../view-models/yunqi/index.js';
import { formatTextTable } from '../format.js';

const LIST_HEADERS = [
  'ID',
  'Name',
  'Theme',
  'Start',
  'End',
  'Location',
  'Industry',
  'Interest',
  'Live Address',
  'Topics',
  'Subscribable',
  'Description',
];

export function renderTextForumList(vm: ForumListViewModel): void {
  const rows = vm.rows.map((row: ForumRowViewModel) => [
    row.id,
    row.name,
    row.theme,
    row.startTime,
    row.endTime,
    row.location,
    row.industry,
    row.interest,
    row.liveAddress,
    row.topics,
    row.subscribable,
    row.description,
  ]);
  console.log(formatTextTable(LIST_HEADERS, rows));
  const totalPages = vm.pageSize > 0 ? Math.max(1, Math.ceil(vm.total / vm.pageSize)) : 1;
  console.log(`  ${vm.total} forums · Page ${vm.page}/${totalPages}`);
}

export function renderTextForumSubscribe(vm: ForumSubscribeViewModel): void {
  console.log(vm.message);
}

const SUBSCRIPTION_HEADERS = ['Forum ID', 'Name', 'Start', 'End', 'Status', 'Unread'];

export function renderTextSubscriptionList(vm: ForumSubscriptionListViewModel): void {
  const rows = vm.rows.map((row: ForumSubscriptionRowViewModel) => [
    row.forumId,
    row.forumName,
    row.startTime,
    row.endTime,
    row.statusText,
    row.unread,
  ]);
  console.log(formatTextTable(SUBSCRIPTION_HEADERS, rows));
  console.log(`  ${vm.total} subscriptions · ${vm.countsSummary}`);
}

const EXHIBITOR_HEADERS = ['ID', 'Code', 'Name', 'Hall', 'Zone', 'Booth', 'Description'];

export function renderTextExhibitorList(vm: ExhibitorListViewModel): void {
  const rows = vm.rows.map((row: ExhibitorRowViewModel) => [
    row.id,
    row.code,
    row.name,
    row.hall,
    row.zone,
    row.booth,
    row.description,
  ]);
  console.log(formatTextTable(EXHIBITOR_HEADERS, rows));
  const totalPages = vm.pageSize > 0 ? Math.max(1, Math.ceil(vm.total / vm.pageSize)) : 1;
  console.log(`  ${vm.total} exhibitors · Page ${vm.page}/${totalPages}`);
}

const SUMMARY_HEADERS = ['Forum ID', 'Summary'];

export function renderTextForumSummaryList(vm: ForumSummaryListViewModel): void {
  const rows = vm.rows.map((row: ForumSummaryRowViewModel) => [row.forumId, row.summary]);
  console.log(formatTextTable(SUMMARY_HEADERS, rows));
  console.log(`  ${vm.total} summaries`);
}
