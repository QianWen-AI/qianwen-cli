import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { EXHIBITOR_FILTER_KEYS, FORUM_FILTER_KEYS } from '../../services/yunqi-service.js';
import {
  buildExhibitorListViewModel,
  buildForumListViewModel,
  buildForumSubscriptionListViewModel,
  buildForumSummaryListViewModel,
} from '../../view-models/yunqi/index.js';
import { renderYunqiForumListInk } from '../../ui/YunqiForumList.js';
import { renderYunqiExhibitorListInk } from '../../ui/YunqiExhibitorList.js';
import { renderYunqiSubscriptionListInk } from '../../ui/YunqiSubscriptionList.js';
import { renderYunqiForumSummaryListInk } from '../../ui/YunqiForumSummaryList.js';
import {
  renderTextExhibitorList,
  renderTextForumList,
  renderTextSubscriptionList,
  renderTextForumSummaryList,
} from '../../output/text/yunqi.js';
import { invalidArgError, handleError } from '../../utils/errors.js';
import type { ListExhibitorsOptions, ListForumsOptions } from '../../types/yunqi.js';

export const RESOURCES = ['forums', 'exhibitors', 'subscriptions', 'summaries'] as const;

export type Resource = (typeof RESOURCES)[number];

/**
 * The flags each resource actually forwards to its action. `list` registers the
 * union of the forum and exhibitor filters on one command, so without this a
 * flag belonging to the other resource is accepted and then silently dropped by
 * the service. Derived from the service's wire-mapping key lists.
 *
 * Exported so the completion surfaces can be tested against the same source of
 * truth the runtime validator uses.
 */
export const RESOURCE_FLAGS: Record<Resource, ReadonlySet<string>> = {
  forums: new Set<string>(['page', 'pageSize', ...FORUM_FILTER_KEYS]),
  exhibitors: new Set<string>(['page', 'pageSize', 'enabled', ...EXHIBITOR_FILTER_KEYS]),
  subscriptions: new Set<string>(),
  summaries: new Set<string>(['forumId']),
};

