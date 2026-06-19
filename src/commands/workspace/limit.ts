import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildWorkspaceLimitViewModel } from '../../view-models/workspace/index.js';
import { renderWorkspaceLimitInk } from '../../ui/WorkspaceLimit.js';
import { renderTextWorkspaceLimit } from '../../output/text/workspace.js';
import { handleError } from '../../utils/errors.js';

export function registerWorkspaceLimitCommand(parent: Command): void {
  const limit = parent
    .command('limit')
    .description('Show workspace count vs the per-account hard limit')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  limit.action(workspaceLimitAction(limit));
}

export function workspaceLimitAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      await ensureAuthenticated();
      const { workspaceService } = createServices();
      const result = await withSpinner(
        'Fetching workspace limit',
        () => workspaceService.limit(),
        format,
      );

      const vm = buildWorkspaceLimitViewModel(result);

      if (format === 'json') {
        outputJSON({
          current: vm.current,
          max: vm.max,
        });
        return;
      }

      if (format === 'text') {
        renderTextWorkspaceLimit(vm);
      } else {
        await renderWorkspaceLimitInk(vm);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}
