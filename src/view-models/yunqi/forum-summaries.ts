import type { ForumSummary } from '../../types/yunqi.js';
import { truncateCell } from './shared.js';

const WIDTHS = {
  forumId: 16,
  // The summary body is the payload of this command, so it gets a far larger
  // budget than a label column; --format json still returns it in full.
  summary: 80,
} as const;

export interface ForumSummaryRowViewModel {
  forumId: string;
  summary: string;
}

export interface ForumSummaryListViewModel {
  rows: ForumSummaryRowViewModel[];
  total: number;
}

export function buildForumSummaryListViewModel(
  summaries: ForumSummary[],
): ForumSummaryListViewModel {
  return {
    rows: summaries.map(toRow),
    total: summaries.length,
  };
}

function toRow(item: ForumSummary): ForumSummaryRowViewModel {
  return {
    forumId: truncateCell(item.forumId, WIDTHS.forumId),
    summary: truncateCell(item.summary, WIDTHS.summary),
  };
}
