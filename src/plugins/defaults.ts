import configuration from '../../plugins.preload.json';
import { isValidPluginVersion } from './compatibility.js';
import { pluginNames } from './names.js';
import { normalizeRegistryUrl } from './npm-registry.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export interface DefaultPlugin {
  name: string;
  /** Exact bootstrap version and minimum version required by this CLI. */
  version: string;
  command: string;
  commandAliases?: string[];
  source: { type: 'npm'; registry?: string } | { type: 'archive'; path: string };
  sha256?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new CliError({
    code: 'PLUGIN_DEFAULT_INVALID',
    message: `Invalid default plugin configuration: ${message}`,
    exitCode: EXIT_CODES.CONFIG_ERROR,
  });
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid('unknown configuration field');
}

/** Validates metadata only: neither plugin archives nor executable modules are read. */
export function validateDefaultConfig(value: unknown): DefaultPlugin[] {
  if (!record(value) || !Array.isArray(value.plugins)) invalid('plugins must be an array');
  onlyKeys(value, ['plugins']);
  const packages = new Set<string>();
  const commands = new Set<string>();
  return value.plugins.map((item: unknown) => {
    if (!record(item)) invalid('plugin must be an object');
    onlyKeys(item, ['name', 'version', 'command', 'commandAliases', 'source', 'sha256']);
    if (
      typeof item.name !== 'string' ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(item.name)
    )
      invalid('unsafe package name');
    if (packages.has(item.name)) invalid(`duplicate package ${item.name}`);
    packages.add(item.name);
    if (
      typeof item.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+]|$)/.test(item.version) ||
      !isValidPluginVersion(item.version)
    )
      invalid(`${item.name}: version must be exact`);
    if (!record(item.source)) invalid(`${item.name}: missing source`);
    if (item.source.type === 'npm') {
      onlyKeys(item.source, ['type', 'registry']);
      if (item.source.registry !== undefined) {
        try {
          normalizeRegistryUrl(item.source.registry);
        } catch {
          invalid(`${item.name}: invalid npm registry`);
        }
      }
    } else if (item.source.type === 'archive') {
      onlyKeys(item.source, ['type', 'path']);
      if (typeof item.source.path !== 'string' || !item.source.path.trim())
        invalid('archive path required');
      if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))
        invalid('archive sha256 required');
    } else invalid('source must be npm or archive');
    if (
      item.sha256 !== undefined &&
      (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))
    )
      invalid('invalid sha256');
    const commandName = (name: unknown): name is string =>
      typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name);
    if (!commandName(item.command)) invalid(`${item.name}: invalid command`);
    if (
      item.commandAliases !== undefined &&
      (!Array.isArray(item.commandAliases) || !item.commandAliases.every(commandName))
    )
      invalid(`${item.name}: invalid command aliases`);
    for (const name of pluginNames(item.command, item.commandAliases as string[] | undefined)) {
      if (commands.has(name)) invalid(`duplicate command ${name}`);
      commands.add(name);
    }
    return item as unknown as DefaultPlugin;
  });
}

const defaults = validateDefaultConfig(configuration);

export function getDefaultPlugins(): readonly DefaultPlugin[] {
  return defaults;
}

export function getDefaultPlugin(name: string): DefaultPlugin | undefined {
  return defaults.find((plugin) => plugin.name === name);
}
