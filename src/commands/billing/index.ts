import type { Command } from 'commander';
import { registerBillingLimitCommand } from './limit.js';
import { registerBillingBreakdownCommand } from './breakdown.js';
import { registerBillingSummaryCommand } from './summary.js';
import { registerBillingBalanceCommands } from './balance/index.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export function registerBillingCommands(program: Command): void {
  const billing = program
    .command('billing')
    .description('Inspect billing limits, consumption breakdown, trends, and bill summaries');

  registerBillingLimitCommand(billing);
  registerBillingBreakdownCommand(billing);
  registerBillingSummaryCommand(billing);
  registerBillingBalanceCommands(billing);

  const summary = billing.commands.find((c) => c.name() === 'summary');
  if (summary) {
    addExamples(summary, [
      formatCmd('billing summary'),
      formatCmd('billing summary --from 2026-05 --to 2026-05'),
    ]);
  }

  const breakdown = billing.commands.find((c) => c.name() === 'breakdown');
  if (breakdown) {
    addExamples(breakdown, [
      formatCmd('billing breakdown'),
      formatCmd('billing breakdown --group-by model'),
      formatCmd('billing breakdown --group-by api-key --top 20'),
    ]);
  }

  const limit = billing.commands.find((c) => c.name() === 'limit');
  if (limit) {
    addExamples(limit, [formatCmd('billing limit'), formatCmd('billing limit --format json')]);
  }

  billing.action(() => {
    billing.outputHelp();
    process.stdout.write('\n');
  });
}
