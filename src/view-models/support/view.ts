import type { SupportTicketDetail, SupportMessage } from '../../types/support.js';
import { formatTicketTime, formatStatus, maskEmail } from './shared.js';

export interface SupportMessageViewModel {
  role: string;
  displayRole: string;
  nickName: string;
  content: string;
  createdAt: string;
}

export interface SupportTicketViewModel {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  category: string;
  description: string;
}

export interface SupportViewViewModel {
  available: boolean;
  ticket: SupportTicketViewModel;
  messages: SupportMessageViewModel[];
  messageCount: number;
  truncated: boolean;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

function mapDisplayRole(rawRole: string): string {
  const lower = rawRole.toLowerCase();
  if (lower === 'customer' || lower === 'user') return 'You';
  if (lower === 'system' || lower === 'robot') return 'System';
  return 'Support Engineer';
}

export function buildSupportViewViewModel(
  detail: SupportTicketDetail,
  messages: SupportMessage[],
  truncated: boolean = false,
): SupportViewViewModel {
  const strippedDescription = stripHtmlTags(detail.description || '');

  const sortedMessages = [...(messages || [])].sort((a, b) => a.createdAt - b.createdAt);
  const messageVms: SupportMessageViewModel[] = sortedMessages.map((m) => ({
    role: m.role,
    displayRole: mapDisplayRole(m.role),
    nickName: maskEmail(m.nickName),
    content: stripHtmlTags(m.content),
    createdAt: formatTicketTime(m.createdAt),
  }));

  const ticket: SupportTicketViewModel = {
    id: detail.id,
    title: detail.title || '\u2014',
    status: formatStatus(detail.status),
    createdAt: formatTicketTime(detail.createdAt),
    category: detail.category || '\u2014',
    description: strippedDescription || '\u2014',
  };

  return {
    available: true,
    ticket,
    messages: messageVms,
    messageCount: messageVms.length,
    truncated,
  };
}
