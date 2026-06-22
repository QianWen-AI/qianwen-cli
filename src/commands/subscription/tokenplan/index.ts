import type { Command } from 'commander';
import { subscriptionTokenPlanStatusAction } from './status.js';
import { subscriptionTokenPlanSeatsAction } from './seats.js';

export function registerSubscriptionTokenPlanCommands(parent: Command): void {
  const tokenplan = parent.command('tokenplan').description('Token Plan team subscription details');

  registerTokenPlanStatusCommand(tokenplan);
  registerTokenPlanSeatsCommand(tokenplan);

  tokenplan.action(() => {
    tokenplan.outputHelp();
    process.stdout.write('\n');
  });
}

function registerTokenPlanStatusCommand(parent: Command): void {
  const status = parent
    .command('status')
    .description('Show seat-type breakdown and renewal status')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  status.action(subscriptionTokenPlanStatusAction(status));
}

function registerTokenPlanSeatsCommand(parent: Command): void {
  const seats = parent.command('seats').description('List Token Plan seat instances');

  // Flags are registered by subscriptionTokenPlanSeatsAction (idempotent).
  seats.action(subscriptionTokenPlanSeatsAction(seats));
}
