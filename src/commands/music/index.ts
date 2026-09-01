import type { Command } from 'commander';
import { registerMusicGenerateCommand } from './generate.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { musicGenerateAction, registerMusicGenerateCommand } from './generate.js';

export function registerMusicCommands(program: Command): void {
  const group = program.command('music').description('Music generation with Fun-Music models');

  const generate = registerMusicGenerateCommand(group);

  addExamples(generate, [
    formatCmd('music generate "轻快的钢琴曲，适合作为旅行视频背景音乐"'),
    formatCmd('music generate "轻快的旅行背景音乐" --out travel.mp3'),
    formatCmd(
      'music generate --request \'{"model":"fun-music-v1","input":{"prompt":"轻快的钢琴曲","is_instrumental":true}}\'',
    ),
  ]);

  group.action(() => {
    group.outputHelp();
    process.stdout.write('\n');
  });
}
