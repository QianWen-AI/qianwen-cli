import { stripVTControlCharacters } from 'node:util';
import type {
  TokenPlanListResult,
  TokenPlanListRow,
  TokenPlanListSection,
} from '../../types/tokenplan-catalog.js';
import { findTokenPlanIndividualTierBySpecCode } from '../../types/tokenplan-tiers.js';

export type TokenPlanListJsonRow = Omit<TokenPlanListRow, 'status'> & {
  status?: TokenPlanListRow['status'];
};

export type TokenPlanListJsonResult = Omit<TokenPlanListResult, 'sections'> & {
  sections: Array<
    Omit<TokenPlanListSection, 'rows'> & {
      rows: TokenPlanListJsonRow[];
    }
  >;
};

export interface TokenPlanListViewModel {
  data: TokenPlanListJsonResult;
  billingCycleLabel: string;
  sections: Array<{
    edition: string;
    title: string;
    subscription: string | null;
    subscriptionDetails: string[];
    type: string | null;
    cycleNote: string | null;
    columns: Array<{ key: string; header: string }>;
    rows: Record<string, string>[];
    diagnostics: string[];
  }>;
  note: string;
}

function text(value: string): string {
  return Array.from(stripVTControlCharacters(value))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join('')
    .trim();
}

const seatNames: Record<string, string> = {
  standard: 'Standard Seat',
  pro: 'Pro Seat',
  max: 'Max Seat',
};

const individualStatusLabels: Record<TokenPlanListRow['status'], string> = {
  purchasable: 'purchasable',
  unavailable: 'not_subscribable',
  subscribed: 'current_plan',
  upgrade: 'upgrade_on_web',
  unknown: 'unknown',
};

function rowName(row: TokenPlanListRow, individual: boolean): string {
  return (
    (individual
      ? findTokenPlanIndividualTierBySpecCode(row.specCode)?.name
      : seatNames[row.specCode]) ??
    row.name ??
    row.seatType ??
    row.type
  );
}

