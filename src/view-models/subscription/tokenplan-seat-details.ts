import { stripVTControlCharacters } from 'node:util';
import type {
  TokenPlanSeatDetails,
  TokenPlanSeatDetailsViewModel,
  TokenPlanSeatSummary,
} from '../../types/tokenplan-subscription.js';

function count(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Current allocation is established by the summary, never by historical detail rows. */
export function formatTeamSeatAllocation(summary: TokenPlanSeatSummary | null): string {
  const total = count(summary?.total?.seats);
  const groups = summary?.groups ?? [];
  const specs = new Set(groups.map((g) => g.specType.toLowerCase()));
  const valid =
    total !== null &&
    specs.size === groups.length &&
    [...specs].every((spec) => ['standard', 'pro', 'max'].includes(spec)) &&
    groups.every(
      (g) => count(g.seats) !== null && count(g.assigned) !== null && g.assigned! <= g.seats!,
    ) &&
    groups.reduce((sum, g) => sum + g.seats!, 0) === total;
  const assigned = valid ? groups.reduce((sum, g) => sum + g.assigned!, 0) : null;
  return `${total ?? 'unknown'} total · ${assigned ?? 'unknown'} assigned · ${assigned === null ? 'unknown' : total! - assigned} unassigned`;
}

function safe(value: string): string {
  // Keep remote IDs on one line; JSON retains their original, escaped representation.
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
}

function amount(value: string | null): string {
  if (value === null) return 'unknown';
  const [integer = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (trimmed ? `.${trimmed}` : '');
}

const STATUS: Record<string, string> = {
  CREATING: 'Active',
  NORMAL: 'Active',
  LIMIT: 'Active',
  RELEASE: 'Expired',
  STOP: 'Expired',
  REFUNDED: 'Refunded',
};
const TYPES: Record<string, string> = { standard: 'Standard', pro: 'Pro', max: 'Max' };

export function formatTokenPlanSeatName(specType: string | null): string {
  const name = TYPES[specType?.toLowerCase() ?? ''];
  return name ? `${name} Seat` : 'unknown';
}

export function buildTokenPlanSeatDetailsViewModel(
  details: TokenPlanSeatDetails | undefined,
  variant: 'subscription' | 'tokenplan' = 'subscription',
): TokenPlanSeatDetailsViewModel | undefined {
  if (!details) return undefined;
  const dedicated = variant === 'tokenplan';
  const hasUnknownStatus = details.items.some((seat) => seat.status === null);
  const hasUnknownFields = details.items.some(
    (seat) =>
      seat.specType === null ||
      seat.status === null ||
      seat.assignment === 'unknown' ||
      seat.totalValue === null ||
      seat.surplusValue === null,
  );
  const label = hasUnknownStatus ? 'seat record' : 'current seat';
  const count = `${details.items.length} ${label}${details.items.length === 1 ? '' : 's'}`;
  const notes: string[] = [];
  const summaryMismatch = details.diagnostics.find((d) => d.errorCode === 'SeatSummaryMismatch');
  if (summaryMismatch) {
    notes.push(summaryMismatch.errorMessage);
    if (details.items.length) notes.push(`Showing ${count}. Credits: remaining / total.`);
  } else if (details.collectionCompleteness !== 'complete') {
    const state = details.collectionCompleteness === 'partial' ? 'incomplete' : 'unavailable';
    notes.push(
      `Seat query ${state}: ${details.fetchedCount} / ${details.totalCount ?? 'unknown'} records retrieved.`,
    );
    if (details.items.length) notes.push(`Showing ${count}. Credits: remaining / total.`);
  } else if (!dedicated || details.items.length === 0) {
    notes.push(
      details.items.length ? `${count}. Credits: remaining / total.` : 'No current seats.',
    );
  }
  if (hasUnknownFields) notes.push('Some seat fields are unknown.');
  if (details.historicalCount > 0) {
    notes.push(
      `${details.historicalCount} historical seats hidden. View: qianwen subscription tokenplan seats`,
    );
  }
  return {
    title: dedicated ? 'SEAT DETAILS' : 'Seat Details',
    headers: [
      'SEAT ID',
      dedicated ? 'SEAT TYPE' : 'TYPE',
      'STATUS',
      'ASSIGNMENT',
      dedicated ? 'CREDITS (REMAINING / TOTAL)' : 'CREDITS',
    ],
    note: notes.join('\n'),
    noteAfterRows: dedicated,
    rows: details.items.map((seat) => [
      safe(seat.instanceCode),
      dedicated
        ? formatTokenPlanSeatName(seat.specType)
        : (TYPES[seat.specType ?? ''] ?? 'unknown'),
      dedicated
        ? (STATUS[seat.status ?? ''] ?? 'unknown').toLowerCase()
        : (STATUS[seat.status ?? ''] ?? 'unknown'),
      dedicated
        ? seat.assignment
        : seat.assignment === 'assigned'
          ? 'Assigned'
          : seat.assignment === 'unassigned'
            ? 'Unassigned'
            : 'unknown',
      `${amount(seat.surplusValue)} / ${amount(seat.totalValue)}`,
    ]),
  };
}
