import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON, formatTextTable } from '../../../output/format.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { withSpinner } from '../../../ui/spinner.js';
import { createServices } from '../../../services/index.js';
import {
  buildTokenPlanStatusViewModel,
  type TokenPlanStatusViewModel,
} from '../../../view-models/subscription/tokenplan-status.js';
import { formatSubscriptionStatusJson } from '../../../view-models/subscription/shared.js';
import { renderSubscriptionTokenPlanStatusInk } from '../../../ui/SubscriptionTokenPlanStatus.js';
import { CliError, handleError, HandledError } from '../../../utils/errors.js';
import type { SubscriptionDiagnostic } from '../../../types/subscription.js';
import type { TokenPlanStatusResult } from '../../../types/tokenplan-subscription.js';
import { registerCommandInterrupt } from '../../../utils/command-interrupt.js';

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
    const current = this ?? cmd;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    const unregister = registerCommandInterrupt(cancel);

    try {
      const edition = current.opts<{ edition?: string }>().edition ?? 'all';
      if (edition !== 'all' && edition !== 'individual' && edition !== 'team') {
        throw new CliError({
          code: 'INVALID_ARGUMENT',
          message: '--edition must be all, individual or team.',
          exitCode: 4,
        });
      }
      ensureAuthenticated();
      const { subscriptionTokenPlanService } = createServices();
      const result = await withSpinner(
        'Loading Token Plan status',
        () =>
          subscriptionTokenPlanService.getTokenPlanStatus({ edition, signal: controller.signal }),
        format === 'text' ? 'json' : format,
      );
      controller.signal.throwIfAborted();

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
      controller.signal.throwIfAborted();
      if (isTotalFailure(result)) handleError(totalFailureError(result.diagnostics), format);
    } catch (error) {
      if (error instanceof HandledError) throw error;
      if (controller.signal.aborted)
        handleError(
          new CliError({
            code: 'INTERRUPTED',
            message: 'Token Plan status query cancelled.',
            exitCode: 130,
          }),
          format,
        );
      handleError(error, format);
    } finally {
      controller.abort();
      process.off('SIGINT', cancel);
      unregister();
    }
  };
}

function renderTextTokenPlanStatus(vm: TokenPlanStatusViewModel): void {
  const indent = (value: string) =>
    value
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
  const renderTables = (tables: TokenPlanStatusViewModel['detailTables']) => {
    for (const table of tables ?? []) {
      console.log(`\n    ${table.title}`);
      console.log(
        table.rows.length
          ? formatTextTable(table.headers, table.rows, 4)
          : indent(table.emptyMessage),
      );
      if (table.note) console.log(indent(table.note));
    }
  };
  console.log('TOKEN PLAN STATUS');
  for (const [index, section] of vm.editionSections.entries()) {
    if (index > 0) console.log('');
    console.log(`  ${section.title}`);
    for (const field of section.fields) console.log(`    ${field.label.padEnd(18)}${field.value}`);
    renderTables(section.detailTables);
    if (section.purchaseHint) console.log(indent(section.purchaseHint));
  }
  if (vm.editionSections.length === 0) {
    if (vm.header) {
      console.log(`  ${'Product:'.padEnd(14)}${vm.header.product}`);
      console.log(`  ${'Period:'.padEnd(14)}${vm.header.period}`);
      console.log(`  ${'Auto-Renew:'.padEnd(14)}${vm.header.autoRenew}`);
      console.log(`  ${'Renewable:'.padEnd(14)}${vm.header.renewable}`);
    }
    renderTables(vm.detailTables);
  }
  if (vm.warnings && vm.warnings.length > 0) {
    console.log('');
    for (const warning of vm.warnings) console.log(`  ${warning}`);
  }
  if (vm.footnote) {
    console.log('');
    console.log(`  ${vm.footnote}`);
  }
}
