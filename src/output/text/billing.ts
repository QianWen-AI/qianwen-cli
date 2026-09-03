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
import { formatCmd } from '../../utils/runtime-mode.js';
import {
  RECHARGE_LABEL_WIDTH,
  buildRechargeResultDisplay,
  describeRechargeResult,
  formatRechargeAmount,
} from '../../view-models/billing/recharge.js';
import { classifyRechargeStatus } from '../../utils/recharge-status.js';
import { formatShanghaiDateTimeForDisplay } from '../../utils/date.js';
import type {
  RechargeHistoryViewModel,
  RechargePaymentViewModel,
  RechargeResultViewModel,
} from '../../view-models/billing/recharge.js';

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
  if (vm.cycles.length > 0) {
    for (const c of vm.cycles) {
      console.log(`  ${c.billingCycle.padEnd(18)}${c.display[0]?.value ?? ''}`);
    }
    console.log('');
  }
  for (const f of vm.fields) {
    console.log(`  ${f.label.padEnd(18)}${f.value}`);
  }
}

export function renderTextBalanceSummary(vm: BalanceSummaryViewModel): void {
  console.log(`  ${'AVAILABLE AMOUNT'.padEnd(20)}${vm.availableAmount} ${vm.currency}`);
}

/** Render a newly-created recharge order without ANSI sequences or a QR code. */
export function renderTextRechargePayment(vm: RechargePaymentViewModel): void {
  const label = (text: string) => text.padEnd(RECHARGE_LABEL_WIDTH);
  console.log('  Payment order created.');
  console.log('');
  console.log(`  ${label('TYPE')}${vm.type}`);
  console.log(`  ${label('CHANNEL')}${vm.channel}`);
  console.log(`  ${label('AMOUNT')}${formatRechargeAmount(vm.amount, vm.currency)}`);
  console.log('');
  console.log('  Open the payment link below on a mobile device with Alipay installed:');
  // Keep the validated URL in one unprefixed write for direct selection/copy.
  console.log(vm.paymentUrl);
}

/** Render an existing recharge result with a safety explanation for unknown states. */
export function renderTextRechargeResult(vm: RechargeResultViewModel): void {
  const label = (text: string) => text.padEnd(RECHARGE_LABEL_WIDTH);
  const display = buildRechargeResultDisplay(vm);
  const disposition =
    display.status === 'succeeded'
      ? 'success'
      : display.failureReason
        ? 'failure'
        : classifyRechargeStatus(vm.status);
  console.log(
    disposition === 'success'
      ? '  Recharge completed.'
      : disposition === 'failure'
        ? '  Recharge failed or timed out.'
        : `  ${describeRechargeResult(
            vm.status,
            vm.reason,
            formatCmd('billing balance summary'),
            formatCmd('billing balance recharge-history'),
          )}`,
  );
  if (disposition === 'failure') {
    console.log(
      `  Before trying again, check your balance: ${formatCmd('billing balance summary')}`,
    );
  }
  console.log('');
  console.log(`  ${label('TYPE')}${vm.type}`);
  console.log(`  ${label('STATUS')}${display.status}`);
  if (display.failureReason) {
    console.log(`  ${label('FAILURE REASON')}${display.failureReason}`);
  }
}

/** Render paginated recharge history without backend transaction identifiers. */
export function renderTextRechargeHistory(vm: RechargeHistoryViewModel): void {
  console.log(
    `  ${'Date Range'.padEnd(20)}${formatShanghaiDateTimeForDisplay(vm.startTime)} → ${formatShanghaiDateTimeForDisplay(vm.endTime)}`,
  );
  console.log(`  ${'Page'.padEnd(20)}${vm.page} (${vm.pageSize} per page, ${vm.totalCount} total)`);
  console.log('');

  if (vm.records.length === 0) {
    console.log('  No recharge records.');
    return;
  }

  console.log(
    formatTextTable(
      ['Time', 'Type', 'Channel', 'Amount'],
      vm.records.map((record) => [
        formatShanghaiDateTimeForDisplay(record.tradeTime),
        record.tradeType,
        record.tradeChannel,
        `${record.amount} ${record.currency}`,
      ]),
    ),
  );
}
