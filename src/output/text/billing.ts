import type {
  BillingLimitViewModel,
  BillingBreakdownViewModel,
  BillingSummaryViewModel,
  BalanceSummaryViewModel,
} from '../../view-models/billing/index.js';
import type { ViewContext } from '../../view-models/billing/shared.js';
import type { ConsumeBreakdownByPeriods } from '../../types/billing-extra.js';
import { formatTextTable } from '../../output/format.js';
import { formatMoney } from '../../view-models/billing/shared.js';

export function renderTextBillingLimit(vm: BillingLimitViewModel): void {
  for (const field of vm.fields) {
    console.log(`  ${field.label.padEnd(18)}${field.value}`);
  }
  console.log(`  ${'Currency'.padEnd(18)}${vm.currency}`);
}

export function renderTextBillingBreakdown(vm: BillingBreakdownViewModel): void {
  const headers = vm.columns.map((c) => c.header);
  const rows = vm.rows.map((r) => [r.cells.label, r.cells.amount]);
  rows.push(['TOTAL', vm.total.display]);

  console.log(`  Period         ${vm.period}`);
  console.log(`  Charge Type    ${vm.chargeType}`);
  console.log('');
  console.log(formatTextTable(headers, rows));
  if (vm.truncationNotice) console.log(`  ${vm.truncationNotice}`);
}

export function renderTextBillingBreakdownByPeriods(
  data: ConsumeBreakdownByPeriods,
  ctx: ViewContext,
): void {
  const groupHeader = data.groupBy === 'api-key' ? 'API Key' : 'Model';
  console.log(`  Date Range     ${data.dateRange.from} \u2192 ${data.dateRange.to}`);
  console.log(`  Granularity    ${data.granularity}`);
  console.log(`  Charge Type    ${data.chargeType}`);
  console.log('');

  for (const slice of data.slices) {
    console.log(`  \u2500\u2500\u2500 ${slice.period} \u2500\u2500\u2500`);
    const headers = [groupHeader, 'Amount'];
    const rows = slice.rows.map((r: { groupLabel: string; amount: string }) => [
      r.groupLabel,
      formatMoney(r.amount, ctx),
    ]);
    rows.push(['TOTAL', formatMoney(slice.totalAmount, ctx)]);
    console.log(formatTextTable(headers, rows));
    console.log('');
  }
}

export function renderTextBillingSummary(vm: BillingSummaryViewModel): void {
  console.log(`  Cycle          ${vm.cycle}`);
  if (vm.chargeType !== undefined) {
    console.log(`  Charge Type    ${vm.chargeType}`);
  }
  console.log(`  Currency       ${vm.currency}`);
  console.log('');
  for (const f of vm.fields) {
    console.log(`  ${f.label.padEnd(18)}${f.value}`);
  }
}

export function renderTextBalanceSummary(vm: BalanceSummaryViewModel): void {
  console.log(`  ${'AVAILABLE AMOUNT'.padEnd(20)}${vm.availableAmount} ${vm.currency}`);
}
