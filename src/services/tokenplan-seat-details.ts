import type { ApiClient } from '../api/api-client.js';
import { site } from '../site.js';
import type {
  TokenPlanEditionStatus,
  TokenPlanSeatDetail,
  TokenPlanSeatDetails,
} from '../types/tokenplan-subscription.js';
import {
  safeSubscriptionDiagnostic,
  subscriptionProtocolDiagnostic,
} from './subscription-diagnostics.js';
import { withTokenPlanDeadline } from './tokenplan-deadline.js';
import {
  subscriptionDecimal,
  subscriptionInteger,
  subscriptionObject,
} from './tokenplan-service.js';

const API = 'GetSubscriptionDetail';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const SPEC_TYPES = new Set(['standard', 'pro', 'max']);
const STATUSES = new Set(['CREATING', 'NORMAL', 'LIMIT', 'RELEASE', 'STOP', 'REFUNDED']);
const HISTORICAL_STATUSES = new Set(['RELEASE', 'STOP', 'REFUNDED']);

function withFieldCompleteness(details: TokenPlanSeatDetails): TokenPlanSeatDetails {
  const missingFields = details.items.some(
    (item) =>
      item.specType === null ||
      item.status === null ||
      item.assignment === 'unknown' ||
      item.totalValue === null ||
      item.surplusValue === null,
  );
  return {
    ...details,
    completeness:
      details.collectionCompleteness !== 'complete'
        ? details.collectionCompleteness
        : missingFields || details.diagnostics.length > 0
          ? 'partial'
          : 'complete',
  };
}

