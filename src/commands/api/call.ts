import { Command } from 'commander';
import { RequestTimeoutError } from '../../api/base-client.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { outputJSON, resolveFormatFromCommand } from '../../output/format.js';
import { renderTextApiCall } from '../../output/text/api-call.js';
import { createServices } from '../../services/index.js';
import { renderApiCallInk } from '../../ui/ApiCallTable.js';
import { registerCommandInterrupt } from '../../utils/command-interrupt.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { CliError, HandledError, handleError, networkError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { formatCmd } from '../../utils/runtime-mode.js';
import { buildApiCallViewModel } from '../../view-models/api-call.js';

function invalidArgument(message: string): CliError {
  return new CliError({ code: 'INVALID_ARGUMENT', message, exitCode: EXIT_CODES.INVALID_ARGUMENT });
}

function requiredName(value: unknown, flag: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidArgument(`${flag} requires a non-empty value.`);
  }
  return value;
}

function parseParams(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw !== 'string') throw invalidArgument('--params must be a JSON object.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // JSON parser messages can include private fragments of the caller's input.
    throw invalidArgument('--params must be a JSON object.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArgument('--params must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

class ApiCallCommand extends Command {
  override error(message: string, options?: Parameters<Command['error']>[1]): never {
    if (options?.code === 'commander.optionMissingArgument') {
      handleError(
        invalidArgument(message.replace(/^error: /, '')),
        resolveFormatFromCommand(this, getEffectiveConfig()),
      );
    }
    return super.error(message, options);
  }

  parseValue(value: string, flag: string): string {
    // Preserve Commander's help handling, but reject a swallowed value-taking flag early.
    if (value !== '-h' && value !== '--help' && (value === '--' || /^--?[A-Za-z]/u.test(value))) {
      this.error(`error: ${flag} requires a value.`, { code: 'commander.optionMissingArgument' });
    }
    return value;
  }
}

export function registerApiCallCommand(parent: Command): void {
  const command: ApiCallCommand = new ApiCallCommand('call')
    .description('Call a backend-approved OpenAPI using the current CLI login')
    .option('--product <product>', 'API product (required)', (value) =>
      command.parseValue(value, '--product'),
    )
    .option('--action <action>', 'API action (required)', (value) =>
      command.parseValue(value, '--action'),
    )
    .option('--params <json>', 'Business parameters as a JSON object (default: {})', (value) =>
      command.parseValue(value, '--params'),
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  parent.addCommand(command);
  command.addHelpText(
    'after',
    '\nCalls may write data. No automatic retries or dedicated command confirmations.',
  );
  addExamples(command, [
    formatCmd(
      'api call --product AliyunDeliveryService --action ListModelSeries --params \'{"Language":"zh-CN"}\' --format json',
    ),
  ]);

  command.action(async () => {
    const format = resolveFormatFromCommand(command, getEffectiveConfig());
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const unregister = registerCommandInterrupt(cancel);
    process.on('SIGINT', cancel);
    try {
      const options = command.opts<{ product?: string; action?: string; params?: string }>();
      const product = requiredName(options.product, '--product');
      const action = requiredName(options.action, '--action');
      const params = parseParams(options.params);
      const data = await createServices().openApiService.call({
        product,
        action,
        params,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (format === 'json') outputJSON(data);
      else {
        const vm = buildApiCallViewModel(data);
        if (format === 'text') renderTextApiCall(vm);
        else await renderApiCallInk(vm);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      if (controller.signal.aborted) {
        handleError(
          new CliError({
            code: 'INTERRUPTED',
            message: 'OpenAPI request cancelled.',
            exitCode: EXIT_CODES.USER_INTERRUPT,
          }),
          format,
        );
      }
      if (error instanceof RequestTimeoutError) {
        const timeout = networkError(error.message);
        timeout.cause = error;
        handleError(timeout, format);
      }
      handleError(error, format);
    } finally {
      process.off('SIGINT', cancel);
      unregister();
    }
  });
}
