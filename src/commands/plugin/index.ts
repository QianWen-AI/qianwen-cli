import type { Command } from 'commander';
import { registerPluginListCommand } from './list.js';
import { registerPluginInstallCommand } from './install.js';
import { registerPluginUninstallCommand } from './uninstall.js';
import { registerPluginUpdateCommand } from './update.js';
import { registerPluginValidateCommand } from './validate.js';
import { registerPluginInitCommand } from './init.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { pluginListAction, registerPluginListCommand } from './list.js';
export { pluginInstallAction, registerPluginInstallCommand } from './install.js';
export { pluginUninstallAction, registerPluginUninstallCommand } from './uninstall.js';
export { pluginUpdateAction, registerPluginUpdateCommand } from './update.js';
export { pluginValidateAction, registerPluginValidateCommand } from './validate.js';
export { pluginInitAction, registerPluginInitCommand } from './init.js';

/**
 * Registers the `plugin` management command group (list/install/uninstall/
 * update/validate/init). Distinct from loader.ts `registerPluginCommands`, which registers
 * the commands CONTRIBUTED BY installed plugins. This group manages the
 * plugins themselves.
 */
export function registerPluginManagementCommands(program: Command): void {
  const plugin = program.command('plugin').description('Manage QianWen CLI plugins');

  registerPluginListCommand(plugin);

  const install = registerPluginInstallCommand(plugin);
  addExamples(install, [formatCmd('plugin install ./my-local-plugin')]);

  registerPluginUninstallCommand(plugin);
  registerPluginUpdateCommand(plugin);

  const validate = registerPluginValidateCommand(plugin);
  addExamples(validate, [formatCmd('plugin validate ./my-local-plugin')]);

  const init = registerPluginInitCommand(plugin);
  addExamples(init, [
    formatCmd('plugin init ./my-plugin'),
    formatCmd('plugin init . --name @me/foo'),
  ]);

  plugin.action(() => {
    plugin.outputHelp();
    process.stdout.write('\n');
  });
}
