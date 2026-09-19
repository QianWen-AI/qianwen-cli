/**
 * `skills search` — keyword search against SkillHub (SearchHub action).
 *
 * Routes to SkillsHubService through the service container, then fans the
 * result out to the three rendering modes. Anonymous calls are allowed
 * (auth is optional). Exit codes follow the README contract:
 * 1 = invalid argument or general failure, 2 = auth failure with
 * credentials attached, 3 = network / API error.
 */

import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildSkillsSearchViewModel } from '../../view-models/skills/index.js';
import { renderTextSkillsSearch } from '../../output/text/skills.js';
import { renderSkillsSearchInk } from '../../ui/SkillsSearchTable.js';
import { handleError, CliError, invalidArgError } from '../../utils/errors.js';
import { classifyHttpError } from '../../utils/api-errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

/**
 * README exit-code alignment: auth-class codes exit 2, network/API-class
 * codes exit 3. AUTH_REQUIRED/TOKEN_EXPIRED (2) and NETWORK_ERROR (3)
 * already match the global EXIT_CODES table and pass through unchanged;
 * SERVER_ERROR/RATE_LIMITED/API_ERROR carry other global values and are
 * normalized here at the command boundary — global codes untouched.
 */
const SKILLS_EXIT_BY_CODE: Record<string, 2 | 3> = {
  AUTH_REQUIRED: 2,
  TOKEN_EXPIRED: 2,
  NETWORK_ERROR: 3,
  SERVER_ERROR: 3,
  RATE_LIMITED: 3,
  API_ERROR: 3,
};

export function toSkillsCliError(error: unknown): CliError {
  const cliError = error instanceof CliError ? error : classifyHttpError(error);
  const mapped = SKILLS_EXIT_BY_CODE[cliError.code];
  if (mapped === undefined || mapped === cliError.exitCode) return cliError;
  return new CliError({
    code: cliError.code,
    message: cliError.message,
    exitCode: mapped,
    ...(cliError.detail ? { detail: cliError.detail } : {}),
  });
}

type LimitParse = { ok: true; value: number } | { ok: false; message: string };

/**
 * Strict --limit validation on the raw option string (no commander coercion):
 * non-integers (`abc`, `1.5`) and out-of-range values are exit-1 argument
 * errors with exact wording on stderr.
 */
export function parseLimit(raw: unknown): LimitParse {
  if (raw === undefined || raw === null) return { ok: true, value: DEFAULT_LIMIT };
  const s = String(raw).trim();
  if (!/^[+-]?\d+$/.test(s)) {
    return { ok: false, message: '--limit must be an integer.' };
  }
  const n = parseInt(s, 10);
  if (n < MIN_LIMIT || n > MAX_LIMIT) {
    return { ok: false, message: `--limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}.` };
  }
  return { ok: true, value: n };
}

export function skillsSearchAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (
    this: Command,
    query: string | undefined,
    options: Record<string, unknown>,
  ) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    // Argument validation happens before any I/O — usage errors exit 1.
    // json gets the structured handleError payload; text/table keep the
    // exact plain-text wording on stderr (no "Error:" prefix).
    const parsed = parseLimit(options.limit);
    if (!parsed.ok) {
      if (format === 'json') handleError(invalidArgError(parsed.message), format);
      process.stderr.write(parsed.message + '\n');
      process.exitCode = EXIT_CODES.GENERAL_ERROR;
      return;
    }

    try {
      // Empty query is accepted and passed through verbatim (find-skills usage).
      const q = query ?? '';
      const { skillsHubService } = createServices();
      const data = await withSpinner(
        'Searching skills',
        () => skillsHubService.searchSkills({ query: q, limit: parsed.value }),
        format,
      );

      if (format === 'json') {
        // Output shape: { query, results } — empty results ⇒ [].
        outputJSON({ query: data.query, results: data.results });
        return;
      }

      const vm = buildSkillsSearchViewModel(data);

      if (format === 'text') {
        renderTextSkillsSearch(vm);
        return;
      }

      if (vm.isEmpty) {
        console.log('No skills found.');
        return;
      }
      await renderSkillsSearchInk(vm);
    } catch (error) {
      handleError(toSkillsCliError(error), format);
    }
  };
}

export function registerSkillsSearchCommand(parent: Command): Command {
  const search = parent
    .command('search [query]')
    .description('Search SkillHub for skills by keyword')
    // No parseInt coercion: parseLimit validates the raw string (exit 1 contract).
    .option(
      '--limit <n>',
      `Number of results (${MIN_LIMIT}..${MAX_LIMIT}, default ${DEFAULT_LIMIT})`,
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  search.action(skillsSearchAction(search));
  return search;
}