function catalogDegradationMessages(section: TokenPlanListSection): string[] {
  if (section.billingCycleSupported === false) return [];
  const individual = section.edition === 'individual';
  if (section.rows.length === 0) {
    return [
      `${individual ? 'Individual' : 'Team'} Token Plan catalog is temporarily unavailable. Try again later.`,
    ];
  }

  const messages = section.rows.flatMap((row) => {
    const missing: string[] = [];
    if (row.price === null || row.currency === null) missing.push('price');
    if (row.inventory === null) missing.push('availability');
    if (individual) {
      // A personal tier needs at least one quota-config limit (weekly or its monthly fallback).
      if (row.weeklyCredits === undefined && row.monthlyCredits === null) {
        missing.push('credit limit');
      }
    } else if (row.monthlyCredits === null) {
      missing.push('monthly credit limit');
    }
    if (missing.length === 0) return [];
    const fields =
      missing.length === 1
        ? missing[0]!
        : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`;
    return [
      `${rowName(row, individual)} ${fields} ${missing.length === 1 ? 'is' : 'are'} temporarily unavailable. Try again later.`,
    ];
  });

  return [...new Set(messages)];
}

function creditText(value: string | number, seat = false): string {
  const [integer, fraction] = String(value).split('.');
  const amount = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
  return `${amount} Credits${seat ? '/seat' : ''}`;
}

function formatPriceWithComma(price: string): string {
  const [integer, fraction] = price.split('.');
  const formatted =
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
  return formatted;
}

function priceText(
  price: string,
  individual: boolean,
  cycle: TokenPlanListResult['billingCycle'],
): string {
  const cycleUnit = { monthly: 'month', quarterly: 'quarter', yearly: 'year' }[cycle];
  return `¥${formatPriceWithComma(price)}${individual ? '' : '/seat'}/${cycleUnit}`;
}

export function buildTokenPlanListViewModel(
  result: TokenPlanListResult,
  options: { billingCycleDefaulted?: boolean } = {},
): TokenPlanListViewModel {
  const normalizedSections: TokenPlanListSection[] = result.sections.map((section) => ({
    edition: section.edition,
    billingCycleSupported: section.billingCycleSupported,
    subscriptionStatus: section.subscriptionStatus,
    currentPlan: section.currentPlan === null ? null : text(section.currentPlan),
    currentBillingCycle:
      section.currentBillingCycle === null ? null : text(section.currentBillingCycle),
    subscriptionUrl: section.subscriptionUrl === null ? null : text(section.subscriptionUrl),
    diagnostics: section.diagnostics.map((entry) => ({
      api: text(entry.api),
      errorCode: text(entry.errorCode),
      errorMessage: text(entry.errorMessage),
    })),
    rows: section.rows.map((row) => ({
      type: row.type,
      specCode: row.specCode,
      seatType: row.seatType,
      name: row.name === null ? null : text(row.name) || null,
      price: row.price,
      currency: row.currency,
      inventory: row.inventory,
      ...(row.weeklyCredits === undefined ? {} : { weeklyCredits: row.weeklyCredits }),
      monthlyCredits: row.monthlyCredits,
      status: row.status,
    })),
  }));
  const data: TokenPlanListJsonResult = {
    authenticated: result.authenticated,
    edition: result.edition,
    billingCycle: result.billingCycle,
    completeness: result.completeness,
    sections: normalizedSections.map((section) => ({
      edition: section.edition,
      billingCycleSupported: section.billingCycleSupported,
      subscriptionStatus: section.subscriptionStatus,
      currentPlan: section.currentPlan,
      currentBillingCycle: section.currentBillingCycle,
      subscriptionUrl: section.subscriptionUrl,
      diagnostics: section.diagnostics,
      rows: section.rows.map(({ status, ...row }) =>
        section.edition === 'team' && section.subscriptionStatus === 'active'
          ? row
          : { ...row, status },
      ),
    })),
  };
  return {
    data,
    billingCycleLabel: `${data.billingCycle}${options.billingCycleDefaulted ? ' (default)' : ''}`,
    sections: normalizedSections.map((section) => {
      const individual = section.edition === 'individual';
      const active = section.subscriptionStatus === 'active';
      const currentPlan =
        section.currentPlan === null
          ? null
          : (findTokenPlanIndividualTierBySpecCode(section.currentPlan)?.name ??
            section.currentPlan);
      const currentSubscription = individual
        ? currentPlan
          ? ` Current plan: ${currentPlan}${section.currentBillingCycle ? ` (${section.currentBillingCycle})` : ''}`
          : ''
        : '';
      const subscriptionDetails = active
        ? [
            ...(!individual && section.currentBillingCycle
              ? [`Billing cycle: ${section.currentBillingCycle}`]
              : []),
            ...(section.subscriptionUrl ? [`View subscription: ${section.subscriptionUrl}`] : []),
          ]
        : [];
      const showWeeklyCredits =
        individual &&
        section.rows.length > 0 &&
        section.rows.every((row) => row.weeklyCredits !== undefined);
      // Weekly wins; the monthly column appears only when every personal tier lacks weekly
      // but reports a quota-config monthly limit (pricing page card fallback semantics).
      const showMonthlyCredits =
        individual &&
        !showWeeklyCredits &&
        section.rows.length > 0 &&
        section.rows.every((row) => row.monthlyCredits !== null);
      const creditsColumn = showWeeklyCredits
        ? [{ key: 'weekly', header: 'WEEKLY CREDITS' }]
        : showMonthlyCredits
          ? [{ key: 'monthly', header: 'MONTHLY CREDITS' }]
          : [];
      return {
        edition: section.edition,
        title: individual ? 'INDIVIDUAL TOKEN PLANS' : 'TEAM TOKEN PLAN',
        type: null,
        subscription: active
          ? `You're already subscribed to ${individual ? 'an Individual' : 'a Team'} Token Plan.${currentSubscription}`
          : section.subscriptionStatus === 'not_subscribed' && data.authenticated
            ? `No active ${individual ? 'Individual' : 'Team'} Token Plan subscription.`
            : data.authenticated &&
                section.subscriptionStatus === 'unknown' &&
                section.billingCycleSupported !== false
              ? 'Subscription status: unknown'
              : null,
        subscriptionDetails,
        cycleNote:
          section.billingCycleSupported === false
            ? individual
              ? `Error: billing cycle '${data.billingCycle}' is not available for Individual Token Plans.\nAvailable billing cycles:\n  monthly\n  quarterly\n  yearly`
              : `Error: billing cycle '${data.billingCycle}' is not available for Team Token Plans.\nAvailable billing cycles:\n  monthly\n  yearly`
            : section.billingCycleSupported === null
              ? 'Billing cycle support: unknown'
              : null,
        columns: [
          { key: 'type', header: 'TOKENPLAN TYPE' },
          ...(!individual ? [{ key: 'seatType', header: 'SEAT TYPE' }] : []),
          { key: 'name', header: 'NAME' },
          { key: 'price', header: individual ? 'PRICE' : 'UNIT PRICE' },
          ...(individual ? creditsColumn : [{ key: 'monthly', header: 'MONTHLY CREDITS' }]),
          ...(individual || !active ? [{ key: 'status', header: 'STATUS' }] : []),
        ],
        rows: section.rows.map((row) => ({
          type: row.type,
          ...(!individual ? { seatType: row.seatType ?? 'unknown' } : {}),
          name:
            (individual
              ? findTokenPlanIndividualTierBySpecCode(row.specCode)?.name
              : seatNames[row.specCode]) ??
            row.name ??
            'unknown',
          price:
            row.price === null || row.currency === null
              ? 'unknown'
              : priceText(row.price, individual, data.billingCycle),
          ...(showWeeklyCredits ? { weekly: creditText(row.weeklyCredits!) } : {}),
          monthly:
            row.monthlyCredits === null ? 'unknown' : creditText(row.monthlyCredits, !individual),
          ...(individual
            ? { status: individualStatusLabels[row.status] }
            : !active
              ? { status: row.status }
              : {}),
        })),
        diagnostics: catalogDegradationMessages(section),
      };
    }),
    note: (() => {
      const supportedCycles =
        data.edition === 'team'
          ? (['monthly', 'yearly'] as const)
          : (['monthly', 'quarterly', 'yearly'] as const);
      const editionOption = data.edition === 'all' ? '' : ` --edition ${data.edition}`;
      return [
        ...(!data.authenticated
          ? [
              'You can view Token Plan prices without logging in.',
              'Log in to also view your subscription status and account-specific availability.',
              '  qianwen auth login',
              '',
            ]
          : []),
        'Availability shown here is for reference. Your eligibility will be verified again before purchase.',
        '',
        'To view another billing cycle, run:',
        ...supportedCycles
          .filter((c) => c !== data.billingCycle)
          .map((c) => `  qianwen subscription tokenplan list${editionOption} --billing-cycle ${c}`),
        '',
        'To purchase a Token Plan, run:',
        '  qianwen subscription tokenplan purchase <token-plan-type> \\',
        '    --billing-cycle <cycle> \\',
        '    --channel <channel> \\',
        '    (--auto-renew | --no-auto-renew) \\',
        '    [options]',
        '',
        "Run 'qianwen subscription tokenplan purchase --help' for available values and options.",
      ].join('\n');
    })(),
  };
}
