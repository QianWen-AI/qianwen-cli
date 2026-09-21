/**
 * `skills pack-install` — download and install every skill of a skill pack
 * from SkillHub into a local base directory (default: agent pick in table
 * mode, cwd otherwise).
 *
 * Anonymous calls are allowed. Exit codes: 0 on full success, an all-noop run
 * or user cancellation; 1 on any member failure, an invalid pack name, an
 * unusable --dir, or a terminal pack error (not found / empty / download /
 * verification).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { withSpinner, clearSpinnerLine, pauseSpinner, resumeSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildPackInstallViewModel } from '../../view-models/skills/index.js';
import type { PackInstallContext } from '../../view-models/skills/index.js';
import type { PackItemResult } from '../../types/skills.js';
import { renderTextPackInstall } from '../../output/text/skills.js';
import {
  renderSkillsPackInstallInk,
  promptPackInstallConfirm,
} from '../../ui/SkillsPackInstallSummary.js';
import { theme } from '../../ui/theme.js';
import { handleError, HandledError, CliError } from '../../utils/errors.js';
import { isSystemRootPath } from '../../utils/system-paths.js';
import { isRecognizedAgentDir, getKnownAgents } from '../../utils/agent-dirs.js';
import { promptAgentDir } from '../../ui/AgentDirPrompt.js';
import { toSkillsCliError } from './search.js';
import { checkInstallDirectory } from './install.js';
import { USER_CANCELLED_CODE } from '../../services/skills-pack-service.js';
import type { PackInstallPlan } from '../../services/skills-pack-service.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

/** Pack names are bare collection names: no `/`, no `@` prefix, no whitespace. */
function isValidPackName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.startsWith('@') && !/\s/.test(name);
}

const PROGRESS_ICONS: Record<PackItemResult['outcome'], string> = {
  installed: '\u2713',
  changed: '~',
  noop: '=',
  failed: '\u2717',
};

// Matches the final summary rows (SkillsPackInstallSummary ROW_COLORS) so the
// per-member progress lines and the report read as one coherent view. Basic
// 16-color SGR codes — safe on non-truecolor terminals (same rationale as
// theme.errorForced).
const PROGRESS_COLORS: Record<PackItemResult['outcome'], (text: string) => string> = {
  installed: chalk.green,
  changed: chalk.green,
  noop: chalk.yellow,
  failed: chalk.red,
};

