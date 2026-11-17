import type { Command } from 'commander';
import { extractCommandTree } from '../utils/commander-helpers.js';
import type { InstalledPlugin } from './manifest.js';

export type PluginConflict = 'ok' | 'reserved' | 'duplicate';

const HOST_COMMAND_NAMES = new Set(['help', 'clear', 'cls', 'exit', 'quit', 'q']);

/**
 * Strip argument syntax so manifest names match Commander's registered names.
 */
export function normalizeCommandName(raw: string): string {
  return raw.trim().split(/\s+/)[0] ?? '';
}

export function collectReservedNames(program: Command): Set<string> {
  const reserved = new Set(HOST_COMMAND_NAMES);
  for (const node of extractCommandTree(program, { includeHidden: true })) {
    reserved.add(node.name);
    for (const alias of node.aliases) reserved.add(alias);
  }
  return reserved;
}

/**
 * Include aliases in collision checks because Commander registers them as command names.
 */
export function pluginNames(command: string, aliases: string[] | undefined): string[] {
  const names = [normalizeCommandName(command), ...(aliases ?? []).map(normalizeCommandName)];
  return [...new Set(names.filter((n) => n !== ''))];
}

export function resolvePluginConflict(
  names: string[],
  reserved: Set<string>,
  installedNames: string[],
): PluginConflict {
  if (names.some((n) => HOST_COMMAND_NAMES.has(n.toLowerCase()) || reserved.has(n)))
    return 'reserved';
  if (names.some((n) => installedNames.includes(n))) return 'duplicate';
  return 'ok';
}

/**
 * `reserved` contains only built-in names; `installed` supplies plugin ownership.
 * Reinstallation exempts only names already owned by this plugin.
 */
export function classifyInstallCollision(
  rawCommand: string,
  rawAliases: string[] | undefined,
  reserved: Set<string>,
  installed: InstalledPlugin[],
  selfName: string,
): PluginConflict {
  const names = pluginNames(rawCommand, rawAliases);
  if (names.some((name) => HOST_COMMAND_NAMES.has(name.toLowerCase()))) return 'reserved';
  const selfOwned = new Set(
    installed
      .filter((plugin) => plugin.name === selfName)
      .flatMap((plugin) => pluginNames(plugin.command ?? '', plugin.commandAliases)),
  );
  const otherOwned = new Set(
    installed
      .filter((plugin) => plugin.name !== selfName)
      .flatMap((plugin) => pluginNames(plugin.command ?? '', plugin.commandAliases)),
  );

  // Exemption is per name, not per plugin. Sharing one legitimate old name
  // must not allow a reinstall to add a different name owned by another plugin
  // or reserved by a built-in.
  if (names.some((name) => otherOwned.has(name))) return 'duplicate';
  if (names.some((name) => !selfOwned.has(name) && reserved.has(name))) return 'reserved';
  return 'ok';
}
