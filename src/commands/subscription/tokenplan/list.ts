import type { Command } from 'commander';
import { resolveCredentials, isTokenExpired } from '../../../auth/credentials.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { outputJSON, resolveFormatFromCommand } from '../../../output/format.js';
import { renderTextTokenPlanList } from '../../../output/text/tokenplan-list.js';
import { createServices } from '../../../services/index.js';
import { renderTokenPlanListInk } from '../../../ui/TokenPlanList.js';
import { withSpinner } from '../../../ui/spinner.js';
import { registerCommandInterrupt } from '../../../utils/command-interrupt.js';
import { CliError, HandledError, handleError } from '../../../utils/errors.js';
import { buildTokenPlanListViewModel } from '../../../view-models/subscription/tokenplan-list.js';

export function tokenPlanListFailureFor(codes: ReadonlySet<string>): CliError {
  const normalized = new Set(codes);
  if (normalized.has('TIMEOUT')) normalized.add('NETWORK_ERROR');
  const failures = [
    {
      code: 'PROTOCOL_ERROR',
      exitCode: 4,
      message: 'Token Plan catalog response could not be verified.',
    },
    {
      code: 'CONFIG_ERROR',
      exitCode: 4,
      message: 'Token Plan catalog configuration is invalid.',
    },
    {
      code: 'AUTH_REQUIRED',
      exitCode: 2,
      message: 'Token Plan catalog authentication failed. Run: qianwen auth login',
    },
    {
      code: 'NETWORK_ERROR',
      exitCode: 3,
      message: 'Token Plan catalog requests failed. Check your network connection.',
    },
  ] as const;
  const failure = failures.find((candidate) => normalized.has(candidate.code));
  return new CliError(
    failure ?? {
      code: 'CATALOG_UNAVAILABLE',
      exitCode: 1,
      message: 'No Token Plan catalog data could be confirmed.',
    },
  );
}

export function subscriptionTokenPlanListAction(cmd: Command) {
  return async function (this: Command): Promise<void> {
    const current = this ?? cmd;
    const format = resolveFormatFromCommand(current, getEffectiveConfig());
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    const unregister = registerCommandInterrupt(cancel);
    try {
      const options = current.opts<{ edition?: string; billingCycle?: string }>();
      const edition = options.edition ?? 'all';
      const billingCycle = options.billingCycle ?? 'monthly';
      if (edition !== 'all' && edition !== 'individual' && edition !== 'team') {
        throw new CliError({
          code: 'INVALID_ARGUMENT',
          message: '--edition must be all, individual or team.',
          exitCode: 1,
        });
      }
      if (billingCycle !== 'monthly' && billingCycle !== 'quarterly' && billingCycle !== 'yearly') {
        throw new CliError({
          code: 'INVALID_ARGUMENT',
          message: '--billing-cycle must be monthly, quarterly or yearly.',
          exitCode: 1,
        });
      }
      const credentials = resolveCredentials()?.credentials;
      const authenticated = credentials !== undefined && !isTokenExpired(credentials);
      const service = createServices().tokenPlanListService;
      const result = await withSpinner(
        'Fetching Token Plan prices for your account...',
        () =>
          service.getTokenPlanList({
            edition,
            billingCycle,
            authenticated,
            signal: controller.signal,
          }),
        format === 'table' ? 'table' : 'json',
      );
      controller.signal.throwIfAborted();
      const vm = buildTokenPlanListViewModel(result, {
        billingCycleDefaulted: current.getOptionValueSource('billingCycle') === 'default',
      });
      if (format === 'json') outputJSON(vm.data);
      else if (format === 'text') renderTextTokenPlanList(vm);
      else await renderTokenPlanListInk(vm);
      if (result.completeness === 'unknown') {
        const codes = new Set(
          result.sections.flatMap((section) => section.diagnostics.map((entry) => entry.errorCode)),
        );
        handleError(tokenPlanListFailureFor(codes), format);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      if (controller.signal.aborted) {
        handleError(
          new CliError({
            code: 'INTERRUPTED',
            message: 'Token Plan catalog query cancelled.',
            exitCode: 130,
          }),
          format,
        );
      }
      handleError(error, format);
    } finally {
      controller.abort();
      process.off('SIGINT', cancel);
      unregister();
    }
  };
}