export function skillsPackInstallAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, packName: string, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    // Argument validation happens before any I/O — usage errors exit 1.
    // json gets the structured handleError payload; text/table keep the
    // exact plain-text wording on stderr (no "Error:" prefix).
    if (!isValidPackName(packName)) {
      const message = `Invalid pack name: ${packName}.`;
      if (format === 'json') {
        handleError(
          new CliError({ code: 'INVALID_SLUG', message, exitCode: EXIT_CODES.GENERAL_ERROR }),
          format,
        );
      }
      process.stderr.write(message + '\n');
      process.exitCode = EXIT_CODES.GENERAL_ERROR;
      return;
    }

    try {
      const { skillsPackService } = createServices();

      let baseDir: string;
      let context: PackInstallContext = { mode: 'current-dir' };

      if (typeof options.dir === 'string') {
        baseDir = options.dir;
        context = { mode: 'explicit-dir' };
      } else if (format === 'table' && process.stdin.isTTY) {
        const defaultDir = process.cwd();
        if (!isRecognizedAgentDir(defaultDir)) {
          const agents = getKnownAgents();
          const selected = await promptAgentDir(defaultDir, agents, '', 'pack-install');
          if (selected === null) {
            process.exitCode = 0;
            return;
          }
          baseDir = selected.path;
          if (selected.agent) {
            context = {
              mode: 'agent',
              agentDisplayName: selected.agent.displayName,
              scope: selected.scope,
            };
            // Agent skills directories may not exist yet; cwd always does.
            fs.mkdirSync(baseDir, { recursive: true });
          }
        } else {
          baseDir = defaultDir;
        }
      } else {
        baseDir = process.cwd();
        process.stderr.write(`The skill pack will be installed into the ${baseDir} directory.\n`);
      }

      // Protective guard first — a system root must never be probed or written,
      // regardless of its permission bits (and before realpathSync could throw
      // on a missing path).
      let rootGuardPath = baseDir;
      try {
        rootGuardPath = fs.realpathSync(baseDir);
      } catch {
        /* keep original */
      }
      if (isSystemRootPath(rootGuardPath)) {
        const message =
          'The installation base directory cannot be the filesystem root. Choose a Skills directory.';
        if (format === 'json') {
          handleError(
            new CliError({
              code: 'ROOT_DIR_NOT_ALLOWED',
              message,
              exitCode: EXIT_CODES.GENERAL_ERROR,
            }),
            format,
          );
        }
        const cross = format === 'table' ? theme.errorForced('\u2717') : '\u2717';
        process.stderr.write(`${cross} ${message}\n`);
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return;
      }

      const dirFailure = checkInstallDirectory(baseDir);
      if (dirFailure) {
        const structured =
          dirFailure === 'not-exist'
            ? new CliError({
                code: 'INSTALL_DIR_NOT_FOUND',
                message:
                  `Installation failed: target directory does not exist: ${baseDir}. ` +
                  'Please provide an existing writable directory and rerun the command.',
                exitCode: EXIT_CODES.GENERAL_ERROR,
              })
            : new CliError({
                code: 'INSTALL_DIR_NOT_WRITABLE',
                message:
                  `Installation failed: no permission to write to the target directory: ${baseDir}. ` +
                  'Please provide an existing writable directory or update its permissions, then rerun the command.',
                exitCode: EXIT_CODES.GENERAL_ERROR,
              });
        if (format === 'json') {
          handleError(structured, format);
        }
        const cross = format === 'table' ? theme.errorForced('\u2717') : '\u2717';
        process.stderr.write(
          dirFailure === 'not-exist'
            ? `${cross} Installation failed: target directory does not exist: ${baseDir}.\n\n` +
                'Please provide an existing writable directory and rerun the command.\n'
            : `${cross} Installation failed: no permission to write to the target directory: ${baseDir}.\n\n` +
                'Please provide an existing writable directory or update its permissions, then rerun the command.\n',
        );
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return;
      }

      if (typeof options.dir === 'string' && format === 'table') {
        console.log('Using explicit installation directory');
      }

      // A confirmed target: interactive table runs show the confirmation
      // page; every other path (explicit --dir or non-interactive formats)
      // proceeds without prompting.
      const interactive = format === 'table' && typeof options.dir !== 'string';
      const onConfirm = interactive
        ? async (plan: PackInstallPlan) => {
            // The confirmation page renders via Ink on stdout; the wrapping
            // spinner's timer must stop writing \r frames or it corrupts the
            // Ink repaint. Pause before, resume after (cancelled included).
            pauseSpinner();
            try {
              return await promptPackInstallConfirm(plan);
            } finally {
              resumeSpinner();
            }
          }
        : async () => true;

      const result = await withSpinner(
        `Installing skill pack ${packName}`,
        () =>
          skillsPackService.installPack({
            packName,
            baseDir,
            onConfirm,
            ...(format === 'table'
              ? {
                  onProgress: (item: PackItemResult) => {
                    clearSpinnerLine();
                    const version =
                      item.outcome === 'failed'
                        ? `  [${item.error?.code ?? 'INSTALL_FAILED'}]`
                        : item.version !== undefined
                          ? `  v${item.version}`
                          : '';
                    console.log(
                      PROGRESS_COLORS[item.outcome](
                        `  ${PROGRESS_ICONS[item.outcome]} ${item.fullSlug}  ${item.outcome}${version}`,
                      ),
                    );
                  },
                }
              : {}),
          }),
        format,
      );

      if (format === 'json') {
        outputJSON({
          pack: result.pack,
          overallStatus: result.overallStatus,
          baseDir: result.baseDir,
          summary: result.summary,
          items: result.items.map((item) => ({
            slug: item.fullSlug,
            status: item.outcome,
            ...(item.version !== undefined ? { version: item.version } : {}),
            ...(item.previousVersion !== undefined
              ? { previousVersion: item.previousVersion }
              : {}),
            ...(item.previousSlug !== undefined
              ? { overwritten: true, previousSlug: item.previousSlug }
              : {}),
            ...(item.targetDir !== undefined ? { targetDir: item.targetDir } : {}),
            ...(item.error !== undefined ? { error: item.error } : {}),
          })),
        });
      } else {
        const vm = buildPackInstallViewModel(result, context);
        if (format === 'text') {
          renderTextPackInstall(vm);
        } else {
          await renderSkillsPackInstallInk(vm, { showItems: false });
        }
      }

      if (result.summary.failed > 0) {
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      if (error instanceof CliError && error.code === USER_CANCELLED_CODE) {
        process.stderr.write('Cancelled.\n');
        process.exitCode = EXIT_CODES.SUCCESS;
        return;
      }
      handleError(toSkillsCliError(error), format);
    }
  };
}

export function registerSkillsPackInstallCommand(parent: Command): Command {
  const packInstall = parent
    .command('pack-install <pack-name>')
    .description('Install all skills from a skill pack')
    .option('--dir <directory>', 'Base directory for installation')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  addExamples(packInstall, [
    formatCmd('skills pack-install qianwen-forge-pack'),
    formatCmd('skills pack-install qianwen-forge-pack --dir ./skills --format json'),
  ]);

  packInstall.action(skillsPackInstallAction(packInstall));
  return packInstall;
}
