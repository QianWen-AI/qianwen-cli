import type { Command } from 'commander';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { outputJSON, resolveFormatFromCommand } from '../../../output/format.js';
import { renderTextTokenPlanPurchase } from '../../../output/text/tokenplan-purchase.js';
import { createServices } from '../../../services/index.js';
import type {
  TokenPlanPurchaseInteraction,
  TokenPlanPurchaseDecision,
} from '../../../services/tokenplan-purchase-service.js';
import {
  MAX_TOKEN_PLAN_TEAM_SEATS,
  TOKEN_PLAN_INDIVIDUAL_TYPES,
  TOKEN_PLAN_PURCHASE_TYPES,
  type TokenPlanPurchasePreview,
  type TokenPlanSelection,
} from '../../../types/tokenplan-purchase.js';
import {
  createTokenPlanPurchaseInteraction,
  renderTokenPlanPurchaseResult,
} from '../../../ui/TokenPlanPurchase.js';
import { styleHelpSectionTitle } from '../../../utils/commander-helpers.js';
import { registerCommandInterrupt } from '../../../utils/command-interrupt.js';
import { CliError, HandledError, handleError } from '../../../utils/errors.js';
import { NO_TOKENPLAN_COUPON } from '../../../api/parsers/tokenplan-trade.js';
import { buildTokenPlanPurchaseResult } from '../../../view-models/subscription/tokenplan-purchase.js';
import { getChannelsForScope, SCOPE_TOKENPLAN_PURCHASE } from '../../../config/payment-channels.js';
import { findTokenPlanIndividualTierByType } from '../../../types/tokenplan-tiers.js';

interface PurchaseOptions {
  billingCycle?: string;
  channel?: string;
  standardSeatCount?: string;
  proSeatCount?: string;
  maxSeatCount?: string;
  balanceDeduction?: string;
  autoRenew?: boolean;
  preview?: boolean;
  coupon?: string | false;
  confirm?: boolean;
  previewAmount?: string;
}

function invalid(message: string): never {
  throw new CliError({ code: 'INVALID_ARGUMENT', message, exitCode: 1 });
}

export function parseTokenPlanSelection(
  type: string,
  options: PurchaseOptions,
): TokenPlanSelection {
  const individualTier = findTokenPlanIndividualTierByType(type);
  const edition =
    type === 'token_plan_team'
      ? 'team'
      : individualTier
        ? 'individual'
        : invalid(`Choose ${[...TOKEN_PLAN_INDIVIDUAL_TYPES, 'token_plan_team'].join(', ')}.`);
  const billingCycle = options.billingCycle;
  if (billingCycle === undefined)
    return invalid('--billing-cycle is required. Choose monthly, quarterly or yearly.');
  if (billingCycle !== 'monthly' && billingCycle !== 'quarterly' && billingCycle !== 'yearly')
    return invalid('--billing-cycle must be monthly, quarterly or yearly.');
  if (edition === 'team' && billingCycle === 'quarterly')
    return invalid('Team Token Plan supports monthly or yearly billing only.');
  if (options.channel === undefined)
    return invalid(
      `--channel is required. Supported: ${getChannelsForScope(SCOPE_TOKENPLAN_PURCHASE).join(', ')}.`,
    );
  if (!getChannelsForScope(SCOPE_TOKENPLAN_PURCHASE).includes(options.channel))
    return invalid(
      `--channel only supports: ${getChannelsForScope(SCOPE_TOKENPLAN_PURCHASE).join(', ')}`,
    );
  if (options.autoRenew === undefined)
    return invalid('Choose exactly one of --auto-renew or --no-auto-renew.');
  if (
    options.balanceDeduction !== undefined &&
    !/^(0|[1-9]\d{0,14})(?:\.\d{1,2})?$/.test(options.balanceDeduction)
  )
    return invalid(
      '--balance-deduction must be a non-negative decimal with at most two decimal places.',
    );
  const inputs = [options.standardSeatCount, options.proSeatCount, options.maxSeatCount];
  if (edition === 'individual' && inputs.some((count) => count !== undefined))
    return invalid('Seat-count options are only supported for token_plan_team.');
  if (edition === 'team' && inputs.every((count) => count === undefined))
    return invalid(
      'At least one team seat is required. Use --standard-seat-count, --pro-seat-count or --max-seat-count.',
    );
  const seats =
    edition === 'individual'
      ? [
          {
            specCode: individualTier?.specCode ?? invalid('Unsupported individual Token Plan.'),
            quantity: 1,
          },
        ]
      : inputs
          .map((count, index) => {
            if (count !== undefined && !/^(0|[1-9]\d{0,2})$/.test(count))
              return invalid(
                `Seat counts must be non-negative integers; total seats must be 1..${MAX_TOKEN_PLAN_TEAM_SEATS}.`,
              );
            return { specCode: ['standard', 'pro', 'max'][index], quantity: Number(count ?? '0') };
          })
          .filter((seat) => seat.quantity > 0);
  const total = seats.reduce((sum, seat) => sum + seat.quantity, 0);
  if (total < 1 || total > MAX_TOKEN_PLAN_TEAM_SEATS)
    return invalid(`Total seats must be 1..${MAX_TOKEN_PLAN_TEAM_SEATS}.`);
  return {
    type,
    edition,
    billingCycle,
    seats,
    autoRenew: options.autoRenew,
    balanceDeduction: options.balanceDeduction ?? null,
  };
}

