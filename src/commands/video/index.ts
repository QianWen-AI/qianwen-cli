import type { Command } from 'commander';
import { registerVideoGenerateCommand } from './generate.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { videoGenerateAction, registerVideoGenerateCommand } from './generate.js';

export function registerVideoCommands(program: Command): void {
  const video = program
    .command('video')
    .description('Video generation and editing with Wan models');

  const generate = registerVideoGenerateCommand(video);

  addExamples(generate, [
    formatCmd('video generate "a sunset over the sea, slow push-in"'),
    formatCmd(
      'video generate "make the cat run" --model happyhorse-1.1-i2v --image cat.png --out cat.mp4',
    ),
    formatCmd(
      'video generate --request \'{"model":"happyhorse-1.1-t2v","input":{"prompt":"a sunset"}}\'',
    ),
  ]);

  video.action(() => {
    video.outputHelp();
    process.stdout.write('\n');
  });
}
