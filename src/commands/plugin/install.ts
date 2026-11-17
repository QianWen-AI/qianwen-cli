/** `plugin install` explicitly installs or upgrades a plugin under the shared manifest lock. */
import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { createPluginInstallContext, hasLoadedPluginCode } from '../../plugins/loader.js';
import { installManagedPlugin, isLocalPluginPath } from '../../plugins/default-install.js';
import { handleError } from '../../utils/errors.js';
import { renderPluginConfirmation } from '../../ui/PluginConfirmation.js';
import { isReplMode } from '../../utils/runtime-mode.js';

export function pluginInstallAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, spec: string) {
    const self = this ?? cmd;
    const format = resolveFormatFromCommand(self, getEffectiveConfig());
    if (spec && isLocalPluginPath(spec)) {
      process.stderr.write(
        'warning: local plugins are unreviewed and run in the same process as the CLI (full credential access).\n',
      );
    }
    try {
      const record = await installManagedPlugin(spec, createPluginInstallContext(self));
      const restartRequired = isReplMode() && hasLoadedPluginCode(record.name);
      if (restartRequired) {
        process.stderr.write(
          'warning: Restart this REPL session for the installed plugin code and its dependencies to take effect.\n',
        );
      }
      if (format === 'json') {
        outputJSON({
          installed: record.name,
          source: record.source,
          command: record.command,
          ...(restartRequired ? { restartRequired: true } : {}),
        });
      } else if (format === 'table') {
        await renderPluginConfirmation(
          `Installed ${record.name} (${record.source}) — command: ${record.command}`,
        );
      } else {
        console.log(`Installed ${record.name} (${record.source}) — command: ${record.command}`);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}

export function registerPluginInstallCommand(parent: Command): Command {
  const install = parent
    .command('install <pkg|path>')
    .description('Install an official plugin (npm) or a local plugin directory')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  install.action(pluginInstallAction(install));
  return install;
}
