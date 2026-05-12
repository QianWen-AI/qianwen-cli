import { Command } from 'commander';
import { modelsListAction } from './list.js';
import { modelsInfoAction } from './info.js';
import { modelsSearchAction } from './search.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';

export function registerModelsCommands(program: Command): void {
  const models = program.command('models').description('Browse and search available models');

  models
    .command('list')
    .description('List available models')
    .option('--input <modality>', 'Filter by input modality: text, image, video, audio')
    .option('--output <modality>', 'Filter by output modality: text, image, video, audio')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .option('--page <number>', 'Page number (default: 1)', '1')
    .option('--per-page <number>', 'Models per page (default: 20)', '20')
    .option('--all', 'Return all models in one response (JSON only, no pagination)')
    .option('--verbose', 'Include features, context, rate_limits, description (JSON only)')
    .action(async function (this: Command, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await modelsListAction(opts);
    });

  models
    .command('info')
    .description('Show full details for a model')
    .argument('[id]', 'Model ID (or use --model)')
    .option('--model <id>', 'Model ID')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async function (this: Command, id: string | undefined, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      // Support both positional arg and --model flag; flag takes precedence
      const modelId = opts.model || id;
      if (!modelId) {
        this.error(
          'error: model ID is required. Provide it as a positional argument or use --model <id>',
        );
      }
      await modelsInfoAction(modelId, opts);
    });

  models
    .command('search')
    .description('Search models by keyword or modality')
    .argument('<query>', 'Search keyword')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .option('--page <number>', 'Page number (default: 1)', '1')
    .option('--per-page <number>', 'Models per page (default: 20)', '20')
    .option('--all', 'Return all matches in one response (JSON only, no pagination)')
    .action(async function (this: Command, query: string, opts) {
      opts.format = opts.format ?? resolveFormatFromCommand(this, getEffectiveConfig());
      await modelsSearchAction(query, opts);
    });

  models.action(() => {
    models.outputHelp();
    process.stdout.write('\n');
  });
}
