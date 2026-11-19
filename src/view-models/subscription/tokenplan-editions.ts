import type {
  TokenPlanCreditWindow,
  TokenPlanEditionSection,
  TokenPlanEditionStatus,
} from '../../types/tokenplan-subscription.js';
import { formatAsiaShanghaiDate } from '../../utils/date.js';
import { formatTeamSeatAllocation } from './tokenplan-seat-details.js';

// Re-exported so existing consumers (tokenplan-status.ts) keep resolving from this module.
export { formatAsiaShanghaiDate };

const TEAM_PLAN_NAME = 'Token Plan Team Edition';
const INDIVIDUAL_PLAN_NAME = 'Token Plan Individual Edition';

/** Personal usage is ratio-only; missing ratios must not be inferred from Credits amounts. */
export function individualCreditPercentages(value: unknown): {
  usedPct: number | null;
  remainingPct: number | null;
} {
  const usedPct =
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : null;
  return { usedPct, remainingPct: usedPct === null ? null : 100 - usedPct };
}

function credits(window: TokenPlanCreditWindow): string {
  const { usedPct, remainingPct } = individualCreditPercentages(window.usedPct);
  const formatPercent = (percentage: number | null) =>
    percentage === null ? 'unknown' : `${Math.round((percentage + Number.EPSILON) * 100) / 100}%`;
  const reset = window.resetTime
    ? `; resets ${formatAsiaShanghaiDate(window.resetTime, 'datetime')}`
    : '';
  return `${formatPercent(usedPct)} used (${formatPercent(remainingPct)} remaining)${reset}`;
}

function period(start: string, end: string, remainingDays: number | null): string {
  const range = `${formatAsiaShanghaiDate(start)} → ${formatAsiaShanghaiDate(end)}`;
  if (remainingDays === null) return range;
  const unit = remainingDays === 1 ? 'day' : 'days';
  return `${range} (${remainingDays} ${unit} remaining)`;
}

function name(edition: TokenPlanEditionStatus): string {
  return edition.name ?? (edition.edition === 'individual' ? INDIVIDUAL_PLAN_NAME : TEAM_PLAN_NAME);
}

export function buildTokenPlanEditionSections(source: {
  individual?: TokenPlanEditionStatus;
  team?: TokenPlanEditionStatus;
}): TokenPlanEditionSection[] {
  return [source.individual, source.team].flatMap((edition) => {
    if (!edition) return [];
    const fields: Array<{ label: string; value: string }> = [
      { label: 'Status', value: edition.status },
    ];
    if (edition.status === 'not_subscribed') {
      fields.push({ label: 'Name', value: name(edition) });
    }
    if (edition.status !== 'not_subscribed') {
      fields.push(
        { label: 'Type', value: edition.type ?? 'unknown' },
        { label: 'Name', value: name(edition) },
        {
          label: 'Period',
          value: edition.period
            ? period(edition.period.start, edition.period.end, edition.remainingDays)
            : 'unknown',
        },
        {
          label: 'Auto-Renew',
          value: edition.autoRenew ? (edition.autoRenew.enabled ? 'On' : 'Off') : 'unknown',
        },
      );
      if (edition.billingCycle) {
        fields.splice(3, 0, { label: 'Billing Cycle', value: edition.billingCycle });
      }
      if (edition.edition === 'individual' && edition.monthlyCredits) {
        fields.push({ label: 'Monthly Credits', value: credits(edition.monthlyCredits) });
      }
      if (edition.edition === 'individual' && edition.weeklyCredits) {
        fields.push({ label: 'Weekly Credits', value: credits(edition.weeklyCredits) });
      }
      if (edition.edition === 'team') {
        fields.push({ label: 'Seats', value: formatTeamSeatAllocation(edition.seatSummary) });
      }
    }
    return [
      {
        edition: edition.edition,
        title: edition.edition === 'individual' ? 'Individual' : 'Team',
        fields,
      },
    ];
  });
}
