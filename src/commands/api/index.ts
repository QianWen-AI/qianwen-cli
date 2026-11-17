import type { Command } from 'commander';
import { registerApiCallCommand } from './call.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export function registerApiCommands(program: Command): void {
  const api = program.command('api').description('Call backend-approved OpenAPIs');
  registerApiCallCommand(api);
  addExamples(api, [
    formatCmd('api call --help'),
    formatCmd(
      'api call --product AliyunDeliveryService --action ListModelSeries --params \'{"Language":"zh-CN"}\' --format json',
    ),
  ]);
  api.action(() => {
    api.outputHelp();
    process.stdout.write('\n');
  });
}
