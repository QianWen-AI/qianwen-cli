import type { Command } from 'commander';
import { registerDocsSearchCommand } from './search.js';
import { registerDocsViewCommand } from './view.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { docsSearchAction, registerDocsSearchCommand } from './search.js';
export { docsViewAction, registerDocsViewCommand } from './view.js';

export function registerDocsCommands(program: Command): void {
  const docs = program.command('docs').description('Browse the official docs');

  const search = registerDocsSearchCommand(docs);
  const view = registerDocsViewCommand(docs);

  addExamples(search, [
    formatCmd('docs search "how to use run"'),
    formatCmd('docs search billing --limit 5'),
  ]);

  addExamples(view, [formatCmd('docs view <url>'), formatCmd('docs view docs/getting-started')]);

  docs.action(() => {
    docs.outputHelp();
    process.stdout.write('\n');
  });
}
