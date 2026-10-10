import type {
  TokenPlanStatusResult,
  TokenPlanStatusViewModel,
  TokenPlanStatusViewModelHeader,
  TokenPlanStatusSeatLine,
  TokenPlanStatusTable,
  TokenPlanStatusFooter,
} from '../../types/tokenplan-subscription.js';
import {
  NA,
  PARTIAL_FAILURE_NOTE_TEMPLATE,
  buildSubscriptionEditionSections,
  formatDiagnosticMessage,
} from './shared.js';
import { formatAsiaShanghaiDate } from './tokenplan-editions.js';
import {
  buildTokenPlanSeatDetailsViewModel,
  formatTokenPlanSeatName,
} from './tokenplan-seat-details.js';

/** Build view model for the tokenplan status command. */
export function buildTokenPlanStatusViewModel(
  result: TokenPlanStatusResult,
  format: 'tui' | 'text' | 'json',
): TokenPlanStatusViewModel {
  const { diagnostics } = result;
  const footnote =
    diagnostics.length > 0 ? PARTIAL_FAILURE_NOTE_TEMPLATE(diagnostics.length) : null;

  const seatDetails = buildTokenPlanSeatDetailsViewModel(result.team?.seatDetails, 'tokenplan');
  // Seat-summary conflicts are already explained next to the detail rows.
  const pageDiagnostics = diagnostics.filter(
    (diagnostic) =>
      !(
        diagnostic.errorCode === 'SeatSummaryMismatch' &&
        result.team?.seatDetails?.diagnostics.some((d) => d.errorCode === 'SeatSummaryMismatch')
      ),
  );
  const warnings =
    pageDiagnostics.length > 0
      ? pageDiagnostics.map((diagnostic) => `⚠ ${formatDiagnosticMessage(diagnostic)}`)
      : undefined;

  const editionSections = buildSubscriptionEditionSections(
    result,
    result.renewable ? formatRenewable(result.renewable) : null,
  );
  const header =
    format !== 'json' && editionSections.length === 0 ? buildHeader(result) : undefined;
  const seatLines = buildSeatLines(result);
  const totalLine = buildTotalLine(result);
  const table = buildTable(result);
  const footer = format !== 'json' ? buildFooter(result, diagnostics) : undefined;

  return {
    format,
    individual: result.individual,
    team: result.team,
    editionSections,
    // JSON-mode fields
    product: result.product,
    period: result.period,
    autoRenew: result.autoRenew,
    renewable: result.renewable,
    seatSummary: result.seatSummary,
    // TUI/TEXT-mode fields
    header,
    table,
    footer,
    seatLines,
    totalLine,
    seatDetails,
    // Shared
    warnings,
    diagnostics,
    footnote,
  };
}

function buildHeader(result: TokenPlanStatusResult): TokenPlanStatusViewModelHeader {
  const product = result.product;

  let period: string;
  if (result.period) {
    period = `${formatAsiaShanghaiDate(result.period.start)} → ${formatAsiaShanghaiDate(result.period.end)} (${result.period.remainingDays ?? 'unknown'} days remaining)`;
  } else {
    period = NA;
  }

  let autoRenew: string;
  if (result.autoRenew) {
    autoRenew = result.autoRenew.enabled
      ? `ON (${formatRenewalPeriod(result.autoRenew.period, result.autoRenew.periodUnit)})`
      : 'OFF';
  } else {
    autoRenew = NA;
  }

  return { product, period, autoRenew, renewable: formatRenewable(result.renewable) };
}

function formatRenewable(renewable: TokenPlanStatusResult['renewable']): string {
  if (!renewable) return NA;
  return renewable.canRenew
    ? 'Yes'
    : renewable.interceptCode
      ? `No (${renewable.interceptCode})`
      : 'No';
}

function buildSeatLines(result: TokenPlanStatusResult): TokenPlanStatusSeatLine[] | undefined {
  if (!result.seatSummary) return undefined;
  return result.seatSummary.groups.map((g) => ({
    specType: formatTokenPlanSeatName(g.specType),
    seats: g.seats === null ? 'unknown' : String(g.seats),
    totalValue: formatAmount(g.totalValue),
    surplusValue: formatAmount(g.surplusValue),
    nextCycleFlushTime: g.nextCycleFlushTime ? formatAsiaShanghaiDate(g.nextCycleFlushTime) : NA,
  }));
}

function buildTotalLine(result: TokenPlanStatusResult): TokenPlanStatusSeatLine | undefined {
  const total = result.seatSummary?.total;
  if (!total) return undefined;
  return {
    specType: 'Total',
    seats: total.seats === null ? 'unknown' : String(total.seats),
    totalValue: formatAmount(total.totalValue),
    surplusValue: formatAmount(total.surplusValue),
    nextCycleFlushTime: '',
  };
}

function buildTable(result: TokenPlanStatusResult): TokenPlanStatusTable | null {
  if (!result.seatSummary) return null;
  const rows = result.seatSummary.groups.map((g) => ({
    specType: capitalizeFirst(g.specType),
    seats: g.seats === null ? 'unknown' : String(g.seats),
    totalValue: formatAmount(g.totalValue),
    surplusValue: formatAmount(g.surplusValue),
    nextCycleFlushTime: g.nextCycleFlushTime ? formatAsiaShanghaiDate(g.nextCycleFlushTime) : NA,
  }));
  const total = result.seatSummary.total;
  const totalRow = total
    ? {
        specType: 'Total',
        seats: total.seats === null ? 'unknown' : String(total.seats),
        totalValue: formatAmount(total.totalValue),
        surplusValue: formatAmount(total.surplusValue),
        nextCycleFlushTime: '',
      }
    : null;
  return { rows, totalRow };
}

function buildFooter(
  result: TokenPlanStatusResult,
  diagnostics: import('../../types/subscription.js').SubscriptionDiagnostic[],
): TokenPlanStatusFooter {
  const total = result.seatSummary?.total;
  const totalLine = total
    ? {
        specType: 'Total',
        seats: total.seats === null ? 'unknown' : String(total.seats),
        totalValue: formatAmount(total.totalValue),
        surplusValue: formatAmount(total.surplusValue),
        nextCycleFlushTime: '',
      }
    : null;
  return { total: totalLine, diagnostics };
}

// ────────────────────────────────────────────────────────────────────
// Formatting helpers
// ────────────────────────────────────────────────────────────────────

function formatAmount(value: string | null): string {
  if (value === null) return 'unknown';
  if (!value || value === '0') return '0';
  const parts = value.split('.');
  const intPart = parts[0]!;
  let decPart = parts[1];
  // Strip trailing zeros from decimals; omit fraction if all zeros
  if (decPart) {
    decPart = decPart.replace(/0+$/, '');
  }
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${formatted}.${decPart}` : formatted;
}

function formatRenewalPeriod(period: number | null, unit: string | null): string {
  if (period === null || unit === null) return 'unknown';
  if (unit === 'M' || unit === 'Month') {
    return period === 1 ? 'Monthly' : `${period} Months`;
  }
  if (unit === 'Y' || unit === 'Year') {
    return period === 1 ? 'Yearly' : `${period} Years`;
  }
  return `${period} ${unit}`;
}

function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