/** Only a fully matched, uniformly assigned group can resolve a missing per-seat assignment. */
export function resolveTokenPlanSeatAssignments(
  details: TokenPlanSeatDetails | undefined,
  team: TokenPlanEditionStatus,
): TokenPlanSeatDetails | undefined {
  if (!details) return undefined;
  const groups = team.seatSummary?.groups ?? [];
  const total = subscriptionInteger(team.seatSummary?.total?.seats);
  const specs = groups.map((group) => group.specType.toLowerCase());
  const comparable =
    team.status === 'active' &&
    details.collectionCompleteness === 'complete' &&
    !team.diagnostics.some((d) =>
      ['GetSeatSubscriptionSummary', 'GetSubscriptionSummary'].includes(d.api),
    ) &&
    details.items.every((item) => item.status !== null);
  const validGroups =
    new Set(specs).size === groups.length &&
    groups.every(
      (group, index) => SPEC_TYPES.has(specs[index]) && subscriptionInteger(group.seats) !== null,
    );
  const knownSpecs = details.items.every((item) => item.specType !== null);
  const groupsMatch =
    groups.reduce((sum, group) => sum + group.seats!, 0) === details.items.length &&
    groups.every(
      (group, index) =>
        details.items.filter((item) => item.specType === specs[index]).length === group.seats,
    );
  if (
    comparable &&
    ((total !== null && total !== details.items.length) ||
      (validGroups && groups.length > 0 && knownSpecs && !groupsMatch))
  ) {
    return withFieldCompleteness({
      ...details,
      diagnostics: [
        ...details.diagnostics.filter((d) => d.errorCode !== 'SeatSummaryMismatch'),
        subscriptionProtocolDiagnostic(
          API,
          'SeatSummaryMismatch',
          'Seat details do not match the seat summary. Please try again later.',
        ),
      ],
    });
  }
  const verified =
    comparable &&
    total !== null &&
    total === details.items.length &&
    validGroups &&
    knownSpecs &&
    groupsMatch &&
    groups.every(
      (group) => subscriptionInteger(group.assigned) !== null && group.assigned! <= group.seats!,
    );
  if (!verified) return details;

  const items = details.items.map((item) => ({ ...item }));
  const diagnostics = [...details.diagnostics];
  for (const [index, group] of groups.entries()) {
    const matching = items.filter((item) => item.specType === specs[index]);
    const assigned = matching.filter((item) => item.assignment === 'assigned').length;
    const unassigned = matching.filter((item) => item.assignment === 'unassigned').length;
    if (assigned > group.assigned! || unassigned > group.seats! - group.assigned!) {
      if (!diagnostics.some((d) => d.errorCode === 'AssignmentConflict')) {
        diagnostics.push(
          subscriptionProtocolDiagnostic(
            API,
            'AssignmentConflict',
            'Seat assignments disagree with the current seat summary.',
          ),
        );
      }
      continue;
    }
    const assignment =
      group.assigned === 0 ? 'unassigned' : group.assigned === group.seats ? 'assigned' : null;
    if (assignment) {
      for (const item of matching) if (item.assignment === 'unknown') item.assignment = assignment;
    }
  }
  return withFieldCompleteness({ ...details, items, diagnostics });
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function exceeds(remaining: string, total: string): boolean {
  const [ri = '0', rf = ''] = remaining.split('.');
  const [ti = '0', tf = ''] = total.split('.');
  if (ri.length !== ti.length) return ri.length > ti.length;
  if (ri !== ti) return ri > ti;
  const precision = Math.max(rf.length, tf.length);
  return rf.padEnd(precision, '0') > tf.padEnd(precision, '0');
}

function parseSeat(entry: Record<string, unknown>, instanceCode: string): TokenPlanSeatDetail {
  const spec = nonempty(entry.SpecType)?.toLowerCase();
  const status = nonempty(entry.Status)?.toUpperCase();
  const equity = Array.isArray(entry.EquityList) ? subscriptionObject(entry.EquityList[0]) : null;
  // Never pair a cycle value with a lifetime value when one cycle field is missing.
  const cycle = equity && ('CycleTotalValue' in equity || 'CycleSurplusValue' in equity);
  const isCredits = equity?.Unit === undefined || /^(?:credit|credits)$/i.test(String(equity.Unit));
  const totalValue = isCredits
    ? subscriptionDecimal(cycle ? equity?.CycleTotalValue : equity?.TotalValue)
    : null;
  let surplusValue = isCredits
    ? subscriptionDecimal(cycle ? equity?.CycleSurplusValue : equity?.SurplusValue)
    : null;
  if (totalValue !== null && surplusValue !== null && exceeds(surplusValue, totalValue)) {
    surplusValue = null;
  }
  return {
    instanceCode,
    specType: spec && SPEC_TYPES.has(spec) ? spec : null,
    status: status && STATUSES.has(status) ? status : null,
    assignment:
      typeof entry.MemberId === 'string'
        ? entry.MemberId === ''
          ? 'unassigned'
          : entry.MemberId.trim()
            ? 'assigned'
            : 'unknown'
        : 'unknown',
    totalValue,
    surplusValue,
  };
}

/** Bounded status-only collection. Partial details must never change subscription validity. */
export async function fetchTokenPlanSeatDetails(
  apiClient: ApiClient,
  parent?: AbortSignal,
): Promise<TokenPlanSeatDetails> {
  const items: TokenPlanSeatDetail[] = [];
  const diagnostics: TokenPlanSeatDetails['diagnostics'] = [];
  const identities = new Set<string>();
  let totalCount: number | null = null;
  let covered = false;
  const diagnose = (code: string) => {
    if (!diagnostics.some((d) => d.errorCode === code)) {
      diagnostics.push(
        subscriptionProtocolDiagnostic(API, code, 'Seat details are incomplete. Try again later.'),
      );
    }
  };

  try {
    await withTokenPlanDeadline(async (signal) => {
      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        signal.throwIfAborted();
        const value = await apiClient.callFlatApi<unknown>({
          product: 'BssOpenAPI-V3',
          action: API,
          signal,
          params: {
            productCode: site.features.tokenPlanCommodityCodes.teams,
            pageNo,
            pageSize: PAGE_SIZE,
          },
        });
        // A client that ignores abort must not mutate the returned snapshot later.
        signal.throwIfAborted();
        const raw = subscriptionObject(value);
        if (
          !raw ||
          (raw.Success !== undefined && raw.Success !== true) ||
          (raw.Code !== undefined && raw.Code !== 'Success')
        ) {
          diagnose('Unavailable');
          break;
        }
        const inner = subscriptionObject(raw.Data);
        const list = Array.isArray(raw.Data) ? raw.Data : inner?.SubscriptionList;
        if (!Array.isArray(list)) {
          diagnose('InvalidResponse');
          break;
        }
        const metadata = inner ? [raw, inner] : [raw];
        const totals = metadata
          .filter((m) => m.TotalCount !== undefined)
          .map((m) => subscriptionInteger(m.TotalCount));
        const pageTotal = totals[0] ?? null;
        const invalidTotal = totals.some((n) => n === null || n !== pageTotal);
        const changedTotal = pageNo > 1 && pageTotal !== totalCount;
        const invalidPage = metadata.some(
          (m) =>
            ['CurrentPage', 'PageNo'].some((key) => m[key] !== undefined && m[key] !== pageNo) ||
            (m.PageSize !== undefined && m.PageSize !== PAGE_SIZE),
        );
        const invalidSize = list.length > PAGE_SIZE;
        if (pageNo === 1) totalCount = pageTotal;
        if (invalidTotal || changedTotal) {
          totalCount = null;
          diagnose('InconsistentTotal');
        }
        if (invalidPage || invalidSize) diagnose('InvalidPagination');
        if (pageTotal === null) diagnose('MissingTotal');

        const before = items.length;
        for (const value of list) {
          const entry = subscriptionObject(value);
          const code = nonempty(entry?.InstanceCode);
          const id = nonempty(entry?.InstanceId);
          if (
            !entry ||
            (!code && !id) ||
            (entry.ProductCode !== undefined &&
              entry.ProductCode !== site.features.tokenPlanCommodityCodes.teams)
          ) {
            diagnose('InvalidSeat');
            continue;
          }
          const keys = [...(code ? [`code:${code}`] : []), ...(id ? [`id:${id}`] : [])];
          if (keys.some((key) => identities.has(key))) {
            diagnose('DuplicateSeat');
            continue;
          }
          keys.forEach((key) => identities.add(key));
          const item = parseSeat(entry, code ?? id!);
          items.push(item);
        }

        if (invalidTotal || changedTotal || invalidPage || invalidSize) break;
        if (totalCount !== null && items.length >= totalCount) {
          covered = items.length === totalCount;
          if (!covered) {
            totalCount = null;
            diagnose('InconsistentTotal');
          }
          break;
        }
        if (items.length === before || (totalCount === null && list.length < PAGE_SIZE)) {
          diagnose('IncompletePagination');
          break;
        }
        if (pageNo === MAX_PAGES) diagnose('PageLimit');
      }
    }, parent);
  } catch (error) {
    diagnostics.push(safeSubscriptionDiagnostic(API, error));
  }
  const current = items.filter((item) => !HISTORICAL_STATUSES.has(item.status ?? ''));
  const collectionCompleteness =
    covered && diagnostics.length === 0 ? 'complete' : items.length ? 'partial' : 'unknown';
  return withFieldCompleteness({
    items: current,
    fetchedCount: items.length,
    totalCount,
    historicalCount: items.length - current.length,
    collectionCompleteness,
    completeness: collectionCompleteness,
    diagnostics,
  });
}
