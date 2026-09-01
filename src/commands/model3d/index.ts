import type { Command } from 'commander';
import { registerModel3dGenerateCommand } from './generate.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { model3dGenerateAction, registerModel3dGenerateCommand } from './generate.js';

export function registerModel3dCommands(program: Command): void {
  const group = program.command('model3d').description('3D model generation with Tripo models');

  const generate = registerModel3dGenerateCommand(group);

  addExamples(generate, [
    formatCmd('model3d generate "一把木质椅子"'),
    formatCmd('model3d generate --image chair.png --texture-quality detailed'),
    formatCmd(
      'model3d generate --request \'{"model":"Tripo/Tripo-P1.0","input":{"prompt":"一把木质椅子"}}\'',
    ),
  ]);

  group.action(() => {
    group.outputHelp();
    process.stdout.write('\n');
  });
}