function buildPreviewOutput(preview: TokenPlanPurchasePreview): Record<string, unknown> {
  return {
    type: preview.selection.type,
    edition: preview.selection.edition,
    billingCycle: preview.selection.billingCycle,
    originalAmount: preview.quote.originalAmount,
    planAmount: preview.quote.planAmount,
    promotionDeduction: preview.quote.promotionDeduction,
    couponDeduction: preview.quote.couponDeduction,
    currency: preview.quote.currency,
    availableCoupons: preview.quote.coupons.map((coupon) => ({
      id: coupon.id,
      name: coupon.name,
      ...(coupon.balance !== undefined && { balance: coupon.balance }),
      ...(coupon.faceValue !== undefined && { faceValue: coupon.faceValue }),
      ...(coupon.validUntil !== undefined && { validUntil: coupon.validUntil }),
      ...(coupon.deductionAmount !== undefined && { deductionAmount: coupon.deductionAmount }),
      ...(coupon.recommended !== undefined && { recommended: coupon.recommended }),
    })),
    selectedCoupon: preview.quote.coupon,
    orderAmount: preview.quote.amount,
    accountBalance: preview.balance,
    maxDeduction: preview.maxDeduction,
    deductionValid: preview.deductionValid,
    deductionIntent: preview.deductionIntent,
    fundingPlan: preview.fundingPlan
      ? {
          deductionIntent: preview.fundingPlan.deductionIntent,
          cashDeduction: preview.fundingPlan.cashDeduction,
          externalPayable: preview.fundingPlan.externalPayable,
          paymentMode: preview.fundingPlan.paymentMode,
        }
      : null,
    autoRenew: preview.selection.autoRenew,
    eligibility: {
      subscriptionCheck: 'passed',
      inventoryCheck: 'passed',
      paymentCapability: preview.capabilities.admissionResult,
    },
  };
}

export function createAutoConfirmInteraction(couponId?: string): TokenPlanPurchaseInteraction {
  let couponApplied = false;
  let confirmed = false;
  return {
    async review(previewData: TokenPlanPurchasePreview): Promise<TokenPlanPurchaseDecision> {
      if (previewData.existingOrder || confirmed)
        throw new CliError({
          code: 'TOKENPLAN_PAYMENT_RECONFIRM_REQUIRED',
          message:
            'The confirmed payment plan changed. Automatic confirmation cannot authorize a new plan. Retain any existing order and use read-only recovery.',
          exitCode: 1,
        });
      if (couponId && !couponApplied && couponId !== previewData.quote.coupon) {
        couponApplied = true;
        return { action: 'coupon', coupon: couponId };
      }
      if (!previewData.deductionValid || !previewData.fundingPlan)
        throw new CliError({
          code: 'TOKENPLAN_BALANCE_EXCEEDED',
          message:
            'The requested cash deduction is unavailable. Choose a valid deduction before confirming.',
          exitCode: 1,
        });
      confirmed = true;
      return { action: 'confirm' };
    },
    async payment(): Promise<{ skipPolling: true }> {
      return { skipPolling: true };
    },
  };
}

