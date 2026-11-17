/**
 * `plugin update [<name>]` — prompt-style (does not auto-install). For each
 * npm-source plugin (a single <name> or all when omitted), compare the local
 * version against compatible registry versions; when newer, print an exact
 * version installation command for the user to run. Non-npm sources
 * have no registry version and are reported as unsupported.
 *
 * Exit codes: 1 = named plugin not installed; 2 = registry authentication failed.
 */

import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { getPluginsManifestPath } from '../../config/paths.js';
import { readInstalledManifest, type InstalledPlugin } from '../../plugins/manifest.js';
import { getRegistryPluginMetadata } from '../../plugins/installer.js';
import { formatCmd } from '../../utils/runtime-mode.js';
import { CliError, handleError, invalidArgError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { VERSION } from '../../version.js';
import { getDefaultPlugin } from '../../plugins/defaults.js';
import {
  comparePluginVersions,
  isCliVersionCompatible,
  isPrereleasePluginVersion,
  isValidPluginVersion,
  resolveHighestCompatiblePluginVersion,
  resolveMinimumCliVersion,
} from '../../plugins/compatibility.js';

type Format = 'json' | 'text' | 'table';

interface UpdateRow {
  name: string;
  current: string;
  latest: string;
  command: string;
}

interface IncompatibleUpdate {
  name: string;
  version: string;
  minCliVersion: string;
}

interface InvalidUpdateMetadata {
  name: string;
  version: string;
  reason: string;
}

export function pluginUpdateAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, name: string | undefined) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config) as Format;

    const state = readInstalledManifest(getPluginsManifestPath());
    let targets: InstalledPlugin[];
    if (name) {
      const found = state.plugins.find((p) => p.name === name);
      if (!found) {
        const message = `plugin "${name}" is not installed.`;
        if (format === 'json') handleError(invalidArgError(message), format);
        process.stderr.write(message + '\n');
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return;
      }
      targets = [found];
    } else {
      targets = state.plugins;
    }

    const updates: UpdateRow[] = [];
    const uncheckable: string[] = [];
    const nonAuthUncheckable: string[] = [];
    const authFailures: { name: string; error: CliError }[] = [];
    const incompatible: IncompatibleUpdate[] = [];
    const invalidMetadata: InvalidUpdateMetadata[] = [];
    const unsupported = targets
      .filter((plugin) => plugin.source !== 'npm')
      .map(({ name, source }) => ({ name, source }));
    const npmTargets = targets.filter((plugin) => plugin.source === 'npm');
    const results = await Promise.allSettled(
      npmTargets.map(async (plugin) => {
        const source = getDefaultPlugin(plugin.name)?.source;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            getRegistryPluginMetadata(plugin.name, {
              downloadTimeoutMs: 30_000,
              registry: source?.type === 'npm' ? source.registry : undefined,
            }),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 30_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    for (const [index, plugin] of npmTargets.entries()) {
      const result = results[index];
      const metadata = result?.status === 'fulfilled' ? result.value : null;
      if (!metadata) {
        // Distinguish "registry check failed" from "already latest": a null here
        // means the registry version could not be resolved (network/registry/no
        // latest tag), NOT that the plugin is up to date. Surfacing it prevents
        // silently reporting "up to date" when the check never succeeded.
        uncheckable.push(plugin.name);
        if (
          result?.status === 'rejected' &&
          result.reason instanceof CliError &&
          result.reason.exitCode === EXIT_CODES.AUTH_FAILURE
        ) {
          authFailures.push({ name: plugin.name, error: result.reason });
        } else {
          nonAuthUncheckable.push(plugin.name);
        }
        continue;
      }
      const latestPackage = metadata.versions[metadata.latest];
      let latestMinimum: string | undefined;
      try {
        latestMinimum = resolveMinimumCliVersion(latestPackage);
      } catch {
        invalidMetadata.push({
          name: plugin.name,
          version: metadata.latest,
          reason: 'invalid minCliVersion: expected a string',
        });
      }
      if (!isValidPluginVersion(metadata.latest)) {
        invalidMetadata.push({
          name: plugin.name,
          version: metadata.latest,
          reason: 'invalid plugin version',
        });
      } else if (latestMinimum !== undefined && !isValidPluginVersion(latestMinimum)) {
        invalidMetadata.push({
          name: plugin.name,
          version: metadata.latest,
          reason: `invalid minCliVersion "${latestMinimum}"`,
        });
      }
      if (
        latestMinimum &&
        isValidPluginVersion(latestMinimum) &&
        !isCliVersionCompatible(VERSION, latestMinimum)
      ) {
        incompatible.push({
          name: plugin.name,
          version: metadata.latest,
          minCliVersion: latestMinimum,
        });
      }

      const latest = resolveHighestCompatiblePluginVersion(
        metadata.versions,
        VERSION,
        undefined,
        isPrereleasePluginVersion(plugin.version),
      );
      if (!latest) {
        continue;
      }
      if ((comparePluginVersions(latest, plugin.version) ?? 0) > 0) {
        updates.push({
          name: plugin.name,
          current: plugin.version,
          latest,
          command: formatCmd(`plugin install ${plugin.name}@${latest}`),
        });
      }
    }

    if (format === 'json') {
      outputJSON({ updates, incompatible, invalidMetadata, uncheckable, unsupported });
    } else {
      for (const u of updates) {
        console.log(`${u.name}: ${u.current} → ${u.latest}  ·  run: ${u.command}`);
      }
      for (const item of incompatible) {
        console.log(
          `${item.name}@${item.version} requires CLI >= ${item.minCliVersion} and cannot be installed by CLI ${VERSION}.`,
        );
      }
      for (const item of invalidMetadata) {
        console.log(`${item.name}@${item.version} has ${item.reason} and was ignored.`);
      }
      if (nonAuthUncheckable.length > 0) {
        console.log(
          `Could not check for updates (registry unreachable): ${nonAuthUncheckable.join(', ')}`,
        );
      }
      for (const plugin of unsupported) {
        console.log(
          `${plugin.name}: ${plugin.source} source does not support registry update checks.`,
        );
      }
      if (
        updates.length === 0 &&
        incompatible.length === 0 &&
        uncheckable.length === 0 &&
        unsupported.length === 0 &&
        invalidMetadata.length === 0
      ) {
        console.log('All plugins are at the latest compatible version.');
      }
    }
    if (authFailures.length > 0) {
      handleError(
        new CliError({
          code: 'PLUGIN_INSTALL_FAILED',
          message: `Registry authentication failed while checking plugin updates. ${authFailures
            .map(({ name, error }) => `${name}: ${error.message}`)
            .join(' ')}`,
          exitCode: EXIT_CODES.AUTH_FAILURE,
        }),
        format,
      );
    }
  };
}

export function registerPluginUpdateCommand(parent: Command): Command {
  const update = parent
    .command('update [name]')
    .description('Check for plugin updates (prints the install command; does not auto-update)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  update.action(pluginUpdateAction(update));
  return update;
}
