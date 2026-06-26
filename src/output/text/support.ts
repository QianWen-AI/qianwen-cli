import type { SupportListViewModel } from '../../view-models/support/index.js';
import type { SupportViewViewModel } from '../../view-models/support/index.js';
import { formatTextTable } from '../text.js';

export function renderTextSupportList(vm: SupportListViewModel): void {
  if (vm.isEmpty) {
    console.log(`  ${vm.emptyMessage}`);
    return;
  }

  const headers = ['ID', 'Title', 'Status', 'Created'];
  const rows = vm.tickets.map((t) => [t.id, t.title, t.status, t.createdAt]);

  console.log(formatTextTable(headers, rows));
  console.log(`  ${vm.total} tickets  ·  Page ${vm.page} of ${vm.totalPages}`);
}

export function renderTextSupportView(vm: SupportViewViewModel): void {
  const t = vm.ticket;
  console.log(`  Ticket ${t.id}`);
  console.log(`  Title:       ${t.title}`);
  console.log(`  Status:      ${t.status}`);
  console.log(`  Category:    ${t.category}`);
  console.log(`  Created:     ${t.createdAt}`);
  console.log('');
  console.log(`  Description:`);
  console.log(`    ${t.description}`);

  if (vm.messageCount > 0) {
    console.log('');
    console.log(`  Messages (${vm.messageCount}):`);
    for (const msg of vm.messages) {
      const speaker = msg.nickName ? `${msg.displayRole} · ${msg.nickName}` : msg.displayRole;
      console.log(`    [${msg.createdAt}] ${speaker}`);
      console.log(`      ${msg.content}`);
    }
    if (vm.truncated) {
      console.log('    (Showing latest 100 messages)');
    }
  }
}
