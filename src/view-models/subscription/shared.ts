import { site } from '../../site.js';
import type { SubscriptionDiagnostic } from '../../types/subscription.js';
import type {
  TokenPlanEditionSection,
  TokenPlanEditionStatus,
} from '../../types/tokenplan-subscription.js';
import type { ViewContext } from '../billing/shared.js';
import { buildTokenPlanEditionSections } from './tokenplan-editions.js';
import { formatAsiaShanghaiDate } from '../../utils/date.js';

export const NA = '—';
export const CURRENCY_CODE = site.features.currency;
export const CURRENCY_SYMBOL =
  site.features.currency === 'USD'
    ? '$'
    : site.features.currency === 'CNY' || site.features.currency === 'JPY'
      ? '¥'
      : site.features.currency === 'EUR'
        ? '€'
        : site.features.currency === 'GBP'
          ? '£'
          : '';

export const STATUS_UNAVAILABLE_NOTE =
  'Subscription data unavailable — see --format json for diagnostics';

export const PARTIAL_FAILURE_NOTE_TEMPLATE = (count: number): string =>
  `Note: ${count} diagnostic(s), see --format json for details`;

export function formatDiagnosticMessage(diagnostic: SubscriptionDiagnostic): string {
  const prefix = `${diagnostic.api}:`;
  let message = diagnostic.errorMessage.trimStart();
  while (message.startsWith(prefix)) {
    message = message.slice(prefix.length).trimStart();
  }
  return message;
}

export function buildSubscriptionEditionSections(
  source: { individual?: TokenPlanEditionStatus; team?: TokenPlanEditionStatus },
  renewable: string | null,
): TokenPlanEditionSection[] {
  const sections = buildTokenPlanEditionSections(source);
  if (sections.length === 0 || renewable === null) return sections;
  const team = sections.find((section) => section.edition === 'team');
  if (team) team.fields.push({ label: 'Renewable', value: renewable });
  return sections;
}

const STATUS_TIME_FIELDS = new Set([
  'start',
  'end',
  'resetTime',
  'nextCycleFlushTime',
  'expiresAt',
  'orderTime',
]);

/** Normalize status JSON timestamps and omit unknown individual usage without changing service data. */
export function formatSubscriptionStatusJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatSubscriptionStatusJson);
  if (value === null || typeof value !== 'object') return value;
  const isIndividual = 'edition' in value && value.edition === 'individual';
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]): Array<[string, unknown]> => {
      const isIndividualCredits =
        isIndividual && (key === 'monthlyCredits' || key === 'weeklyCredits');
      if (isIndividualCredits && entry === null) return [];
      if (
        isIndividualCredits &&
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry)
      ) {
        const credits = Object.fromEntries(
          Object.entries(entry).filter(
            ([field, amount]) => amount !== null || (field !== 'used' && field !== 'remaining'),
          ),
        );
        return [[key, formatSubscriptionStatusJson(credits)]];
      }
      if (
        STATUS_TIME_FIELDS.has(key) &&
        typeof entry === 'string' &&
        /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(entry) &&
        Number.isFinite(Date.parse(entry))
      ) {
        return [[key, formatAsiaShanghaiDate(entry, 'iso')]];
      }
      return [[key, formatSubscriptionStatusJson(entry)]];
    }),
  );
}

export const NARROW_TERMINAL_THRESHOLD = 80;

export function renderQuotaBar(used: number, total: number): { bar: string; percent: number } {
  if (total <= 0) return { bar: '·'.repeat(24), percent: 0 };
  const ratio = Math.min(1, Math.max(0, used / total));
  const percent = Math.round(ratio * 100);
  const filled = Math.round(ratio * 24);
  return { bar: '█'.repeat(filled).padEnd(24, '·'), percent };
}

export function renderQuotaBarFor(
  used: number,
  total: number,
  ctx: ViewContext | undefined,
): { bar: string; percent: number } {
  const cols = typeof ctx?.columns === 'number' ? ctx.columns : 100;
  if (cols < NARROW_TERMINAL_THRESHOLD) {
    if (total <= 0) return { bar: '[0.00%]', percent: 0 };
    const ratio = Math.min(1, Math.max(0, used / total));
    const pct = (ratio * 100).toFixed(2);
    return { bar: `[${pct}%]`, percent: Math.round(ratio * 100) };
  }
  return renderQuotaBar(used, total);
}

/** Boolean → "Yes" / "No" / em-dash. */
export function formatBool(value: boolean | null): string {
  if (value === null) return NA;
  return value ? 'Yes' : 'No';
}

/** Period → "start → end" / em-dash. */
export function formatPeriod(start: string, end: string): string {
  if (!start && !end) return NA;
  return `${start || NA} → ${end || NA}`;
}

export type { ViewContext } from '../billing/shared.js';
