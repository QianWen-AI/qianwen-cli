import type { Command } from 'commander';
import { registerWorkspaceListCommand } from './list.js';
import { registerWorkspaceLimitCommand } from './limit.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command('workspace')
    .description('Inspect workspaces and quota limits (read-only)');

  registerWorkspaceListCommand(workspace);
  registerWorkspaceLimitCommand(workspace);

  const list = workspace.commands.find((c) => c.name() === 'list');
  if (list) {
    addExamples(list, [formatCmd('workspace list'), formatCmd('workspace list --format json')]);
  }

  const limit = workspace.commands.find((c) => c.name() === 'limit');
  if (limit) {
    addExamples(limit, [formatCmd('workspace limit')]);
  }

  workspace.action(() => {
    workspace.outputHelp();
    process.stdout.write('\n');
  });
}
