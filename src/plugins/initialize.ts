import type { Command } from 'commander';
import fs from 'node:fs';
import { getDefaultPlugins } from './defaults.js';
import { ensureDefaultPlugin, recoverManagedPluginInstalls } from './default-install.js';
import { createPluginInstallContext } from './loader.js';
import { readInstalledManifest } from './manifest.js';
import { outputJSON } from '../output/format.js';
import { CliError, handleError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { registerCommandInterrupt } from '../utils/command-interrupt.js';

// A fixed marker lets standalone installers choose a safe hint without parsing CLI diagnostics.
function reportUpgradeRequired(): void {
  const file = process.env.QIANWEN_PLUGIN_PREPARE_REPORT;
  if (!file) return;
  let fd: number | undefined;
  try {
    if (!fs.lstatSync(file).isFile()) return;
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    if (!fs.fstatSync(fd).isFile()) return;
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, 'upgrade-required\n');
  } catch {
    // Reporting must never replace the plugin error or create a path supplied by the environment.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Preserve the original plugin error. */
      }
    }
  }
}

// Used only by installation scripts; ordinary commands prepare their own plugin on demand.
export async function initializeDefaultPlugins(program: Command): Promise<void> {
  const controller = new AbortController();
  const context = { ...createPluginInstallContext(program), signal: controller.signal };
  const results: Array<{
    name: string;
    status: 'installed' | 'disabled' | 'failed';
    version?: string;
    error?: string;
    code?: string;
    minCliVersion?: string;
    currentCliVersion?: string;
  }> = [];
  const cancel = () =>
    controller.abort(
      new CliError({
        code: 'USER_CANCELLED',
        message: 'Plugin preparation cancelled.',
        exitCode: EXIT_CODES.USER_INTERRUPT,
      }),
    );
  const timeout = () =>
    controller.abort(
      new CliError({
        code: 'PLUGIN_PREPARE_TIMEOUT',
        message: 'Default plugin preparation exceeded its time budget.',
        exitCode: EXIT_CODES.CONFIG_ERROR,
        hint: 'Default plugins will be retried automatically when you run their commands.',
      }),
    );
  const configuredDeadline = Number(process.env.QIANWEN_PLUGIN_PREPARE_DEADLINE);
  const deadline =
    Number.isSafeInteger(configuredDeadline) && configuredDeadline > 0
      ? Math.min(configuredDeadline, Date.now() + 45_000)
      : Date.now() + 45_000;
  const checkDeadline = () => {
    if (Date.now() >= deadline) timeout();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unregisterInterrupt = registerCommandInterrupt(cancel);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    checkDeadline();
    if (!controller.signal.aborted) {
      timer = setTimeout(timeout, deadline - Date.now());
      timer.unref();
    }
    try {
      await recoverManagedPluginInstalls(context);
    } catch (error) {
      handleError(error, 'json');
    }
    for (const definition of getDefaultPlugins()) {
      checkDeadline();
      if (controller.signal.aborted) break;
      const state = readInstalledManifest(context.manifestPath);
      if (
        state.disabledDefaults?.includes(definition.name) ||
        state.plugins.some((entry) => entry.name === definition.name && !entry.enabled)
      ) {
        results.push({ name: definition.name, status: 'disabled' });
        continue;
      }
      try {
        // Await the installer so cancellation can finish rollback before this command exits.
        const installed = await ensureDefaultPlugin(definition, context);
        results.push({ name: installed.name, version: installed.version, status: 'installed' });
      } catch (error) {
        const code = error instanceof CliError ? error.code : 'PLUGIN_PREPARE_FAILED';
        if (code === 'PLUGIN_CLI_INCOMPATIBLE') reportUpgradeRequired();
        results.push({
          name: definition.name,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          code,
          ...(error instanceof CliError &&
          'minCliVersion' in error &&
          typeof error.minCliVersion === 'string'
            ? { minCliVersion: error.minCliVersion }
            : {}),
          ...(error instanceof CliError &&
          'currentCliVersion' in error &&
          typeof error.currentCliVersion === 'string'
            ? { currentCliVersion: error.currentCliVersion }
            : {}),
        });
      }
    }
    outputJSON({ plugins: results });
    checkDeadline();
    if (controller.signal.aborted) handleError(controller.signal.reason, 'json');
    const failed = results.filter((result) => result.status === 'failed');
    const incompatible = failed.some((result) => result.code === 'PLUGIN_CLI_INCOMPATIBLE');
    if (failed.length)
      handleError(
        new CliError({
          code: incompatible ? 'PLUGIN_CLI_INCOMPATIBLE' : 'PLUGIN_PREPARE_FAILED',
          message: failed.map((result) => `${result.name}: ${result.error}`).join('\n'),
          exitCode: EXIT_CODES.CONFIG_ERROR,
          hint: incompatible
            ? 'Upgrade QianWen CLI to meet the required version, then run the plugin command again.'
            : 'Default plugins will be retried automatically when you run their commands.',
        }),
        'json',
      );
  } finally {
    unregisterInterrupt();
    if (timer !== undefined) clearTimeout(timer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
