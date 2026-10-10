import { Option, type Command } from 'commander';
import { subscriptionTokenPlanStatusAction } from './status.js';
import { subscriptionTokenPlanSeatsAction } from './seats.js';
import { subscriptionTokenPlanListAction } from './list.js';
import { registerPurchaseHelp, subscriptionTokenPlanPurchaseAction } from './purchase.js';
import { subscriptionTokenPlanPaymentResultAction } from './payment-result.js';
import { addCommandErrorSupplement, addExamples } from '../../../utils/commander-helpers.js';
import { formatCmd } from '../../../utils/runtime-mode.js';
import { getChannelsForScope, SCOPE_TOKENPLAN_PURCHASE } from '../../../config/payment-channels.js';
import { TOKEN_PLAN_PURCHASE_TYPES } from '../../../types/tokenplan-purchase.js';

export function registerSubscriptionTokenPlanCommands(parent: Command): void {
  const tokenplan = parent.command('tokenplan').description('Token Plan subscription details');

  const list = tokenplan
    .command('list')
    .usage('[flags]')
    .helpOption('-h, --help', 'Show this help')
    .description('List Token Plan prices and availability for your account.')
    .option(
      '--edition <edition>',
      'Edition to display: all, individual, team (default: all)',
      'all',
    )
    .option(
      '--billing-cycle <cycle>',
      'Billing cycle to display. Individual: monthly, quarterly, yearly. Team: monthly, yearly (default: monthly)',
      'monthly',
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .addHelpText(
      'after',
      '\n  You can view Token Plan prices without logging in.\n  Log in to also view your subscription status and account-specific availability.\n  Availability shown here is for reference. Your eligibility will be verified again before purchase.',
    );
  list.action(subscriptionTokenPlanListAction(list));

  const allowedTypes = [
    'Allowed values:',
    ...TOKEN_PLAN_PURCHASE_TYPES.map((type) => `  ${type}`),
  ].join('\n');
  const purchase = tokenplan
    .command('purchase')
    .helpOption('-h, --help', 'Show this help')
    .argument(
      '<token-plan-type>',
      `Token Plan TYPE returned by 'qianwen subscription tokenplan list'\n${allowedTypes}`,
    )
    .description(`Purchase an Individual or Team Token Plan.\n${allowedTypes}`)
    .option(
      '--billing-cycle <cycle>',
      'Billing cycle for the subscription (required). Individual: monthly, quarterly, yearly. Team: monthly, yearly',
    )
    .option(
      '--channel <channel>',
      `Payment channel (required). Supported: ${getChannelsForScope(SCOPE_TOKENPLAN_PURCHASE).join(', ')} (user-scanned QR). No QR is needed when cash covers the total.`,
    )
    .option('--standard-seat-count <count>', 'Number of Standard Seats')
    .option('--pro-seat-count <count>', 'Number of Pro Seats')
    .option('--max-seat-count <count>', 'Number of Max Seats')
    .addOption(
      new Option(
        '--balance-deduction <amount>',
        'Account balance to apply after the coupon deduction. Required by --confirm; use 0 for no deduction.',
      ).hideHelp(),
    )
    .option('--auto-renew', 'Renew automatically at the end of the selected billing cycle')
    .option('--no-auto-renew', 'Do not renew automatically')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .addOption(
      new Option(
        '--preview',
        'Preview available options without executing purchase (returns JSON)',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--coupon <coupon-id>',
        'Select a specific coupon by ID (skip coupon selection prompt)',
      ).hideHelp(),
    )
    .addOption(new Option('--no-coupon', 'Do not apply any coupon').hideHelp())
    .addOption(
      new Option(
        '--confirm',
        'Skip interactive confirmation after explicitly selecting coupon, balance deduction, and preview amount',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--preview-amount <amount>',
        'Expected order amount from preview (required by --confirm; rejects if actual quote differs)',
      ).hideHelp(),
    );
  registerPurchaseHelp(purchase);
  addCommandErrorSupplement(purchase, {
    code: 'commander.missingArgument',
    message: "error: missing required argument 'token-plan-type'",
    supplement: `\nAllowed values for 'token-plan-type':\n${TOKEN_PLAN_PURCHASE_TYPES.map((type) => `  ${type}`).join('\n')}`,
  });
  purchase.action(subscriptionTokenPlanPurchaseAction(purchase));

  const paymentResult = tokenplan
    .command('payment-result', { hidden: true })
    .helpOption('-h, --help', 'Show this help')
    .argument('<order-id>', 'Trusted paymentOrderId returned by Token Plan purchase')
    .description('Query the payment result of a known payment order (read-only, internal)')
    .option('--wait', 'Poll every 3 seconds until the deadline')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .addHelpText(
      'after',
      [
        '',
        '  Queries once by default. --wait continues until the payment reaches a terminal state.',
        '  Does not create orders, initiate payment, or confirm subscription activation.',
        '  An interactive terminal is not required.',
      ].join('\n'),
    );
  addExamples(paymentResult, [
    formatCmd('subscription tokenplan payment-result <order-id>'),
    formatCmd('subscription tokenplan payment-result <order-id> --wait'),
  ]);
  paymentResult.action(subscriptionTokenPlanPaymentResultAction(paymentResult));

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
    .description('Show individual and team subscription status with seat-type breakdown')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  status.action(subscriptionTokenPlanStatusAction(status));
}

function registerTokenPlanSeatsCommand(parent: Command): void {
  const seats = parent.command('seats').description('List Token Plan seat instances');

  // Flags are registered by subscriptionTokenPlanSeatsAction (idempotent).
  seats.action(subscriptionTokenPlanSeatsAction(seats));
}
