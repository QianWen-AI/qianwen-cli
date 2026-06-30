import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../../output/format.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { openBrowser } from '../../../utils/open-browser.js';
import { renderBalanceRechargeInk } from '../../../ui/BillingBalanceRecharge.js';

const RECHARGE_URL = 'https://platform.qianwenai.com/home/billing/overview?target=recharge';

export function registerBillingBalanceRechargeCommand(parent: Command): void {
  const recharge = parent
    .command('recharge')
    .description('Open the recharge page in your browser')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  recharge.action(balanceRechargeAction(recharge));
}

export function balanceRechargeAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    let opened = true;
    try {
      openBrowser(RECHARGE_URL);
    } catch {
      opened = false;
    }

    if (format === 'json') {
      outputJSON({
        rechargeUrl: RECHARGE_URL,
        opened,
        message: opened
          ? 'Recharge page opened in browser'
          : 'Could not open browser automatically',
      });
      return;
    }

    if (format === 'text') {
      if (opened) {
        console.log('Opening recharge page in your browser...');
        console.log(
          'If the browser did not open automatically, copy the link below and open it in your browser:',
        );
      } else {
        console.log('Please copy the link below and open it in your browser:');
      }
      console.log(RECHARGE_URL);
      return;
    }

    await renderBalanceRechargeInk(opened, RECHARGE_URL);
  };
}
