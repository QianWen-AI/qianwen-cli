import type {
  TokenPlanStatusResult,
  TokenPlanStatusViewModel,
  TokenPlanStatusViewModelHeader,
  TokenPlanStatusSeatLine,
  TokenPlanStatusTable,
  TokenPlanStatusFooter,
} from '../../types/tokenplan-subscription.js';
import { NA, PARTIAL_FAILURE_NOTE_TEMPLATE } from './shared.js';

/** Build view model for the tokenplan status command. */
export function buildTokenPlanStatusViewModel(
  result: TokenPlanStatusResult,
  format: 'tui' | 'text' | 'json',
): TokenPlanStatusViewModel {
  const { diagnostics } = result;
  const footnote =
    diagnostics.length > 0 ? PARTIAL_FAILURE_NOTE_TEMPLATE(diagnostics.length) : null;

  const warnings =
    diagnostics.length > 0 ? diagnostics.map((d) => `⚠ ${d.api}: ${d.errorMessage}`) : undefined;

  const header = format !== 'json' ? buildHeader(result) : undefined;
  const seatLines = buildSeatLines(result);
  const totalLine = buildTotalLine(result);
  const table = buildTable(result);
  const footer = format !== 'json' ? buildFooter(result, diagnostics) : undefined;

  return {
    format,
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
    period = `${formatDate(result.period.start)} → ${formatDate(result.period.end)} (${result.period.remainingDays} days remaining)`;
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

  let renewable: string;
  if (result.renewable) {
    renewable = result.renewable.canRenew
      ? 'Yes'
      : result.renewable.interceptCode
        ? `No (${result.renewable.interceptCode})`
        : 'No';
  } else {
    renewable = NA;
  }

  return { product, period, autoRenew, renewable };
}

function buildSeatLines(result: TokenPlanStatusResult): TokenPlanStatusSeatLine[] | undefined {
  if (!result.seatSummary) return undefined;
  return result.seatSummary.groups.map((g) => ({
    specType: capitalizeFirst(g.specType),
    seats: String(g.seats),
    totalValue: formatAmount(g.totalValue),
    surplusValue: formatAmount(g.surplusValue),
    nextCycleFlushTime: g.nextCycleFlushTime ? formatDate(g.nextCycleFlushTime) : NA,
  }));
}

function buildTotalLine(result: TokenPlanStatusResult): TokenPlanStatusSeatLine | undefined {
  const total = result.seatSummary?.total;
  if (!total) return undefined;
  return {
    specType: 'Total',
    seats: String(total.seats),
    totalValue: formatAmount(total.totalValue),
    surplusValue: formatAmount(total.surplusValue),
    nextCycleFlushTime: '',
  };
}

function buildTable(result: TokenPlanStatusResult): TokenPlanStatusTable | null {
  if (!result.seatSummary) return null;
  const rows = result.seatSummary.groups.map((g) => ({
    specType: capitalizeFirst(g.specType),
    seats: String(g.seats),
    totalValue: formatAmount(g.totalValue),
    surplusValue: formatAmount(g.surplusValue),
    nextCycleFlushTime: g.nextCycleFlushTime ? formatDate(g.nextCycleFlushTime) : NA,
  }));
  const total = result.seatSummary.total;
  const totalRow = total
    ? {
        specType: 'Total',
        seats: String(total.seats),
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
        seats: String(total.seats),
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

function formatDate(iso: string): string {
  if (!iso) return NA;
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : iso;
}

function formatAmount(value: string): string {
  if (!value || value === '0') return '0';
  const parts = value.split('.');
  const intPart = parts[0]!;
  const decPart = parts[1];
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${formatted}.${decPart}` : formatted;
}

function formatRenewalPeriod(period: number, unit: string): string {
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
