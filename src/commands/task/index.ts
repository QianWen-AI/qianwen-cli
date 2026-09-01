import type { Command } from 'commander';
import { registerTaskGetCommand } from './get.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { taskGetAction, registerTaskGetCommand } from './get.js';

export function registerTaskCommands(program: Command): void {
  const task = program
    .command('task')
    .description('Query asynchronous tasks (video, 3D, transcription)');

  const get = registerTaskGetCommand(task);

  addExamples(get, [formatCmd('task get 0385dc79-5ff8-4d82-bcb6-000000000000')]);

  task.action(() => {
    task.outputHelp();
    process.stdout.write('\n');
  });
}
