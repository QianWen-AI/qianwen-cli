/**
 * `plugin list` — show installed plugins from plugins.json. Each entry is
 * probed on disk (package dir + plugin manifest present?) and marked broken
 * when missing; a broken entry never crashes the listing. Tri-state output:
 * json (structured) / text (plain) / table (Ink).
 */

import type { Command } from 'commander';
import { join } from 'node:path';
import { isRealPathWithinBase } from '../../utils/path-safety.js';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { getPluginsDir, getPluginsManifestPath } from '../../config/paths.js';
import {
  readInstalledManifest,
  readPluginPackageManifest,
  validateManifest,
  type PluginManifest,
} from '../../plugins/manifest.js';
import {
  buildPluginListViewModel,
  type ResolvedPluginEntry,
} from '../../view-models/plugin/index.js';
import { renderTextPluginList } from '../../output/text/plugin.js';
import { renderPluginListInk } from '../../ui/PluginListTable.js';
import { getDefaultPlugins, getDefaultPlugin } from '../../plugins/defaults.js';
import { readUsableDefaultPlugin } from '../../plugins/default-install.js';
import { createPluginInstallContext } from '../../plugins/loader.js';
import { VERSION } from '../../version.js';
import {
  comparePluginVersions,
  isCliVersionCompatible,
  isValidPluginVersion,
} from '../../plugins/compatibility.js';

type Format = 'json' | 'text' | 'table';

function invalidPluginManifest(manifest: PluginManifest | null): boolean {
  return (
    manifest !== null &&
    (validateManifest(manifest) !== null ||
      (manifest.minCliVersion !== undefined && !isValidPluginVersion(manifest.minCliVersion)))
  );
}

export function pluginListAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config) as Format;

    const pluginsDir = getPluginsDir();
    const state = readInstalledManifest(getPluginsManifestPath());

    const entries: ResolvedPluginEntry[] = state.plugins
      .filter((plugin) => !getDefaultPlugin(plugin.name))
      .map((p) => {
        const pkgDir = p.path ?? join(pluginsDir, 'node_modules', p.name);
        const manifest = (() => {
          try {
            return readPluginPackageManifest(pkgDir);
          } catch {
            return null;
          }
        })();
        const valid =
          manifest !== null &&
          validateManifest(manifest) === null &&
          (manifest.minCliVersion === undefined || isValidPluginVersion(manifest.minCliVersion));
        return {
          name: p.name,
          version: p.version,
          enabled: p.enabled,
          source: p.source,
          command: manifest?.command,
          installed: valid,
          minCliVersion:
            typeof manifest?.minCliVersion === 'string' ? manifest.minCliVersion : undefined,
          compatible: valid ? isCliVersionCompatible(VERSION, manifest.minCliVersion) : false,
        };
      });

    const context = createPluginInstallContext(this ?? cmd);
    entries.unshift(
      ...getDefaultPlugins().map((definition): ResolvedPluginEntry => {
        const record = state.plugins.find((entry) => entry.name === definition.name);
        const usable = readUsableDefaultPlugin(definition, context);
        const pkgDir = record?.path ?? join(pluginsDir, 'node_modules', definition.name);
        const physicalManifest = (() => {
          try {
            return record && isRealPathWithinBase(pluginsDir, pkgDir)
              ? readPluginPackageManifest(pkgDir)
              : null;
          } catch {
            return null;
          }
        })();
        const enabled =
          !state.disabledDefaults?.includes(definition.name) && record?.enabled !== false;
        return {
          name: definition.name,
          version: record?.version ?? definition.version,
          enabled,
          source: record?.source ?? definition.source.type,
          command: usable?.manifest.command ?? definition.command,
          installed: physicalManifest !== null,
          minCliVersion:
            typeof physicalManifest?.minCliVersion === 'string'
              ? physicalManifest.minCliVersion
              : undefined,
          compatible: usable !== null,
          status: invalidPluginManifest(physicalManifest)
            ? 'broken'
            : !enabled
              ? 'disabled'
              : usable
                ? (comparePluginVersions(usable.record.version, definition.version) ?? -1) >= 0
                  ? 'installed'
                  : 'outdated'
                : physicalManifest &&
                    !isCliVersionCompatible(VERSION, physicalManifest.minCliVersion)
                  ? 'incompatible'
                  : record
                    ? 'broken'
                    : 'pending',
        };
      }),
    );

    if (format === 'json') {
      outputJSON({
        plugins: entries.map((e) => ({
          name: e.name,
          version: e.version,
          command: e.command ?? null,
          source: e.source,
          ...(getDefaultPlugin(e.name)
            ? { origin: 'default', defaultVersion: getDefaultPlugin(e.name)?.version }
            : {}),
          enabled: e.enabled,
          installed: e.installed,
          status:
            e.status ??
            (!e.installed
              ? 'broken'
              : !e.enabled
                ? 'disabled'
                : e.compatible
                  ? 'enabled'
                  : 'incompatible'),
          minCliVersion: e.minCliVersion ?? null,
        })),
      });
      return;
    }

    const vm = buildPluginListViewModel(entries);

    if (format === 'text') {
      renderTextPluginList(vm);
      return;
    }

    if (vm.isEmpty) {
      console.log('No plugins installed.');
      return;
    }
    await renderPluginListInk(vm);
  };
}

export function registerPluginListCommand(parent: Command): Command {
  const list = parent
    .command('list')
    .description('List installed plugins')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  list.action(pluginListAction(list));
  return list;
}
