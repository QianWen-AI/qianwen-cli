import type {
  SubscriptionStatusViewModel,
  SubscriptionOrdersViewModel,
} from '../../view-models/subscription/index.js';
import { formatTextTable } from '../format.js';
import { formatTokenPlanSeatDetails } from './tokenplan-seat-details.js';

export function renderTextSubscriptionStatus(vm: SubscriptionStatusViewModel): void {
  if (vm.banner) {
    console.log(`  ${vm.banner}`);
    if (vm.diagnostics.length > 0) {
      console.log('');
      console.log('  Details:');
      for (const d of vm.diagnostics) {
        console.log(`    - ${d.errorMessage}`);
      }
    }
    return;
  }

  const editions = vm.sections.filter((section) => section.id.startsWith('tokenplan-'));
  if (editions.length > 0) {
    console.log('  Token Plans');
    for (const section of editions) {
      console.log(`    ${section.title}`);
      for (const field of section.fields)
        console.log(`      ${field.label.padEnd(18)}${field.value}`);
      if (section.id === 'tokenplan-team' && vm.tokenPlanSection?.tiers.length) {
        console.log('      Seat Usage');
        for (const tier of vm.tokenPlanSection.tiers) {
          console.log(`        ${tier.label}`);
          console.log(`          Remaining ${tier.bar}`);
        }
      }
      if (section.id === 'tokenplan-team' && vm.seatDetails) {
        console.log('      Seat Details');
        console.log(
          formatTokenPlanSeatDetails(vm.seatDetails, (process.stdout.columns ?? 80) - 6)
            .split('\n')
            .map((line) => `      ${line}`)
            .join('\n'),
        );
      }
    }
  } else {
    for (const field of vm.fields) console.log(`  ${field.label.padEnd(18)}${field.value}`);
    if (vm.tokenPlanSection) {
      console.log('');
      console.log('  Token Plan');
      console.log(
        `    Status: ${vm.tokenPlanSection.status}    Auto-Renew: ${vm.tokenPlanSection.autoRenew}    Expires: ${vm.tokenPlanSection.expires}`,
      );
      for (const tier of vm.tokenPlanSection.tiers) {
        console.log(`    ${tier.label}`);
        console.log(`      Remaining ${tier.bar}`);
      }
    }
  }

  if (editions.length === 0 && vm.quota) {
    console.log('');
    console.log(`  ${'Quota'.padEnd(18)}${vm.quota.display}`);
    console.log(`  ${''.padEnd(18)}${vm.quota.bar}`);
  }

  if (vm.creditPackSection) {
    console.log('');
    console.log('  Add-on Credit Packs');
    console.log(
      `    ${vm.creditPackSection.count} pack${vm.creditPackSection.count === 1 ? '' : 's'}; total remaining ${vm.creditPackSection.totalRemaining}`,
    );
    for (const pack of vm.creditPackSection.packs) {
      console.log(`    ${pack.id}  ${pack.remaining}  expires ${pack.expires}`);
    }
  }

  if (vm.recentOrdersSection) {
    console.log('');
    console.log(`  Recent Token Plan Orders (latest ${vm.recentOrdersSection.orders.length})`);
    console.log(
      formatTextTable(
        ['Order ID', 'Type', 'Date', 'Amount', 'Status'],
        vm.recentOrdersSection.orders.map((order) => [
          order.id,
          order.typeLabel,
          order.date,
          order.amount,
          order.statusLabel,
        ]),
      ),
    );
  }

  if (vm.footnote) {
    console.log('');
    console.log(`  ${vm.footnote}`);
  }
}

export function renderTextSubscriptionOrders(vm: SubscriptionOrdersViewModel): void {
  if (vm.isEmpty) {
    console.log(`  ${vm.emptyPlaceholder}`);
    return;
  }

  const headers = vm.columns.map((c) => c.header);
  const rows = vm.rows.map((r) => [
    r.orderId,
    r.orderTypeLabel,
    r.orderTime,
    r.amountDisplay,
    r.detailError ? `${r.statusLabel} (detail err)` : r.statusLabel,
  ]);
  console.log(formatTextTable(headers, rows));
  console.log(`  ${vm.pagingNote}`);
  if (vm.diagnostics.length > 0) {
    console.log(`  ${vm.diagnostics.length} detail call(s) failed`);
  }
}