export function registerYunqiListForumsCommand(parent: Command): void {
  const list = parent
    .command('list [resource]')
    .description('List forums, exhibitors, subscriptions or summaries')
    .option('--page <n>', 'Page number (default: 1)', (v) => parseInt(v, 10), 1)
    .option('--page-size <n>', 'Page size (default: 20)', (v) => parseInt(v, 10), 20)
    .option('--industry <value>', 'Filter by industry')
    .option('--interest <value>', 'Filter by interest')
    .option('--location <value>', 'Filter by location')
    .option('--forum-id <value>', 'Filter by forum ID')
    .option('--keyword <value>', 'Filter by keyword')
    .option('--forum-name <value>', 'Filter by forum name')
    .option('--member-name <value>', 'Filter by member name')
    .option('--theme-name <value>', 'Filter by theme name')
    .option('--topic-name <value>', 'Filter by topic name')
    .option('--guest-name <value>', 'Filter by guest name')
    .option('--company-name <value>', 'Filter by company name')
    .option('--hall-name <value>', 'Filter by hall name')
    .option('--zone-name <value>', 'Filter by zone name')
    .option('--booth-name <value>', 'Filter by booth name')
    .option('--exhibit-name <value>', 'Filter by exhibit name')
    .option('--enabled <bool>', 'Filter by enabled status (true|false)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  list.action(yunqiListForumsAction(list));
}

export function yunqiListForumsAction(cmd: Command) {
  return async function (this: Command) {
    const command = this ?? cmd;
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(command, config);
    const opts = command.opts();

    try {
      const resource = resolveResource(command.args?.[0]);
      rejectInapplicableFlags(command, resource);
      validatePositiveInt('--page', opts.page);
      validatePositiveInt('--page-size', opts.pageSize);
      opts.enabled = parseEnabledFlag(opts.enabled);

      await ensureAuthenticated();
      const { yunqiService } = createServices();

      switch (resource) {
        case 'forums':
          await handleListForums(yunqiService, format, opts);
          break;
        case 'exhibitors':
          await handleListExhibitors(yunqiService, format, opts);
          break;
        case 'subscriptions':
          await handleListSubscriptions(yunqiService, format);
          break;
        case 'summaries':
          await handleListSummaries(yunqiService, format, opts);
          break;
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}

function isResource(value: string): value is Resource {
  return (RESOURCES as readonly string[]).includes(value);
}

function resolveResource(raw: string | undefined): Resource {
  const value = raw ?? 'forums';
  if (!isResource(value)) {
    const known = RESOURCES.map((r) => `'${r}'`).join(', ');
    throw invalidArgError(`Unknown resource '${value}'. Use ${known}.`);
  }
  return value;
}

function rejectInapplicableFlags(command: Command, resource: Resource): void {
  const allowed = RESOURCE_FLAGS[resource];
  const rejected = Object.keys(command.opts()).filter(
    (key) => key !== 'format' && !allowed.has(key) && command.getOptionValueSource(key) === 'cli',
  );
  if (rejected.length > 0) {
    const flags = rejected.map(toFlagName).join(', ');
    throw invalidArgError(`${flags} cannot be used with 'yunqi list ${resource}'`);
  }
}

function toFlagName(optionKey: string): string {
  return `--${optionKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function validatePositiveInt(flag: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidArgError(`${flag} must be a positive integer`);
  }
}

function parseEnabledFlag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw invalidArgError("--enabled must be either 'true' or 'false'");
}

async function handleListForums(
  yunqiService: ReturnType<typeof createServices>['yunqiService'],
  format: 'json' | 'table' | 'text',
  opts: ListForumsOptions,
): Promise<void> {
  const result = await withSpinner('Fetching forums', () => yunqiService.listForums(opts), format);

  if (format === 'json') {
    outputJSON({
      forums: result.forums,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
    return;
  }

  const vm = buildForumListViewModel(result);
  if (vm.rows.length === 0) {
    console.log('No forums found.');
    return;
  }

  if (format === 'text') {
    renderTextForumList(vm);
  } else {
    await renderYunqiForumListInk(vm);
  }
}

async function handleListSubscriptions(
  yunqiService: ReturnType<typeof createServices>['yunqiService'],
  format: 'json' | 'table' | 'text',
): Promise<void> {
  const result = await withSpinner(
    'Fetching subscriptions',
    () => yunqiService.listMyForumSubscriptions(),
    format,
  );

  if (format === 'json') {
    outputJSON(result);
    return;
  }

  const vm = buildForumSubscriptionListViewModel(result);
  if (vm.rows.length === 0) {
    console.log('No subscriptions found.');
    return;
  }

  if (format === 'text') {
    renderTextSubscriptionList(vm);
  } else {
    await renderYunqiSubscriptionListInk(vm);
  }
}

async function handleListExhibitors(
  yunqiService: ReturnType<typeof createServices>['yunqiService'],
  format: 'json' | 'table' | 'text',
  opts: ListExhibitorsOptions,
): Promise<void> {
  const result = await withSpinner(
    'Fetching exhibitors',
    () => yunqiService.listExhibitors(opts),
    format,
  );

  if (format === 'json') {
    outputJSON({
      exhibitors: result.exhibitors,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
    return;
  }

  const vm = buildExhibitorListViewModel(result);
  if (vm.rows.length === 0) {
    console.log('No exhibitors found.');
    return;
  }

  if (format === 'text') {
    renderTextExhibitorList(vm);
  } else {
    await renderYunqiExhibitorListInk(vm);
  }
}

async function handleListSummaries(
  yunqiService: ReturnType<typeof createServices>['yunqiService'],
  format: 'json' | 'table' | 'text',
  opts: Pick<ListForumsOptions, 'forumId'>,
): Promise<void> {
  const result = await withSpinner(
    'Fetching summaries',
    () => yunqiService.listForumSummaries(opts.forumId),
    format,
  );

  if (format === 'json') {
    outputJSON({ summaries: result });
    return;
  }

  const vm = buildForumSummaryListViewModel(result);
  if (vm.rows.length === 0) {
    console.log('No summaries found.');
    return;
  }

  if (format === 'text') {
    renderTextForumSummaryList(vm);
  } else {
    await renderYunqiForumSummaryListInk(vm);
  }
}
