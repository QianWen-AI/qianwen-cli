import type { Command } from 'commander';
import { VERSION } from '../index.js';
import { createClient } from '../api/client.js';
import { getConfigValue } from '../config/manager.js';
import { resolveFormat, outputJSON } from '../output/format.js';
import { theme } from '../ui/theme.js';
import type { OutputFormat, ResolvedFormat } from '../types/config.js';
import { networkError, handleError } from '../utils/errors.js';
import { formatCmd } from '../utils/runtime-mode.js';
import { site } from '../site.js';

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Show CLI version')
    .option('--check', 'Check for updates')
    .action(async (opts) => {
      const format = resolveFormat(
        program.opts().format,
        getConfigValue('output.format') as OutputFormat,
      );

      if (opts.check) {
        await versionCheck(format);
      } else {
        if (format === 'json') {
          outputJSON({ version: VERSION });
        } else {
          console.log(`${site.cliName} v${VERSION}`);
        }
      }
    });
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Update CLI to the latest version')
    .action(async () => {
      const format = resolveFormat(
        program.opts().format,
        getConfigValue('output.format') as OutputFormat,
      );

      try {
        const client = await createClient();
        const info = await client.checkVersion();

        if (!info.update_available) {
          if (format === 'json') {
            outputJSON({
              current: info.current,
              latest: info.latest,
              update_available: false,
              message: 'Already up to date',
            });
          } else {
            console.log(
              `${theme.success(theme.symbols.pass)}  Already up to date (v${info.current})`,
            );
          }
          return;
        }

        if (format === 'json') {
          outputJSON({
            current: info.current,
            latest: info.latest,
            update_available: true,
            message: `Updating to v${info.latest}...`,
          });
        } else {
          console.log(`  Updating ${site.cliName} v${info.current} → v${info.latest}...`);
          console.log(`  To update, run:`);
          console.log(`    npm install -g ${site.cliName}@${info.latest}`);
          console.log(`    # or: pnpm add -g ${site.cliName}@${info.latest}`);
        }
      } catch (error) {
        handleError(
          error instanceof Error ? networkError(error.message) : networkError(String(error)),
          format,
        );
      }
    });
}

async function versionCheck(format: ResolvedFormat): Promise<void> {
  try {
    const client = await createClient();
    const info = await client.checkVersion();

    if (format === 'json') {
      outputJSON({
        current: info.current,
        latest: info.latest,
        update_available: info.update_available,
      });
      return;
    }

    console.log('');
    console.log(`  Current version:  v${info.current}`);
    console.log(`  Latest version:   v${info.latest}`);

    if (info.update_available) {
      console.log('');
      console.log(`  Run ${theme.bold(formatCmd('update'))} to upgrade.`);
    } else {
      console.log('');
      console.log(`  ${theme.success(theme.symbols.pass)}  You're up to date!`);
    }
    console.log('');
  } catch (error) {
    handleError(
      error instanceof Error ? networkError(error.message) : networkError(String(error)),
      format,
    );
  }
}
