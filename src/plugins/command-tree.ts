import { Command, Option } from 'commander';
import { addExamples, setLongDescription } from '../utils/commander-helpers.js';
import { formatCmd } from '../utils/runtime-mode.js';
import type { PluginCommandNode } from './manifest.js';

/** Share Commander registration rules between installation checks and runtime loading. */
export function configurePluginCommand(cmd: Command, node: PluginCommandNode): void {
  if (node.description) cmd.description(node.description);
  if (node.longDescription) setLongDescription(cmd, node.longDescription);
  if (node.examples) addExamples(cmd, node.examples.map(formatCmd));
  for (const alias of node.commandAliases ?? []) cmd.alias(alias);
  for (const opt of node.options ?? []) {
    const option = new Option(opt.flag, opt.description ?? '');
    if (opt.choices) option.choices(opt.choices);
    cmd.addOption(option);
  }
}

/** Validate on an isolated tree without importing or executing plugin handlers. */
export function validatePluginCommandTree(node: PluginCommandNode): string | null {
  const register = (parent: Command, current: PluginCommandNode): void => {
    const cmd = parent.command(current.command);
    configurePluginCommand(cmd, current);
    for (const child of current.subcommands ?? []) register(cmd, child);
  };
  try {
    register(new Command(), node);
    return null;
  } catch (error) {
    return `invalid plugin command tree: ${error instanceof Error ? error.message : String(error)}`;
  }
}
