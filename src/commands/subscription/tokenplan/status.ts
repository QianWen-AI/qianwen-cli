import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON, formatTextTable } from '../../../output/format.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { withSpinner } from '../../../ui/spinner.js';
import { createServices } from '../../../services/index.js';
import { buildTokenPlanStatusViewModel } from '../../../view-models/subscription/tokenplan-status.js';
import { formatSubscriptionStatusJson } from '../../../view-models/subscription/shared.js';
import { renderSubscriptionTokenPlanStatusInk } from '../../../ui/SubscriptionTokenPlanStatus.js';
import { formatTokenPlanSeatDetails } from '../../../output/text/tokenplan-seat-details.js';
import { CliError, handleError, HandledError } from '../../../utils/errors.js';
import type { SubscriptionDiagnostic } from '../../../types/subscription.js';
import type {
  TokenPlanStatusViewModel,
  TokenPlanStatusResult,
} from '../../../types/tokenplan-subscription.js';

function isTotalFailure(result: TokenPlanStatusResult): boolean {
  const hasKnownEdition = [result.individual, result.team].some(
    (edition) => edition?.status === 'active' || edition?.status === 'not_subscribed',
  );
  return (
    !hasKnownEdition &&
    result.seatSummary === null &&
    result.period === null &&
    result.autoRenew === null &&
    result.renewable === null
  );
}

function totalFailureError(diagnostics: SubscriptionDiagnostic[]): CliError {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.errorCode));
  if (codes.has('CONFIG_ERROR') || codes.has('PROTOCOL_ERROR'))
    return new CliError({
      code: 'CONFIG_ERROR',
      message: 'Token Plan status configuration or response protocol is invalid.',
      exitCode: 4,
    });
  if (
    codes.has('AUTH_REQUIRED') ||
    codes.has('TOKEN_EXPIRED') ||
    codes.has('CS_DATA_AUTH_REQUIRED')
  )
    return new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Token Plan status authentication failed. Run: qianwen auth login',
      exitCode: 2,
    });
  if (codes.has('NETWORK_ERROR') || codes.has('Timeout'))
    return new CliError({
      code: 'NETWORK_ERROR',
      message: 'Token Plan status requests failed. Check your network connection.',
      exitCode: 3,
    });
  return new CliError({
    code: 'TOKENPLAN_STATUS_UNAVAILABLE',
    message: 'No Token Plan subscription status could be confirmed.',
    exitCode: 1,
  });
}

export function subscriptionTokenPlanStatusAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      ensureAuthenticated();
      const { subscriptionTokenPlanService } = createServices();
      const result = await withSpinner(
        'Loading Token Plan status',
        () => subscriptionTokenPlanService.getTokenPlanStatus(),
        format,
      );

      if (format === 'json') {
        const vm = buildTokenPlanStatusViewModel(result, 'json');
        const jsonOutput = {
          individual: vm.individual,
          team: vm.team,
          product: vm.product,
          period: vm.period,
          autoRenew: vm.autoRenew,
          renewable: vm.renewable,
          seatSummary: vm.seatSummary,
          diagnostics: vm.diagnostics,
        };
        outputJSON(formatSubscriptionStatusJson(jsonOutput));
        if (isTotalFailure(result)) handleError(totalFailureError(result.diagnostics), format);
        return;
      }

      const outputFormat = format === 'text' ? 'text' : 'tui';
      const vm: TokenPlanStatusViewModel = buildTokenPlanStatusViewModel(result, outputFormat);

      if (format === 'text') {
        renderTextTokenPlanStatus(vm);
      } else {
        await renderSubscriptionTokenPlanStatusInk(vm);
      }
      if (isTotalFailure(result)) handleError(totalFailureError(result.diagnostics), format);
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}

function renderTextTokenPlanStatus(vm: TokenPlanStatusViewModel): void {
  console.log('Token Plan Subscription');
  for (const section of vm.editionSections) {
    console.log(`  ${section.title}`);
    for (const field of section.fields) console.log(`    ${field.label.padEnd(18)}${field.value}`);
  }
  if (vm.header) {
    console.log(`  ${'Product:'.padEnd(14)}${vm.header.product}`);
    console.log(`  ${'Period:'.padEnd(14)}${vm.header.period}`);
    console.log(`  ${'Auto-Renew:'.padEnd(14)}${vm.header.autoRenew}`);
    console.log(`  ${'Renewable:'.padEnd(14)}${vm.header.renewable}`);
  }

  if (vm.seatLines && vm.seatLines.length > 0) {
    console.log('');
    console.log('SEAT SUMMARY');
    console.log('');
    console.log(
      formatTextTable(
        ['SEAT TYPE', 'QUANTITY'],
        vm.seatLines.map((row) => [row.specType, row.seats]),
        0,
      ),
    );
  }

  if (vm.seatDetails) {
    console.log('');
    console.log(vm.seatDetails.title);
    console.log('');
    console.log(formatTokenPlanSeatDetails(vm.seatDetails, process.stdout.columns ?? 80));
  }

  if (vm.warnings && vm.warnings.length > 0) {
    console.log('');
    for (const w of vm.warnings) {
      console.log(`  ${w}`);
    }
  }

  if (vm.footnote) {
    console.log('');
    console.log(`  ${vm.footnote}`);
  }
}
