import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildWorkspaceListViewModel } from '../../view-models/workspace/index.js';
import { renderWorkspaceListInk } from '../../ui/WorkspaceList.js';
import { renderTextWorkspaceList } from '../../output/text/workspace.js';
import { handleError } from '../../utils/errors.js';

export function registerWorkspaceListCommand(parent: Command): void {
  const list = parent
    .command('list')
    .description('List accessible workspaces')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  list.action(workspaceListAction(list));
}

export function workspaceListAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      await ensureAuthenticated();
      const { workspaceService } = createServices();
      const result = await withSpinner(
        'Fetching workspaces',
        () => workspaceService.list(),
        format,
      );

      if (format === 'json') {
        outputJSON({
          items: result.items,
          total: result.total,
          limit: result.limit,
        });
        return;
      }

      const vm = buildWorkspaceListViewModel(result);
      if (vm.rows.length === 0) {
        console.log('No workspaces found.');
        return;
      }

      if (format === 'text') {
        renderTextWorkspaceList(vm);
      } else {
        await renderWorkspaceListInk(vm);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}
