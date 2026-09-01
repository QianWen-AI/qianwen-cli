import type { Command } from 'commander';
import { registerImageGenerateCommand } from './generate.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { imageGenerateAction, registerImageGenerateCommand } from './generate.js';

export function registerImageCommands(program: Command): void {
  const image = program
    .command('image')
    .description('Image generation and editing with Qwen models');

  const generate = registerImageGenerateCommand(image);

  addExamples(generate, [
    formatCmd('image generate "a cyberpunk city at night"'),
    formatCmd('image generate "a serene lake" --size 1024*1024 --n 2'),
    formatCmd('image generate "replace the sky" --model qwen-image-edit-plus --image ./photo.png'),
  ]);

  image.action(() => {
    image.outputHelp();
    process.stdout.write('\n');
  });
}
