/**
 * Statically validate a local plugin without importing code or changing install state.
 * Exit code 1 indicates validation or usage errors; 0 allows warnings.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { getPluginsManifestPath } from '../../config/paths.js';
import { readInstalledManifest } from '../../plugins/manifest.js';
import { createPluginInstallContext, getRegisteredPluginNames } from '../../plugins/loader.js';
import { runPluginValidateChecks } from '../../plugins/validate.js';
import { handleError, invalidArgError, HandledError } from '../../utils/errors.js';
import { formatCmd } from '../../utils/runtime-mode.js';
import { expandHomePath } from '../../utils/expand-home.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import type { DoctorCheck } from '../../view-models/doctor.js';

type Format = 'json' | 'text' | 'table';

const ICON: Record<DoctorCheck['status'], string> = {
  pass: '✔',
  warn: '⚠',
  info: 'ℹ',
  fail: '✖',
};

function rootProgram(cmd: Command): Command {
  let c = cmd;
  while (c.parent) c = c.parent;
  return c;
}

/** A local path is anything that resolves to an existing directory on disk. */
function isLocalDir(spec: string): boolean {
  try {
    return fs.statSync(path.resolve(spec)).isDirectory();
  } catch {
    return false;
  }
}

export function pluginValidateAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, pathArg?: string) {
    const self = this ?? cmd;
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(self, config) as Format;
    try {
      const spec = expandHomePath(pathArg ?? '.');
      if (!isLocalDir(spec)) {
        const message =
          `"${spec}" is not a local plugin directory. plugin validate currently supports only ` +
          `local paths (e.g. ${formatCmd('plugin validate ./my-plugin')}).`;
        // handleError is `never` (throws HandledError); in text/table just
        // write to stderr + set the exit code, mirroring the other plugin cmds.
        if (format === 'json') handleError(invalidArgError(message), format);
        process.stderr.write(message + '\n');
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return;
      }
      const pkgDir = path.resolve(spec);
      const reserved = createPluginInstallContext(rootProgram(self)).reservedNames;
      const installed = readInstalledManifest(getPluginsManifestPath()).plugins;
      const checks = runPluginValidateChecks(
        pkgDir,
        reserved,
        installed,
        getRegisteredPluginNames(rootProgram(self)),
      );

      const errors = checks.filter((c) => c.status === 'fail').length;
      const warnings = checks.filter((c) => c.status === 'warn').length;
      const passed = checks.filter((c) => c.status === 'pass').length;

      if (format === 'json') {
        outputJSON({
          path: pkgDir,
          checks,
          summary: { total: checks.length, passed, errors, warnings },
        });
      } else {
        process.stdout.write(`Validating plugin at ${pkgDir}\n\n`);
        for (const c of checks) {
          process.stdout.write(`  ${ICON[c.status]}  ${c.detail}\n`);
        }
        process.stdout.write(`\n${passed} passed, ${errors} error(s), ${warnings} warning(s).\n`);
        const failing = checks.filter((c) => c.status === 'fail' && c.action);
        if (failing.length > 0) {
          process.stdout.write(`\nFixes:\n`);
          for (const c of failing) process.stdout.write(`  ${c.detail}\n    → ${c.action}\n`);
        }
        // A pass does not prove the handler is executable (no module import).
        process.stdout.write(
          `\nNote: validate is static — a pass does not guarantee handlers load/execute.\n`,
        );
      }

      if (errors > 0) process.exitCode = EXIT_CODES.GENERAL_ERROR;
    } catch (err) {
      // The non-local-path guard calls handleError (throws HandledError) in json
      // mode — already rendered, so re-throw instead of rendering it twice.
      if (err instanceof HandledError) throw err;
      handleError(err, format);
      process.exitCode = EXIT_CODES.GENERAL_ERROR;
    }
  };
}

export function registerPluginValidateCommand(parent: Command): Command {
  const validate = parent
    .command('validate [path]')
    .description('Validate a local plugin directory (static checks; no install)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  validate.action(pluginValidateAction(validate));
  return validate;
}
