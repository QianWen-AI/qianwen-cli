import type { Command } from 'commander';
import { registerChatCreateCommand } from './create.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { chatCreateAction, registerChatCreateCommand } from './create.js';

export function registerChatCommands(program: Command): void {
  const chat = program.command('chat').description('Chat completions with Qwen models');

  const create = registerChatCreateCommand(chat);

  addExamples(create, [
    formatCmd('chat create "Explain quantum computing"'),
    formatCmd('chat create "Explain quantum computing" --temperature 0.7 --max-tokens 1024'),
    formatCmd('chat create --stream "Write a haiku"'),
  ]);

  chat.action(() => {
    chat.outputHelp();
    process.stdout.write('\n');
  });
}
