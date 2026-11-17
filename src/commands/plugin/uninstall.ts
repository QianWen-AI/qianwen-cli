/** Explicitly uninstall a plugin; configured defaults remain disabled until manual reinstall. */
import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { createPluginInstallContext } from '../../plugins/loader.js';
import { uninstallManagedPlugin } from '../../plugins/default-install.js';
import { parseNpmSpec } from '../../plugins/installer.js';
import { handleError } from '../../utils/errors.js';
import { renderPluginConfirmation } from '../../ui/PluginConfirmation.js';

export function pluginUninstallAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, spec: string) {
    const self = this ?? cmd;
    const format = resolveFormatFromCommand(self, getEffectiveConfig());
    try {
      await uninstallManagedPlugin(spec, createPluginInstallContext(self));
      const { name } = parseNpmSpec(spec);
      if (format === 'json') outputJSON({ uninstalled: name });
      else if (format === 'table') await renderPluginConfirmation(`Uninstalled ${name}.`);
      else console.log(`Uninstalled ${name}.`);
    } catch (error) {
      handleError(error, format);
    }
  };
}

export function registerPluginUninstallCommand(parent: Command): Command {
  const uninstall = parent
    .command('uninstall <name[@version]>')
    .description('Uninstall a plugin by name or exact installed version')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  uninstall.action(pluginUninstallAction(uninstall));
  return uninstall;
}
