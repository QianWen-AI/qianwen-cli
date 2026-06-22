import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../../output/format.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { withSpinner } from '../../../ui/spinner.js';
import { createServices } from '../../../services/index.js';
import { buildTokenPlanSeatsViewModel } from '../../../view-models/subscription/tokenplan-seats.js';
import { renderSubscriptionTokenPlanSeatsInk } from '../../../ui/SubscriptionTokenPlanSeats.js';
import { handleError, CliError } from '../../../utils/errors.js';
import { EXIT_CODES } from '../../../utils/exit-codes.js';
import type {
  ListTokenPlanSeatsParams,
  TokenPlanSeatsViewModel,
} from '../../../types/tokenplan-subscription.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const VALID_SPEC_TYPES = ['pro', 'standard'] as const;

function parseIntOption(value: string): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : NaN;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function hasOption(cmd: Command, flag: string): boolean {
  // Commander stores options on the command; treat absence as false.
  const opts = (cmd as unknown as { options?: Array<{ long?: string }> }).options;
  if (!Array.isArray(opts)) return false;
  return opts.some((o) => o && o.long === flag);
}

/**
 * Register the seats command flags on the given Commander command.
 * Idempotent — safe to invoke multiple times against the same command.
 */
function ensureOptions(cmd: Command): void {
  if (!hasOption(cmd, '--spec-type')) {
    cmd.option('--spec-type <type>', 'Filter by seat spec type: pro, standard');
  }
  if (!hasOption(cmd, '--page')) {
    cmd.option('--page <n>', 'Page number (1-based)', parseIntOption);
  }
  if (!hasOption(cmd, '--page-size')) {
    cmd.option('--page-size <n>', 'Page size (max 100)', parseIntOption);
  }
  if (!hasOption(cmd, '--format')) {
    cmd.option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  }
}

/**
 * Walk up the command chain to detect whether --format was explicitly set.
 * The standard resolver auto-detects format from TTY when no flag is given,
 * which for non-TTY environments collapses to 'json'. This command's UX
 * contract treats TUI as the default when no explicit format is requested,
 * so we check for the flag separately before falling back to TUI.
 */
function hasExplicitFormatFlag(cmd: Command | null | undefined): boolean {
  let current: Command | null = cmd ?? null;
  while (current) {
    const opts = current.opts() as Record<string, unknown>;
    if (typeof opts.format === 'string' && opts.format.length > 0) return true;
    current = current.parent ?? null;
  }
  return false;
}

export function subscriptionTokenPlanSeatsAction(cmd: Command) {
  ensureOptions(cmd);

  return async function (this: Command) {
    const config = getEffectiveConfig();
    const scope = this ?? cmd;
    const format = hasExplicitFormatFlag(scope) ? resolveFormatFromCommand(scope, config) : 'table';
    const options = scope.opts() as Record<string, unknown>;

    const page = clamp(options?.page, 1, 10_000, DEFAULT_PAGE);
    const pageSize = clamp(options?.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    let specType: string | undefined;
    if (typeof options?.specType === 'string' && options.specType.length > 0) {
      const normalized = options.specType.toLowerCase();
      if (!(VALID_SPEC_TYPES as readonly string[]).includes(normalized)) {
        handleError(
          new CliError({
            code: 'INVALID_ARGUMENT',
            message: `--spec-type must be one of: ${VALID_SPEC_TYPES.join(', ')}`,
            exitCode: EXIT_CODES.GENERAL_ERROR,
          }),
          format,
        );
        return;
      }
      specType = normalized;
    }

    try {
      ensureAuthenticated();
      const { subscriptionTokenPlanService } = createServices();

      const params: ListTokenPlanSeatsParams = { page, pageSize };
      if (specType) params.specType = specType;

      const result = await withSpinner(
        'Loading Token Plan seats',
        () => subscriptionTokenPlanService.listTokenPlanSeats(params),
        format,
      );

      const totalPages =
        result.page.size > 0 && result.page.total > 0
          ? Math.ceil(result.page.total / result.page.size)
          : 1;

      if (format === 'json') {
        if (page > totalPages && totalPages > 0) {
          process.stderr.write(
            `Warning: Requested page ${page} exceeds total pages (${totalPages}). No results to display.\n`,
          );
        }
        const vm = buildTokenPlanSeatsViewModel(result, 'json');
        outputJSON({
          page: vm.page,
          filter: vm.filter,
          items: vm.items,
          diagnostics: vm.diagnostics,
        });
        return;
      }

      // Non-JSON modes (table/text/TUI) auto-clamp to the last page when the
      // requested page overflows, so users never see an empty viewport.
      let displayResult = result;
      if (result.items.length === 0 && result.page.total > 0 && page > totalPages) {
        process.stderr.write(
          `Warning: Requested page ${page} exceeds total pages (${totalPages}), starting from last page.\n`,
        );
        const clampedParams: ListTokenPlanSeatsParams = { ...params, page: totalPages };
        displayResult = await subscriptionTokenPlanService.listTokenPlanSeats(clampedParams);
      }

      const outputFormat = format === 'text' ? 'text' : 'tui';
      const vm: TokenPlanSeatsViewModel = buildTokenPlanSeatsViewModel(displayResult, outputFormat);

      if (format === 'text') {
        renderTextTokenPlanSeats(vm);
      } else {
        await renderSubscriptionTokenPlanSeatsInk(vm);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}

function renderTextTokenPlanSeats(vm: TokenPlanSeatsViewModel): void {
  const header = vm.header;
  if (header) {
    console.log(`Token Plan Seats (Total: ${header.total}, Filter: ${header.filter})`);
  } else {
    console.log('Token Plan Seats');
  }
  console.log('');

  const rows = vm.rows ?? [];
  if (rows.length === 0) {
    console.log(`  ${vm.emptyPlaceholder ?? 'No seats found.'}`);
  } else {
    for (const row of rows) {
      const cycle = `${row.totalValue} / ${row.surplusValue}`;
      console.log(
        `  ${row.instanceCode.padEnd(20)} ${row.specType.padEnd(10)} ${row.status.padEnd(8)} ${cycle.padEnd(24)} ${row.assignment}`,
      );
    }
  }

  if (vm.footer) {
    console.log('');
    console.log(vm.footer.pagination);
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
