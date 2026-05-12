import type { Command } from 'commander';
import { configList } from './list.js';
import { configGet } from './get.js';
import { configSet } from './set.js';
import { configUnset } from './unset.js';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Manage CLI configuration');

  config
    .command('list')
    .description('List all configuration values')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action((opts) => {
      const parentFormat = program.opts().format;
      configList(opts, parentFormat);
    });

  config
    .command('get')
    .description('Get a configuration value')
    .argument('<key>', 'Configuration key')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action((key, opts) => {
      const parentFormat = program.opts().format;
      configGet(key, opts, parentFormat);
    });

  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key')
    .argument('<value>', 'Configuration value')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action((key, value, opts) => {
      const parentFormat = program.opts().format;
      configSet(key, value, opts, parentFormat);
    });

  config
    .command('unset')
    .description('Remove a configuration value')
    .argument('<key>', 'Configuration key')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action((key, opts) => {
      const parentFormat = program.opts().format;
      configUnset(key, opts, parentFormat);
    });

  config.action(() => {
    config.outputHelp();
    process.stdout.write('\n');
  });
}
