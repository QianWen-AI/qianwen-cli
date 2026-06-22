import type {
  SubscriptionStatusViewModel,
  SubscriptionOrdersViewModel,
} from '../../view-models/subscription/index.js';
import { formatTextTable } from '../format.js';

export function renderTextSubscriptionStatus(vm: SubscriptionStatusViewModel): void {
  if (vm.banner) {
    console.log(`  ${vm.banner}`);
    if (vm.diagnostics.length > 0) {
      console.log('');
      console.log('  Diagnostics:');
      for (const d of vm.diagnostics) {
        console.log(`    - ${d.api}: ${d.errorCode} ${d.errorMessage}`);
      }
    }
    return;
  }

  for (const f of vm.fields) {
    console.log(`  ${f.label.padEnd(18)}${f.value}`);
  }

  if (vm.quota) {
    console.log('');
    console.log(`  ${'Quota'.padEnd(18)}${vm.quota.display}`);
    console.log(`  ${''.padEnd(18)}${vm.quota.bar}`);
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
