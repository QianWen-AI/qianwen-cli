import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildForumSubscribeViewModel } from '../../view-models/yunqi/index.js';
import { renderYunqiSubscribeResultInk } from '../../ui/YunqiSubscribeResult.js';
import { renderTextForumSubscribe } from '../../output/text/yunqi.js';
import { invalidArgError, handleError, HandledError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { validateForumResource } from './shared.js';

export function registerYunqiUnsubscribeForumCommand(parent: Command): void {
  const unsubscribe = parent
    .command('unsubscribe [resource]')
    .description('Unsubscribe from a forum')
    .requiredOption('--forum-id <id>', 'Forum ID (required)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  unsubscribe.action(yunqiUnsubscribeForumAction(unsubscribe));
}

export function yunqiUnsubscribeForumAction(cmd: Command) {
  return async function (this: Command) {
    const command = this ?? cmd;
    const opts = command.opts();
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(command, config);

    try {
      validateForumResource(command.args?.[0]);
      await ensureAuthenticated();

      const forumId: string | undefined = opts.forumId;
      if (!forumId) {
        throw invalidArgError('--forum-id is required');
      }

      const { yunqiService } = createServices();
      const success = await withSpinner(
        'Unsubscribing from forum',
        () => yunqiService.unsubscribeForum(forumId),
        format,
      );

      if (format === 'json') {
        outputJSON({ success });
      } else {
        const vm = buildForumSubscribeViewModel({ success }, 'unsubscribe');
        if (format === 'text') {
          renderTextForumSubscribe(vm);
        } else {
          await renderYunqiSubscribeResultInk(vm);
        }
      }

      // `Data: false` is a processed-but-unsuccessful write. The view above has
      // already reported it, so only the exit code is left to signal failure.
      if (!success) throw new HandledError(EXIT_CODES.GENERAL_ERROR);
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}
