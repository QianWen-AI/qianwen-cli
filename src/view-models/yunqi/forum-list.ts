import type { Forum, ForumListResult } from '../../types/yunqi.js';
import { truncateCell } from './shared.js';

export interface ForumRowViewModel {
  id: string;
  name: string;
  theme: string;
  description: string;
  startTime: string;
  endTime: string;
  location: string;
  industry: string;
  interest: string;
  liveAddress: string;
  topics: string;
  subscribable: string;
}

export interface ForumListViewModel {
  rows: ForumRowViewModel[];
  page: number;
  pageSize: number;
  total: number;
}

const WIDTHS = {
  id: 12,
  name: 36,
  theme: 18,
  startTime: 20,
  endTime: 20,
  location: 18,
  industry: 20,
  interest: 20,
  liveAddress: 24,
  topics: 6,
  subscribable: 12,
  description: 32,
} as const;

export function buildForumListViewModel(result: ForumListResult): ForumListViewModel {
  return {
    rows: result.forums.map(toRow),
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  };
}

function toRow(item: Forum): ForumRowViewModel {
  const topicCount = item.topicList === undefined ? undefined : String(item.topicList.length);
  return {
    id: truncateCell(item.id, WIDTHS.id),
    name: truncateCell(item.name, WIDTHS.name),
    theme: truncateCell(item.theme, WIDTHS.theme),
    description: truncateCell(item.description, WIDTHS.description),
    startTime: truncateCell(item.startTime, WIDTHS.startTime),
    endTime: truncateCell(item.endTime, WIDTHS.endTime),
    location: truncateCell(item.location, WIDTHS.location),
    industry: truncateCell((item.industryList ?? []).join(', '), WIDTHS.industry),
    interest: truncateCell((item.interestList ?? []).join(', '), WIDTHS.interest),
    liveAddress: truncateCell(item.liveAddress, WIDTHS.liveAddress),
    topics: truncateCell(topicCount, WIDTHS.topics),
    subscribable: item.subscribable ? 'yes' : 'no',
  };
}