export function registerPurchaseHelp(purchase: Command): void {
  const descriptionColumn = 36;
  const optionLine = (flags: string, description: string): string =>
    `  ${flags.padEnd(descriptionColumn - 2)}${description}`;
  const detailLine = (text: string): string => `${' '.repeat(descriptionColumn)}${text}`;

  purchase.configureHelp({
    formatHelp: () =>
      [
        styleHelpSectionTitle('Usage:'),
        '  qianwen subscription tokenplan purchase <token-plan-type> \\',
        '    --billing-cycle <cycle> \\',
        '    --channel <channel> \\',
        '    (--auto-renew | --no-auto-renew) [options]',
        '',
        'Purchase an Individual or Team Token Plan.',
        '',
        styleHelpSectionTitle('Arguments:'),
        optionLine('<token-plan-type>', 'Token Plan TYPE returned by'),
        detailLine("'qianwen subscription tokenplan list'"),
        detailLine('Allowed values:'),
        ...TOKEN_PLAN_PURCHASE_TYPES.map((type) => detailLine(`  ${type}`)),
        '',
        styleHelpSectionTitle('Required options:'),
        optionLine('--billing-cycle <cycle>', 'Billing cycle for the subscription'),
        detailLine('Individual: monthly, quarterly, yearly'),
        detailLine('Team: monthly, yearly'),
        '',
        optionLine('--channel <channel>', 'Payment channel'),
        detailLine(`Supported: ${getChannelsForScope(SCOPE_TOKENPLAN_PURCHASE).join(', ')}`),
        '',
        '  Renewal option (choose one):',
        optionLine('  --auto-renew', 'Renew automatically at the end of the'),
        detailLine('selected billing cycle'),
        optionLine('  --no-auto-renew', 'Do not renew automatically'),
        '',
        styleHelpSectionTitle('Team seat options:'),
        optionLine('--standard-seat-count <count>', 'Number of Standard Seats'),
        optionLine('--pro-seat-count <count>', 'Number of Pro Seats'),
        optionLine('--max-seat-count <count>', 'Number of Max Seats'),
        '',
        styleHelpSectionTitle('Output options:'),
        optionLine('--format <fmt>', 'Output format: table, json, text'),
        detailLine('(default: auto)'),
        '',
        styleHelpSectionTitle('Agent and Skill options:'),
        '  For controlled Agent and Skill automation only.',
        '',
        optionLine('--preview', 'Preview purchasable configuration as JSON'),
        detailLine('without creating an order.'),
        optionLine('--confirm', 'Skip interactive review and confirm; requires'),
        detailLine('an explicit coupon choice, balance deduction,'),
        detailLine('and preview amount.'),
        optionLine('--preview-amount <amount>', 'Expected amount returned by --preview;'),
        detailLine('required with --confirm and rejects quote changes.'),
        optionLine('--coupon <coupon-id>', 'Select a specific coupon by ID.'),
        optionLine('--no-coupon', 'Do not apply any coupon.'),
        optionLine('--balance-deduction <amount>', 'Account balance deduction in CNY.'),
        detailLine('Required with --confirm; use 0 for no deduction.'),
        '',
        '  --preview and --confirm cannot be combined.',
        '  --coupon and --no-coupon cannot be combined.',
        '  --confirm requires --coupon or --no-coupon, --balance-deduction,',
        '  and --preview-amount.',
        '',
        styleHelpSectionTitle('For token_plan_team:'),
        '  At least one seat count must be 1 or greater.',
        '  Omitted seat types are treated as 0.',
        '  Counts must be non-negative whole numbers.',
        `  The total number of seats cannot exceed ${MAX_TOKEN_PLAN_TEAM_SEATS}.`,
        '',
        '  Team seat options cannot be used with Individual Token Plans.',
        '',
        styleHelpSectionTitle('Interactive steps:'),
        '  After the Token Plan configuration is validated, the backend selects',
        '  a default applicable coupon and returns the initial quote.',
        '',
        '  If the remaining amount due is greater than 0, the maximum eligible',
        '  account balance is applied by default. The user may change the balance',
        '  deduction before payment.',
        '',
        '  If the coupon covers the full plan amount, the balance deduction is',
        '  set to 0 and cannot be changed.',
        '',
        '  Available coupons are displayed only when the user chooses to change',
        '  or remove the selected coupon.',
        '',
        styleHelpSectionTitle('Examples:'),
        '  qianwen subscription tokenplan purchase \\',
        '    token_plan_individual_standard \\',
        '    --billing-cycle quarterly \\',
        '    --channel alipay \\',
        '    --no-auto-renew',
        '',
        '  qianwen subscription tokenplan purchase \\',
        '    token_plan_team \\',
        '    --billing-cycle yearly \\',
        '    --channel alipay \\',
        '    --standard-seat-count 2 \\',
        '    --max-seat-count 1 \\',
        '    --auto-renew',
      ]
        .map((line) => (line === '' ? line : `  ${line}`))
        .join('\n') + '\n',
  });
}

