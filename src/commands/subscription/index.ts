import type { Command } from 'commander';
import { registerSubscriptionStatusCommand } from './status.js';
import { registerSubscriptionOrdersCommand } from './orders.js';
import { registerSubscriptionTokenPlanCommands } from './tokenplan/index.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export function registerSubscriptionCommands(program: Command): void {
  const subscription = program
    .command('subscription')
    .description('Inspect subscription status and orders');

  registerSubscriptionStatusCommand(subscription);
  registerSubscriptionOrdersCommand(subscription);
  registerSubscriptionTokenPlanCommands(subscription);

  const status = subscription.commands.find((c) => c.name() === 'status');
  if (status) {
    addExamples(status, [
      formatCmd('subscription status'),
      formatCmd('subscription status --plan token'),
    ]);
  }

  const orders = subscription.commands.find((c) => c.name() === 'orders');
  if (orders) {
    addExamples(orders, [
      formatCmd('subscription orders'),
      formatCmd('subscription orders --type purchase --page 1 --page-size 10'),
    ]);
  }

  const tokenplan = subscription.commands.find((c) => c.name() === 'tokenplan');
  if (tokenplan) {
    const tpStatus = tokenplan.commands.find((c) => c.name() === 'status');
    if (tpStatus) {
      addExamples(tpStatus, [
        formatCmd('subscription tokenplan status'),
        formatCmd('subscription tokenplan status --format json'),
      ]);
    }
    const tpSeats = tokenplan.commands.find((c) => c.name() === 'seats');
    if (tpSeats) {
      addExamples(tpSeats, [
        formatCmd('subscription tokenplan seats'),
        formatCmd('subscription tokenplan seats --format json'),
      ]);
    }
  }

  subscription.action(() => {
    subscription.outputHelp();
    process.stdout.write('\n');
  });
}
