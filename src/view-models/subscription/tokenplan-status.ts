import type {
  TokenPlanStatusResult,
  TokenPlanStatusViewModel as BaseTokenPlanStatusViewModel,
  TokenPlanStatusViewModelHeader,
  TokenPlanStatusSeatLine,
  TokenPlanStatusTable,
  TokenPlanStatusFooter,
  TokenPlanEditionSection,
  TokenPlanSeatDetailsViewModel,
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
  sortTokenPlanSeats,
} from './tokenplan-seat-details.js';
import {
  buildTokenPlanStatusDetails,
  tokenPlanDisplayText,
  tokenPlanDisplayDate,
  type TokenPlanDisplayTable,
} from './tokenplan-details.js';
import { TOKEN_PLAN_PURCHASE_EXAMPLES } from '../../config/tokenplan-purchase-examples.js';

export interface TokenPlanStatusViewModel extends BaseTokenPlanStatusViewModel {
  detailTables?: TokenPlanDisplayTable[];
  editionSections: Array<
    TokenPlanEditionSection & {
      detailTables?: TokenPlanDisplayTable[];
      seatLines?: TokenPlanStatusSeatLine[];
      seatDetails?: TokenPlanSeatDetailsViewModel;
      purchaseHint?: string;
    }
  >;
}

/** Build view model for the tokenplan status command. */
export function buildTokenPlanStatusViewModel(
  result: TokenPlanStatusResult,
  format: 'tui' | 'text' | 'json',
  options: { includeName?: boolean } = {},
): TokenPlanStatusViewModel {
  const { diagnostics } = result;
  const footnote =
    diagnostics.length > 0 ? PARTIAL_FAILURE_NOTE_TEMPLATE(diagnostics.length) : null;

  const seatDetails = buildTokenPlanSeatDetailsViewModel(result.team?.seatDetails, 'tokenplan');
  const seatLines = buildSeatLines(result);
  const detailTables = buildTokenPlanStatusDetails(result).map((table) =>
    table.title === 'TEAM CREDIT SUMMARY' && table.rows.length > 0
      ? {
          ...table,
          note: [
            'The total credits is the sum of the credits of all seats of the same seat type.',
            'Only active seats are shown.',
            'Run qianwen subscription tokenplan seats for per-seat member and quota details.',
          ].join('\n'),
        }
      : table,
  );
  const warnings =
    diagnostics.length > 0
      ? diagnostics.map((diagnostic) => `⚠ ${formatDiagnosticMessage(diagnostic)}`)
      : undefined;

  const editionSections = buildSubscriptionEditionSections(
    result,
    result.renewable ? formatRenewable(result.renewable) : null,
  ).map((section) => {
    const edition = section.edition === 'individual' ? result.individual : result.team;
    if (!edition) return section;
    const visibleFields = section.fields.filter(
      (field) => options.includeName || field.label !== 'Name',
    );
    // Keep confirmed absence concise; purchase guidance is added per edition below.
    if (edition.status === 'not_subscribed') {
      return {
        ...section,
        fields: [
          ...visibleFields.map((field) => ({
            ...field,
            value: tokenPlanDisplayText(field.value),
          })),
          {
            label: 'Subscription',
            value: tokenPlanDisplayText(`No active ${section.title} Token Plan subscription.`),
          },
        ],
        detailTables: detailTables.filter((table) => table.edition === section.edition),
        ...(format === 'json'
          ? {}
          : {
              purchaseHint: [
                `To purchase ${edition.edition === 'individual' ? 'an Individual' : 'a Team'} Token Plan, run:`,
                `  ${TOKEN_PLAN_PURCHASE_EXAMPLES[edition.edition]}`,
              ].join('\n'),
            }),
      };
    }
    const fields = visibleFields.filter(
      (field) =>
        field.label !== 'Period' &&
        !(
          Object.hasOwn(edition, 'tiers') &&
          ['Monthly Credits', 'Weekly Credits'].includes(field.label)
        ),
    );
    const renewal = Object.hasOwn(edition, 'confirmedAutoRenew')
      ? edition.confirmedAutoRenew
      : edition.autoRenew;
    for (const field of fields)
      if (field.label === 'Auto-Renew')
        field.value = renewal ? (renewal.enabled ? 'On' : 'Off') : 'unknown';
    fields.splice(
      1,
      0,
      // Seat instance IDs do not identify the whole plan; omit an absent plan-level ID.
      ...(edition.subscriptionId
        ? [{ label: 'Subscription ID', value: tokenPlanDisplayText(edition.subscriptionId) }]
        : []),
      { label: 'Commodity', value: tokenPlanDisplayText(edition.commodityCode) },
      { label: 'Edition', value: edition.edition },
    );
    const end = edition.endAt ?? edition.period?.end;
    fields.push({ label: 'End At', value: tokenPlanDisplayDate(end) });
    fields.push({ label: 'Remaining Days', value: tokenPlanDisplayText(edition.remainingDays) });
    return {
      ...section,
      fields: fields.map((field) => ({ ...field, value: tokenPlanDisplayText(field.value) })),
      detailTables: detailTables.filter((table) => table.edition === section.edition),
    };
  });
  const header =
    format !== 'json' && editionSections.length === 0 ? buildHeader(result) : undefined;
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
    detailTables,
  };
}

function buildHeader(result: TokenPlanStatusResult): TokenPlanStatusViewModelHeader {
  const product = result.product;

  let period: string;
  if (result.period) {
    period = `${formatAsiaShanghaiDate(result.period.end)} (${result.period.remainingDays ?? 'unknown'} days remaining)`;
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

  return {
    product: tokenPlanDisplayText(product),
    period: tokenPlanDisplayText(period),
    autoRenew,
    renewable: tokenPlanDisplayText(formatRenewable(result.renewable)),
  };
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
  return sortTokenPlanSeats(result.seatSummary.groups, (g) => g.specType).map((g) => ({
    specType: tokenPlanDisplayText(formatTokenPlanSeatName(g.specType)),
    seats: g.seats === null ? 'unknown' : String(g.seats),
    totalValue: tokenPlanDisplayText(formatAmount(g.totalValue)),
    surplusValue: tokenPlanDisplayText(formatAmount(g.surplusValue)),
    nextCycleFlushTime: g.nextCycleFlushTime
      ? tokenPlanDisplayText(formatAsiaShanghaiDate(g.nextCycleFlushTime))
      : NA,
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
  const rows = sortTokenPlanSeats(result.seatSummary.groups, (g) => g.specType).map((g) => ({
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
