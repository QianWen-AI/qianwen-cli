import type { Command } from 'commander';
import { registerYunqiListForumsCommand } from './list-forums.js';
import { registerYunqiSubscribeForumCommand } from './subscribe-forum.js';
import { registerYunqiUnsubscribeForumCommand } from './unsubscribe-forum.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export function registerYunqiCommands(program: Command): void {
  const yunqi = program
    .command('yunqi')
    .description('Yunqi activities: browse forums and exhibitors, manage subscriptions');

  registerYunqiListForumsCommand(yunqi);
  registerYunqiSubscribeForumCommand(yunqi);
  registerYunqiUnsubscribeForumCommand(yunqi);

  const list = yunqi.commands.find((c: Command) => c.name() === 'list');
  if (list) {
    addExamples(list, [
      formatCmd('yunqi list forums'),
      formatCmd('yunqi list exhibitors'),
      formatCmd('yunqi list subscriptions'),
      formatCmd('yunqi list summaries'),
    ]);
  }

  const subscribe = yunqi.commands.find((c: Command) => c.name() === 'subscribe');
  if (subscribe) {
    addExamples(subscribe, [formatCmd('yunqi subscribe forum --forum-id <id>')]);
  }

  const unsubscribe = yunqi.commands.find((c: Command) => c.name() === 'unsubscribe');
  if (unsubscribe) {
    addExamples(unsubscribe, [formatCmd('yunqi unsubscribe forum --forum-id <id>')]);
  }

  yunqi.action(() => {
    yunqi.outputHelp();
    process.stdout.write('\n');
  });
}
