import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export class PluginCliIncompatibleError extends CliError {
  constructor(
    readonly minCliVersion: string,
    readonly currentCliVersion: string,
  ) {
    super({
      code: 'PLUGIN_CLI_INCOMPATIBLE',
      message: `plugin requires CLI >= ${minCliVersion} (current ${currentCliVersion})`,
      exitCode: EXIT_CODES.CONFIG_ERROR,
      hint: 'Upgrade QianWen CLI, then run the plugin command again.',
    });
  }

  override toJSON() {
    const result = super.toJSON();
    return {
      error: {
        ...result.error,
        minCliVersion: this.minCliVersion,
        currentCliVersion: this.currentCliVersion,
      },
    };
  }
}
