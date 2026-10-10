import { formatTextTable } from '../format.js';
import type { TokenPlanListViewModel } from '../../view-models/subscription/tokenplan-list.js';

export function renderTextTokenPlanList(vm: TokenPlanListViewModel): void {
  console.log(`EDITION        ${vm.data.edition}`);
  console.log(`BILLING CYCLE  ${vm.billingCycleLabel}`);
  for (const section of vm.sections) {
    console.log(`\n${section.title}`);
    if (section.type) console.log(`TYPE  ${section.type}`);
    if (section.subscription) console.log(section.subscription);
    for (const detail of section.subscriptionDetails) console.log(detail);
    if (section.cycleNote) console.log(section.cycleNote);
    if (section.rows.length > 0) {
      console.log(
        formatTextTable(
          section.columns.map((column) => column.header),
          section.rows.map((row) => section.columns.map((column) => row[column.key])),
        ),
      );
    }
    for (const diagnostic of section.diagnostics) console.log(diagnostic);
  }
  console.log(`\n${vm.note}`);
}
