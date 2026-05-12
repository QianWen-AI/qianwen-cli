import type { Command } from 'commander';
import { usageSummaryAction } from './summary.js';
import { usageBreakdownAction } from './breakdown.js';
import { usageFreeTierAction } from './free-tier.js';
import { usagePaygAction } from './payg.js';

export { usageSummaryAction } from './summary.js';
export { usageBreakdownAction } from './breakdown.js';
export { usageFreeTierAction } from './free-tier.js';
export { usagePaygAction } from './payg.js';

/**
 * Register usage command actions onto existing usage subcommands.
 * Called from cli.ts after command structure is defined.
 */
export function registerUsageActions(
  summaryCmd: Command,
  breakdownCmd: Command,
  freeTierCmd: Command,
  paygCmd: Command,
): void {
  summaryCmd.action(usageSummaryAction(summaryCmd));
  breakdownCmd.action(usageBreakdownAction(breakdownCmd));
  freeTierCmd.action(usageFreeTierAction(freeTierCmd));
  paygCmd.action(usagePaygAction(paygCmd));
}
