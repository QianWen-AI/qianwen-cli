import type { SupportTicket } from '../../types/support.js';
import { truncateTitle, formatTicketTime, formatStatus } from './shared.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export interface SupportListItemViewModel {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

export interface SupportListViewModel {
  available: boolean;
  isEmpty: boolean;
  rows: SupportListItemViewModel[];
  tickets: SupportListItemViewModel[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  emptyMessage: string;
}

export function buildSupportListViewModel(
  tickets: SupportTicket[],
  page: number,
  pageSize: number,
  total: number,
): SupportListViewModel {
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const isEmpty = tickets.length === 0;
  const emptyMessage = `No support tickets yet. Use '${formatCmd('support create')}' to file one.`;

  if (isEmpty) {
    return {
      available: true,
      isEmpty: true,
      rows: [],
      tickets: [],
      total,
      page,
      pageSize,
      totalPages: total === 0 ? 0 : totalPages,
      emptyMessage,
    };
  }

  const items: SupportListItemViewModel[] = tickets.map((t) => ({
    id: t.id,
    title: truncateTitle(t.title),
    status: formatStatus(t.status),
    createdAt: formatTicketTime(t.createdAt),
  }));

  return {
    available: true,
    isEmpty: false,
    rows: items,
    tickets: items,
    total,
    page,
    pageSize,
    totalPages,
    emptyMessage,
  };
}
