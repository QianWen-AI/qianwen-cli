import { formatTextTable } from '../format.js';
import type { TokenPlanListViewModel } from '../../view-models/subscription/tokenplan-list.js';

export function renderTextTokenPlanList(vm: TokenPlanListViewModel): void {
  const heading = (title: string, border: string) =>
    `${title}${border.repeat(Math.max(1, (process.stdout.columns ?? 80) - title.length))}`;
  console.log(heading('TOKEN PLAN CATALOG', '═'));
  console.log(`SIGNED IN ${vm.data.authenticated ? 'yes' : 'no'}`);
  console.log(`EDITION ${vm.data.edition}`);
  console.log(`BILLING CYCLE ${vm.billingCycleLabel}`);
  for (const section of vm.sections) {
    console.log(`\n${heading(section.title, '─')}`);
    if (section.type || section.subscription || section.subscriptionDetails.length > 0) {
      console.log('\nCURRENT SUBSCRIPTION');
      if (section.type) console.log(`TYPE ${section.type}`);
      if (section.subscription) console.log(section.subscription);
      for (const detail of section.subscriptionDetails) console.log(detail);
    }
    if (section.rows.length > 0 || section.cycleNote) console.log('\nPRICING');
    if (section.rows.length > 0) {
      console.log(
        formatTextTable(
          section.columns.map((column) => column.header),
          section.rows.map((row) => section.columns.map((column) => row[column.key])),
          0,
        ),
      );
    }
    if (section.cycleNote) console.log(section.cycleNote);
    for (const table of section.details) {
      console.log(`\n${table.title}`);
      console.log(
        table.rows.length ? formatTextTable(table.headers, table.rows, 0) : table.emptyMessage,
      );
      if (table.note) console.log(table.note);
    }
    if (section.diagnostics.length > 0) {
      console.log('\nNOTES');
      for (const diagnostic of section.diagnostics) console.log(diagnostic);
    }
  }
  console.log(`\n${vm.note}`);
}
