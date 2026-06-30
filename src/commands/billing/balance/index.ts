import type { Command } from 'commander';
import { registerBillingBalanceSummaryCommand } from './summary.js';
import { registerBillingBalanceRechargeCommand } from './recharge.js';

export function registerBillingBalanceCommands(parent: Command): void {
  const balance = parent
    .command('balance')
    .description('Account balance and recharge');

  registerBillingBalanceSummaryCommand(balance);
  registerBillingBalanceRechargeCommand(balance);

  balance.action(() => {
    balance.outputHelp();
    process.stdout.write('\n');
  });
}
