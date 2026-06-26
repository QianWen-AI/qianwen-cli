import type { Command } from 'commander';
import { supportListAction } from './list.js';
import { supportViewAction } from './view.js';
import { supportCreateAction } from './create.js';
import { supportReplyAction } from './reply.js';
import { supportCloseAction } from './close.js';
import { supportRateAction } from './rate.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export function registerSupportCommands(program: Command): void {
  const support = program.command('support').description('Manage support tickets');

  support
    .command('list')
    .description('List support tickets')
    .option('--page <number>', 'Page number (default: 1)', '1')
    .option('--page-size <number>', 'Page size, 1-10 (default: 10)', '10')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async function (this: Command, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await supportListAction(opts);
    });

  support
    .command('view')
    .description('View a support ticket with messages')
    .argument('<ticket-id>', 'Ticket ID')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async function (this: Command, ticketId: string, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await supportViewAction(ticketId, opts);
    });

  const createCmd = support
    .command('create')
    .description('Create a new support ticket')
    .option('--list-categories', 'List all available categories and exit')
    .option('--category-id <id>', 'Category ID for non-interactive ticket creation')
    .option('--description <text>', 'Issue description for non-interactive ticket creation (max 2000 chars)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async function (this: Command, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await supportCreateAction(opts);
    });

  addExamples(createCmd, [
    formatCmd('support create'),
    formatCmd('support create --list-categories'),
    formatCmd('support create --category-id 582262 --description "\u6A21\u578B\u8C03\u7528\u8D85\u65F6"'),
    formatCmd('support create --list-categories --format json'),
  ]);

  support
    .command('reply')
    .description('Reply to a support ticket')
    .argument('<ticket-id>', 'Ticket ID')
    .option('--message <text>', 'Reply content (non-interactive mode)')
    .option('--format <fmt>', 'Output format: json (default: auto)')
    .action(async function (this: Command, ticketId: string, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await supportReplyAction(ticketId, opts);
    });

  support
    .command('close')
    .description('Close (cancel) a support ticket')
    .argument('<ticket-id>', 'Ticket ID')
    .option('--yes', 'Skip confirmation prompt')
    .option('--format <fmt>', 'Output format: json (default: auto)')
    .action(async function (this: Command, ticketId: string, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await supportCloseAction(ticketId, opts);
    });

  support
    .command('rate')
    .description('Rate a resolved support ticket (0-2)')
    .argument('<ticket-id>', 'Ticket ID to rate')
    .option('--rating <n>', 'Satisfaction rating: 0=不满意, 1=一般, 2=满意. Omit to enter interactive mode.')
    .option('--comment <text>', 'Optional comment (max 500 characters)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async function (this: Command, ticketId: string, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await supportRateAction(ticketId, opts);
    });

  const list = support.commands.find((c) => c.name() === 'list');
  if (list) {
    addExamples(list, [
      formatCmd('support list'),
      formatCmd('support list --page 2 --page-size 5'),
      formatCmd('support list --format json'),
    ]);
  }

  const view = support.commands.find((c) => c.name() === 'view');
  if (view) {
    addExamples(view, [
      formatCmd('support view <ticket-id>'),
      formatCmd('support view <ticket-id> --format json'),
    ]);
  }

  const reply = support.commands.find((c) => c.name() === 'reply');
  if (reply) {
    addExamples(reply, [
      formatCmd('support reply <ticket-id>'),
      formatCmd('support reply <ticket-id> --message "Issue resolved, thanks"'),
    ]);
  }

  const close = support.commands.find((c) => c.name() === 'close');
  if (close) {
    addExamples(close, [
      formatCmd('support close <ticket-id>'),
      formatCmd('support close <ticket-id> --yes'),
    ]);
  }

  const rate = support.commands.find((c) => c.name() === 'rate');
  if (rate) {
    addExamples(rate, [
      formatCmd('support rate <ticket-id> --rating 2 --comment "Great service"'),
      formatCmd('support rate <ticket-id> --rating 1'),
      formatCmd('support rate <ticket-id>') + '    (interactive mode)',
    ]);
  }

  support.action(() => {
    support.outputHelp();
    process.stdout.write('\n');
  });
}
