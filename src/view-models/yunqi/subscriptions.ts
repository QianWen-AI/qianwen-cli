import type {
  ForumSubscription,
  ForumSubscriptionCounts,
  ForumSubscriptionListResult,
} from '../../types/yunqi.js';
import { truncateCell } from './shared.js';

const UNREAD_MARKER = '●';
const READ_MARKER = '-';

const WIDTHS = {
  forumId: 16,
  forumName: 40,
  // ListMyForumSubscriptions returns `2026-09-08T05:30:00Z`, four characters
  // longer than the ListForums format, so a narrower budget cut mid-minute.
  startTime: 20,
  endTime: 20,
  statusText: 14,
} as const;

export interface ForumSubscriptionRowViewModel {
  forumId: string;
  forumName: string;
  startTime: string;
  endTime: string;
  statusText: string;
  unread: string;
}

export interface ForumSubscriptionListViewModel {
  rows: ForumSubscriptionRowViewModel[];
  total: number;
  countsSummary: string;
}

export function buildForumSubscriptionListViewModel(
  result: ForumSubscriptionListResult,
): ForumSubscriptionListViewModel {
  return {
    rows: result.subscriptions.map(toRow),
    total: result.subscriptions.length,
    countsSummary: buildCountsSummary(result),
  };
}

function toRow(item: ForumSubscription): ForumSubscriptionRowViewModel {
  return {
    forumId: truncateCell(item.forumId, WIDTHS.forumId),
    forumName: truncateCell(item.forumName, WIDTHS.forumName),
    startTime: truncateCell(item.forumStartTime, WIDTHS.startTime),
    endTime: truncateCell(item.forumEndTime, WIDTHS.endTime),
    statusText: truncateCell(item.statusText, WIDTHS.statusText),
    unread: item.viewed ? READ_MARKER : UNREAD_MARKER,
  };
}

function buildCountsSummary(counts: ForumSubscriptionCounts): string {
  return [
    `Not started ${counts.notStartedCount}`,
    `In progress ${counts.inProgressCount}`,
    `Summary preparing ${counts.summaryPreparingCount}`,
    `Summary ready ${counts.summaryReadyCount}`,
    `Unviewed ${counts.unviewedCount}`,
  ].join(' · ');
}
