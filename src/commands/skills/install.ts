/**
 * `skills install` — download and deploy a skill from SkillHub into a local
 * directory (default: the current working directory).
 *
 * Non-interactive; anonymous calls are allowed (auth is optional). Exit
 * codes follow the README contract: 1 = invalid argument,
 * unmanaged-directory conflict, unusable --dir or any other install
 * failure, 2 = auth failure with credentials attached, 3 = network / API
 * error.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildSkillsInstallViewModel } from '../../view-models/skills/index.js';
import type { SkillsInstallContext } from '../../view-models/skills/index.js';
import type { SkillDetail } from '../../types/skills.js';
import { renderTextSkillsInstall } from '../../output/text/skills.js';
import { renderSkillsInstallInk } from '../../ui/SkillsInstallSummary.js';
import { promptSkillOverrideConfirm } from '../../ui/SkillOverrideConfirm.js';
import { theme } from '../../ui/theme.js';
import { handleError, HandledError, CliError } from '../../utils/errors.js';
import { parseFullSlug, isValidBareSlug } from '../../utils/skills-security.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';
import { isRecognizedAgentDir, getKnownAgents } from '../../utils/agent-dirs.js';
import { promptAgentDir } from '../../ui/AgentDirPrompt.js';
import { toSkillsCliError } from './search.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { isSystemRootPath } from '../../utils/system-paths.js';

type InstallDirFailure = 'not-exist' | 'not-writable';

// A path that exists but is not a directory is reported as 'not-exist' per the install API contract.
export function checkInstallDirectory(dir: string): InstallDirFailure | null {
  try {
    if (!fs.statSync(dir).isDirectory()) return 'not-exist';
  } catch {
    return 'not-exist';
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return 'not-writable';
  }
  return null;
}

export function skillsInstallAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, slug: string, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    // Argument validation happens before any I/O — usage errors exit 1.
    // json gets the structured handleError payload; text/table keep the
    // exact plain-text wording on stderr (no "Error:" prefix).
    const parsed = parseFullSlug(slug);
    const isFullSlug = parsed !== null;
    if (!isFullSlug && !isValidBareSlug(slug)) {
      const message = `Invalid Skill slug: ${slug}. Expected @<provider>/slug.`;
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
      const { skillsInstallService, skillsHubService } = createServices();

      // Early existence check: validate the slug resolves to a real skill
      // before entering any interactive flow (directory selection prompt).
      // The fetched detail is forwarded to the service to skip a redundant call.
      let preloadedDetail: SkillDetail | undefined;
      if (format === 'table' && typeof options.dir !== 'string') {
        const detailName = parsed ? parsed.skillName : slug;
        preloadedDetail = await withSpinner(
          `Checking ${slug}`,
          () => skillsHubService.getSkillDetail(detailName, parsed?.provider),
          format,
        );
      }

      let baseDir: string;
      let context: SkillsInstallContext = { mode: 'current-dir' };
      if (typeof options.dir === 'string') {
        baseDir = options.dir;
        context = { mode: 'explicit-dir' };
      } else {
        const defaultDir = process.cwd();

        if (format === 'table' && process.stdin.isTTY && !isRecognizedAgentDir(defaultDir)) {
          const agents = getKnownAgents();
          const selected = await promptAgentDir(defaultDir, agents, slug, 'install');
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
      }

      // Unified root guard: reject system root regardless of --dir or CWD origin.
      // Mirrors pack-install.ts — resolve symlinks first, then check.
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

      // --dir preflight: validate directory exists and is writable (after root guard).
      if (typeof options.dir === 'string') {
        const dirFailure = checkInstallDirectory(options.dir);
        if (dirFailure) {
          if (format === 'json') {
            // Structured error: same wording as the plain-text block below,
            // minus the \u2717 marker (a rendering concern) and with the two
            // paragraphs joined into a single message.
            handleError(
              dirFailure === 'not-exist'
                ? new CliError({
                    code: 'INSTALL_DIR_NOT_FOUND',
                    message:
                      `Installation failed: target directory does not exist: ${options.dir}. ` +
                      'Please provide an existing writable directory and rerun the command.',
                    exitCode: EXIT_CODES.GENERAL_ERROR,
                  })
                : new CliError({
                    code: 'INSTALL_DIR_NOT_WRITABLE',
                    message:
                      `Installation failed: no permission to write to the target directory: ${options.dir}. ` +
                      'Please provide an existing writable directory or update its permissions, then rerun the command.',
                    exitCode: EXIT_CODES.GENERAL_ERROR,
                  }),
              format,
            );
          }
          // Only the \u2717 marker is colored, and only for the TUI (table)
          // format; text stays plain per the tri-state output contract.
          const cross = format === 'table' ? theme.errorForced('\u2717') : '\u2717';
          process.stderr.write(
            dirFailure === 'not-exist'
              ? `${cross} Installation failed: target directory does not exist: ${options.dir}.\n\n` +
                  'Please provide an existing writable directory and rerun the command.\n'
              : `${cross} Installation failed: no permission to write to the target directory: ${options.dir}.\n\n` +
                  'Please provide an existing writable directory or update its permissions, then rerun the command.\n',
          );
          process.exitCode = EXIT_CODES.GENERAL_ERROR;
          return;
        }
        if (format === 'table') {
          const location = parsed ? path.join(baseDir, parsed.skillName) : path.join(baseDir, slug);
          console.log(
            'Using explicit installation directory\n\n' + `Install location: ${location}\n`,
          );
        }
      }

      // Slug-conflict precheck: detect whether a different skill occupies
      // the target directory and resolve via interactive confirmation,
      // automatic override (--dir), or non-TTY rejection.
      const conflict = skillsInstallService.precheckSlugConflict(
        slug,
        baseDir,
        preloadedDetail?.provider,
      );
      let allowSlugOverwrite = false;
      if (conflict) {
        if (format === 'table' && process.stdin.isTTY && typeof options.dir !== 'string') {
          const detailForVersion =
            preloadedDetail ??
            (await skillsHubService.getSkillDetail(
              parsed ? parsed.skillName : slug,
              parsed?.provider,
            ));
          const toInstallVersion = detailForVersion.latestVersion || 'unknown';
          const confirmed = await promptSkillOverrideConfirm(
            conflict,
            parsed ? `${parsed.provider}/${parsed.skillName}` : slug,
            toInstallVersion,
          );
          if (!confirmed) {
            process.stderr.write('Installation cancelled by user.\n');
            process.exitCode = 0;
            return;
          }
          allowSlugOverwrite = true;
        } else if (typeof options.dir === 'string') {
          if (format !== 'json') {
            process.stderr.write(
              `override: Replaced ${conflict.existingSlug} ${conflict.existingVersion}\n`,
            );
          }
          allowSlugOverwrite = true;
        } else {
          const message =
            `Target directory is occupied by a different skill ` +
            `(${conflict.existingSlug} ${conflict.existingVersion}). ` +
            `Use --dir to explicitly override, or run in an interactive terminal.`;
          if (format === 'json') {
            handleError(
              new CliError({
                code: 'SLUG_CONFLICT',
                message,
                exitCode: EXIT_CODES.GENERAL_ERROR,
              }),
              format,
            );
          }
          process.stderr.write(message + '\n');
          process.exitCode = EXIT_CODES.GENERAL_ERROR;
          return;
        }
      }

      const data = await withSpinner(
        `Installing ${slug}`,
        () =>
          skillsInstallService.install({
            slug,
            baseDir,
            preloadedDetail,
            ...(parsed ? { parsedSlug: parsed } : {}),
            ...(allowSlugOverwrite ? { allowSlugOverwrite: true } : {}),
          }),
        format,
      );

      if (format === 'json') {
        outputJSON({
          slug: data.slug,
          version: data.version,
          outcome: data.outcome,
          targetDir: data.targetDir,
          sha256: data.sha256,
          ...(data.downgrade ? { downgrade: data.downgrade } : {}),
          ...(data.requiresApiKey === true ? { requiresApiKey: true } : {}),
          ...(data.overwritten
            ? {
                overwritten: true,
                previousSlug: data.previousSlug,
                previousVersion: data.previousVersion,
              }
            : {}),
        });
        return;
      }

      const vm = buildSkillsInstallViewModel(data, context);

      if (format === 'text') {
        renderTextSkillsInstall(vm);
        return;
      }

      await renderSkillsInstallInk(vm);
    } catch (error) {
      // A HandledError from the --dir preflight above has already been
      // formatted and printed — re-throw so it is not classified twice.
      if (error instanceof HandledError) throw error;
      const cliError = toSkillsCliError(error);
      const SLUG_HINT_CODES = new Set(['SKILL_NOT_FOUND', 'PACK_NOT_FOUND']);
      if (!isFullSlug && !cliError.hint && SLUG_HINT_CODES.has(cliError.code)) {
        // A bare-slug failure may mean the hub could not resolve the skill
        // — guide toward searching first to discover the full slug.
        handleError(
          new CliError({
            code: cliError.code,
            message: cliError.message,
            exitCode: cliError.exitCode,
            ...(cliError.detail ? { detail: cliError.detail } : {}),
            hint:
              'Try searching first: skills search <keyword>, ' +
              'then install with the full slug from the results.',
          }),
          format,
        );
      }
      handleError(cliError, format);
    }
  };
}

export function registerSkillsInstallCommand(parent: Command): Command {
  const install = parent
    .command('install <slug>')
    .description('Download and install a skill from SkillHub')
    .option('--dir <directory>', 'Directory to install into (default: current directory)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  addExamples(install, [
    formatCmd('skills install @qianwen-ai/qianwen-find-skills'),
    formatCmd('skills install @qianwen-ai/qianwen-find-skills --dir ./skills --format json'),
  ]);
  install.action(skillsInstallAction(install));
  return install;
}