export function subscriptionTokenPlanPurchaseAction(cmd: Command) {
  return async function (this: Command, type: string): Promise<void> {
    const current = this ?? cmd;
    const opts = current.opts<PurchaseOptions>();
    const isPreview = opts.preview === true;
    const isConfirm = opts.confirm === true;
    const isNoCoupon = opts.coupon === false;
    const isAgentMode = isPreview || isConfirm;

    // --preview and --confirm are mutually exclusive
    if (isPreview && isConfirm) invalid('--preview and --confirm are mutually exclusive.');

    // --preview-amount requires --confirm
    if (opts.previewAmount !== undefined && !isConfirm)
      throw new CliError({
        code: 'TOKENPLAN_INVALID_OPTIONS',
        message: '--preview-amount requires --confirm.',
        exitCode: 1,
      });

    // --preview-amount format validation (same as --balance-deduction)
    if (
      opts.previewAmount !== undefined &&
      !/^(0|[1-9]\d{0,14})(?:\.\d{1,2})?$/.test(opts.previewAmount)
    )
      invalid('--preview-amount must be a non-negative decimal with at most two decimal places.');

    // Resolve coupon ID: --no-coupon → sentinel, --coupon → explicit, else undefined
    const couponId = isNoCoupon
      ? NO_TOKENPLAN_COUPON
      : typeof opts.coupon === 'string'
        ? opts.coupon
        : undefined;
    const previewAmount = opts.previewAmount;

    // Agent modes default to json format
    let format = resolveFormatFromCommand(current, getEffectiveConfig());
    if (isAgentMode && format !== 'json') format = 'json';

    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    const unregister = registerCommandInterrupt(cancel);
    try {
      const selection = parseTokenPlanSelection(type, opts);
      let root = current;
      while (root.parent) root = root.parent;
      const rawArgs: unknown = Reflect.get(root, 'rawArgs');
      const parsedArgs = Array.isArray(rawArgs)
        ? rawArgs.filter((value): value is string => typeof value === 'string')
        : [];
      const flags = parsedArgs.slice(
        0,
        parsedArgs.indexOf('--') < 0 ? undefined : parsedArgs.indexOf('--'),
      );
      if (
        flags.includes('--no-coupon') &&
        flags.some((flag) => flag === '--coupon' || flag.startsWith('--coupon='))
      )
        invalid('--coupon and --no-coupon are mutually exclusive.');
      if (flags.includes('--auto-renew') && flags.includes('--no-auto-renew'))
        invalid('--auto-renew and --no-auto-renew cannot be combined.');
      if (isConfirm && couponId === undefined)
        invalid('--confirm requires exactly one of --coupon <coupon-id> or --no-coupon.');
      if (isConfirm && opts.balanceDeduction === undefined)
        invalid(
          '--confirm requires --balance-deduction <amount>; pass 0 to disable balance deduction.',
        );
      if (isConfirm && previewAmount === undefined)
        invalid(
          '--confirm requires --preview-amount <amount> from the preceding --preview result.',
        );

      // TTY check: skip for --preview (read-only) and --confirm (non-interactive)
      if (!isAgentMode && (!process.stdin.isTTY || !process.stdout.isTTY))
        throw new CliError({
          code: 'TTY_REQUIRED',
          message:
            'Token Plan purchase requires interactive stdin and stdout in every output format.',
          exitCode: 2,
        });

      ensureAuthenticated();
      controller.signal.throwIfAborted();

      const onQuoteStart = () => {
        const stream = format === 'json' ? process.stderr : process.stdout;
        stream.write('Preparing Token Plan quote...\n');
      };

      if (isPreview) {
        // Preview mode: get quote data and output JSON, no order creation
        // --preview-amount is ignored in --preview mode
        const services = createServices();
        const previewData = await services.tokenPlanPurchaseService.preview(
          selection,
          couponId,
          controller.signal,
          onQuoteStart,
        );
        outputJSON(buildPreviewOutput(previewData));
        return;
      }

      // Normal or --confirm mode
      const interaction = isConfirm
        ? createAutoConfirmInteraction(couponId)
        : createTokenPlanPurchaseInteraction(format, cancel);
      const outcome = await createServices().tokenPlanPurchaseService.purchase(
        selection,
        { ...interaction, onQuoteStart },
        controller.signal,
        isConfirm ? previewAmount : undefined,
        couponId,
      );

      const vm = buildTokenPlanPurchaseResult(outcome.result);
      if (format === 'json') outputJSON(vm.data);
      else if (format === 'text') renderTextTokenPlanPurchase(vm);
      else await renderTokenPlanPurchaseResult(vm);
      if (outcome.result.status === 'cancelled' && outcome.exitCode !== 0)
        throw new HandledError(outcome.exitCode);
      if (outcome.error) handleError(outcome.error, format);
      else if (outcome.exitCode !== 0) throw new HandledError(outcome.exitCode);
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(
        controller.signal.aborted
          ? new CliError({
              code: 'INTERRUPTED',
              message: 'Token Plan purchase interrupted.',
              exitCode: 130,
            })
          : error,
        format,
      );
    } finally {
      controller.abort();
      process.off('SIGINT', cancel);
      unregister();
    }
  };
}
