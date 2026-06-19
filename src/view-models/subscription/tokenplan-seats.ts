import type {
  SeatStatusColor,
  TokenPlanSeatItem,
  TokenPlanSeatsFooter,
  TokenPlanSeatsHeader,
  TokenPlanSeatsResult,
  TokenPlanSeatsRow,
  TokenPlanSeatsViewModel,
} from '../../types/tokenplan-subscription.js';
import { NA, PARTIAL_FAILURE_NOTE_TEMPLATE } from './shared.js';

const SEAT_STATUS_GROUP: Record<string, string> = {
  CREATING: 'active',
  NORMAL: 'active',
  LIMIT: 'active',
  RELEASE: 'expired',
  STOP: 'expired',
  REFUNDED: 'refunded',
};

const SEAT_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  expired: 'Expired',
  refunded: 'Refunded',
};

const SEAT_STATUS_COLOR: Record<string, SeatStatusColor> = {
  active: 'green',
  expired: 'gray',
  refunded: 'orange',
};

/** Build view model for the tokenplan seats command. */
export function buildTokenPlanSeatsViewModel(
  result: TokenPlanSeatsResult,
  format: 'tui' | 'text' | 'json',
): TokenPlanSeatsViewModel {
  const { diagnostics } = result;
  const footnote =
    diagnostics.length > 0 ? PARTIAL_FAILURE_NOTE_TEMPLATE(diagnostics.length) : null;

  const warnings =
    diagnostics.length > 0 ? diagnostics.map((d) => `⚠ ${d.api}: ${d.errorMessage}`) : undefined;

  // Filter: only show seats with normal status
  const normalItems = result.items.filter((it) => it.status.toLowerCase() === 'normal');

  const items: TokenPlanSeatItem[] =
    format === 'json' ? normalItems : normalItems.map((it) => ({ ...it }));

  let header: TokenPlanSeatsHeader | undefined;
  let rows: TokenPlanSeatsRow[] | undefined;
  let footer: TokenPlanSeatsFooter | undefined;
  let emptyPlaceholder: string | undefined;

  if (format !== 'json') {
    header = buildHeader(result);
    rows = buildRows(normalItems);
    footer = buildFooter(result, warnings ?? []);
    if (rows.length === 0) {
      emptyPlaceholder = 'No seats found.';
    }
  }

  return {
    format,
    page: result.page,
    filter: result.filter,
    items,
    header,
    rows,
    footer,
    emptyPlaceholder,
    warnings,
    diagnostics,
    footnote,
  };
}

function buildHeader(result: TokenPlanSeatsResult): TokenPlanSeatsHeader {
  const filterLabel = result.filter.specType ?? 'all';
  return {
    total: String(result.page.total),
    filter: filterLabel,
  };
}

function buildRows(items: TokenPlanSeatItem[]): TokenPlanSeatsRow[] {
  return items.map((it) => {
    const group = SEAT_STATUS_GROUP[(it.status ?? '').toUpperCase()] ?? 'expired';
    return {
      instanceCode: it.instanceCode || NA,
      specType: it.specType ? capitalizeFirst(it.specType) : NA,
      status: SEAT_STATUS_LABEL[group] ?? it.status ?? NA,
      statusColor: SEAT_STATUS_COLOR[group] ?? 'gray',
      memberIdMasked: maskMemberId(it.memberId),
      totalValue: it.cycle ? formatAmount(it.cycle.totalValue) : NA,
      surplusValue: it.cycle ? formatAmount(it.cycle.surplusValue) : NA,
      assignment: it.assignment,
    };
  });
}

function buildFooter(result: TokenPlanSeatsResult, warnings: string[]): TokenPlanSeatsFooter {
  const totalPages = computeTotalPages(result.page.total, result.page.size);
  return {
    pagination: `Page ${result.page.current}/${totalPages}`,
    total: `Total: ${result.page.total}`,
    warnings,
  };
}

function computeTotalPages(total: number, size: number): number {
  if (size <= 0) return 1;
  if (total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

// ────────────────────────────────────────────────────────────────────
// Formatting helpers
// ────────────────────────────────────────────────────────────────────

/** Mask a memberId to first 8 + last 4 chars. Short values are returned verbatim. */
export function maskMemberId(value: string): string {
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatAmount(value: string): string {
  if (!value) return '0';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0') return '0';
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const parts = body.split('.');
  const intPart = parts[0] ?? '0';
  const decPart = parts[1];
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const head = decPart ? `${formatted}.${decPart}` : formatted;
  return negative ? `-${head}` : head;
}

function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
