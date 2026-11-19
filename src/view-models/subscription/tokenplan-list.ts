import { stripVTControlCharacters } from 'node:util';
import type {
  TokenPlanListResult,
  TokenPlanListRow,
  TokenPlanListSection,
  TokenPlanCatalogPlan,
  TokenPlanCurrentPlanDetails,
} from '../../types/tokenplan-catalog.js';
import { findTokenPlanIndividualTierBySpecCode } from '../../types/tokenplan-tiers.js';
import { TOKEN_PLAN_PURCHASE_EXAMPLES } from '../../config/tokenplan-purchase-examples.js';
import { individualCreditPercentages } from './tokenplan-editions.js';
import {
  buildTokenPlanCatalogDetails,
  tokenPlanDisplayDate,
  type TokenPlanDisplayTable,
} from './tokenplan-details.js';

export type TokenPlanListJsonRow = Omit<TokenPlanListRow, 'status'> & {
  status?: TokenPlanListRow['status'];
};

export type TokenPlanListJsonCurrentPlanDetails = Omit<
  TokenPlanCurrentPlanDetails,
  'totalCredits' | 'remainingCredits'
>;

export type TokenPlanListJsonResult = Omit<TokenPlanListResult, 'sections'> & {
  sections: Array<
    Omit<TokenPlanListSection, 'rows' | 'currentPlanDetails'> & {
      rows: TokenPlanListJsonRow[];
      currentPlanDetails?: TokenPlanListJsonCurrentPlanDetails | null;
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
    details: TokenPlanDisplayTable[];
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

function nullableText(value: string | null): string | null {
  return value === null ? null : text(value);
}

function normalizePlan(plan: TokenPlanCatalogPlan): TokenPlanCatalogPlan {
  return {
    ...(plan.tier === undefined ? {} : { tier: text(plan.tier) }),
    ...(plan.seatType === undefined ? {} : { seatType: text(plan.seatType) }),
    billingTerm: plan.billingTerm,
    listPrice: nullableText(plan.listPrice),
    promoPrice: nullableText(plan.promoPrice),
    currency: plan.currency,
    quotaWindows: plan.quotaWindows.map((window) => ({
      windowType: window.windowType,
      totalCredits: text(window.totalCredits),
    })),
    ...(plan.supportedModels === undefined
      ? {}
      : {
          supportedModels:
            plan.supportedModels === null
              ? null
              : plan.supportedModels.map((model) => ({
                  modelId: text(model.modelId),
                  modelBrand: text(model.modelBrand),
                  modelName: text(model.modelName),
                  capabilities: model.capabilities.map(text),
                  ...(model.badgeLabel === undefined ? {} : { badgeLabel: text(model.badgeLabel) }),
                  ...(model.badgeDescription === undefined
                    ? {}
                    : { badgeDescription: text(model.badgeDescription) }),
                  ...(model.isNew === undefined ? {} : { isNew: model.isNew }),
                })),
        }),
  };
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

  return [
    ...new Set([
      ...messages,
      ...section.diagnostics
        .filter(
          (entry) =>
            entry.api === 'TokenPlanSupportedModels' ||
            (entry.api.endsWith('/quota-config') &&
              ['INVALID_WEEKLY_QUOTA', 'INVALID_MONTHLY_QUOTA'].includes(entry.errorCode)),
        )
        .map((entry) => entry.errorMessage),
    ]),
  ];
}

function displayPrice(value: string | null): string {
  if (value === null) return '—';
  const [integer, fraction = ''] = value.split('.');
  return `${integer}.${fraction.padEnd(2, '0')}`;
}

function personalCurrentPlanPercentages(details: TokenPlanCurrentPlanDetails): {
  usedPct: number | null;
  remainingPct: number | null;
} {
  if (Object.hasOwn(details, 'usedPct')) return individualCreditPercentages(details.usedPct);
  // Legacy callers may provide only the personal remaining ratio; never infer it from Credits.
  const remainingPct =
    typeof details.remainingPct === 'number' &&
    Number.isFinite(details.remainingPct) &&
    details.remainingPct >= 0 &&
    details.remainingPct <= 100
      ? details.remainingPct
      : null;
  return { usedPct: remainingPct === null ? null : 100 - remainingPct, remainingPct };
}

function displayPercentage(value: number | null | undefined): string {
  return value == null ? '—' : `${Math.round(value * 100) / 100}%`;
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
    ...(section.currentPlanDetails === undefined
      ? {}
      : {
          currentPlanDetails:
            section.currentPlanDetails === null
              ? null
              : {
                  subscriptionId: nullableText(section.currentPlanDetails.subscriptionId),
                  endAt: nullableText(section.currentPlanDetails.endAt),
                  totalCredits: nullableText(section.currentPlanDetails.totalCredits),
                  remainingCredits: nullableText(section.currentPlanDetails.remainingCredits),
                  ...(section.edition === 'individual'
                    ? personalCurrentPlanPercentages(section.currentPlanDetails)
                    : {}),
                  ...(section.currentPlanDetails.quotaWindowType === undefined
                    ? {}
                    : { quotaWindowType: section.currentPlanDetails.quotaWindowType }),
                },
        }),
    ...(section.plans === undefined ? {} : { plans: section.plans.map(normalizePlan) }),
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
      ...(section.currentPlanDetails === undefined
        ? {}
        : {
            currentPlanDetails:
              section.currentPlanDetails === null
                ? null
                : {
                    subscriptionId: section.currentPlanDetails.subscriptionId,
                    endAt: section.currentPlanDetails.endAt,
                    ...(section.edition === 'individual'
                      ? {
                          usedPct: section.currentPlanDetails.usedPct ?? null,
                          remainingPct: section.currentPlanDetails.remainingPct ?? null,
                        }
                      : {}),
                    ...(section.currentPlanDetails.quotaWindowType === undefined
                      ? {}
                      : { quotaWindowType: section.currentPlanDetails.quotaWindowType }),
                  },
          }),
      ...(section.plans === undefined ? {} : { plans: section.plans }),
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
          ]
        : [];
      if (section.currentPlanDetails) {
        const current = section.currentPlanDetails;
        subscriptionDetails.push(
          ...(individual || current.subscriptionId
            ? [`Subscription ID: ${current.subscriptionId ? text(current.subscriptionId) : '—'}`]
            : []),
          `End At: ${tokenPlanDisplayDate(current.endAt)}`,
          ...(individual
            ? [
                `Used (%): ${displayPercentage(current.usedPct)}; Remaining (%): ${displayPercentage(current.remainingPct)}${current.quotaWindowType ? ` (${current.quotaWindowType})` : ''}`,
              ]
            : []),
        );
      }
      if (active && section.subscriptionUrl) {
        subscriptionDetails.push(`View subscription: ${section.subscriptionUrl}`);
      }
      return {
        edition: section.edition,
        title: individual ? 'INDIVIDUAL TOKEN PLANS' : 'TEAM TOKEN PLANS',
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
          individual ? { key: 'tier', header: 'Tier' } : { key: 'seatType', header: 'Seat Type' },
          { key: 'billingCycle', header: 'Billing Cycle' },
          { key: 'listPrice', header: 'List Price' },
          { key: 'promoPrice', header: 'Promo Price' },
          { key: 'currency', header: 'Currency' },
          { key: 'quotaWindow', header: 'Quota Window' },
          { key: 'totalCredits', header: 'Total Credits' },
          ...(individual || !active ? [{ key: 'status', header: 'Status' }] : []),
        ],
        rows: section.rows.flatMap((row, index) => {
          const plan = section.plans?.[index];
          // Display verified quota windows while keeping the legacy JSON rows intact.
          const windows = section.plans
            ? (plan?.quotaWindows ?? [])
            : [
                ...(individual && row.weeklyCredits !== undefined
                  ? [{ windowType: 'weekly', totalCredits: String(row.weeklyCredits) }]
                  : []),
                ...(row.monthlyCredits !== null
                  ? [{ windowType: 'monthly', totalCredits: String(row.monthlyCredits) }]
                  : []),
              ];
          return (windows.length > 0 ? windows : [null]).map((window) => ({
            ...(individual ? { tier: row.specCode } : { seatType: row.seatType ?? row.specCode }),
            billingCycle: plan?.billingTerm ?? data.billingCycle,
            listPrice: displayPrice(plan?.listPrice ?? null),
            promoPrice: displayPrice(plan?.promoPrice ?? null),
            currency: (section.plans ? plan?.currency : row.currency) ?? '—',
            quotaWindow: window?.windowType ?? '—',
            totalCredits: window?.totalCredits ?? '—',
            ...(individual || !active
              ? { status: individual ? individualStatusLabels[row.status] : row.status }
              : {}),
          }));
        }),
        diagnostics: catalogDegradationMessages(section),
        details: buildTokenPlanCatalogDetails(section),
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
              'To view your subscription status and account-specific availability, run:',
              '  qianwen auth login',
              '',
            ]
          : []),
        'Your purchase status shown here is for reference only. Your eligibility will be verified again before purchase.',
        '',
        'To view another billing cycle, run:',
        ...supportedCycles
          .filter((c) => c !== data.billingCycle)
          .map((c) => `  qianwen subscription tokenplan list${editionOption} --billing-cycle ${c}`),
        '',
        'To purchase a Token Plan, run:',
        ...(data.edition === 'team' ? [] : [`  ${TOKEN_PLAN_PURCHASE_EXAMPLES.individual}`]),
        ...(data.edition === 'individual' ? [] : [`  ${TOKEN_PLAN_PURCHASE_EXAMPLES.team}`]),
        '',
        "Run 'qianwen subscription tokenplan purchase --help' for available values and options.",
      ].join('\n');
    })(),
  };
}
