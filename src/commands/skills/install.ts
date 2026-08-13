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
import { theme } from '../../ui/theme.js';
import { handleError, HandledError, CliError, invalidArgError } from '../../utils/errors.js';
import { isValidSlug, MAX_SLUG_LENGTH } from '../../utils/skills-security.js';
import { isRecognizedAgentDir, getKnownAgents } from '../../utils/agent-dirs.js';
import { promptAgentDir } from '../../ui/AgentDirPrompt.js';
import { toSkillsCliError } from './search.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';

type InstallDirFailure = 'not-exist' | 'not-writable';

// A path that exists but is not a directory is reported as 'not-exist' per the install API contract.
function checkInstallDirectory(dir: string): InstallDirFailure | null {
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
    if (!isValidSlug(slug)) {
      const message =
        `Invalid skill name: must be 1-${MAX_SLUG_LENGTH} characters of letters, digits, ` +
        'hyphens or underscores, starting and ending with a letter or digit.';
      if (format === 'json') handleError(invalidArgError(message), format);
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
        preloadedDetail = await withSpinner(
          `Checking ${slug}`,
          () => skillsHubService.getSkillDetail(slug),
          format,
        );
      }

      let baseDir: string;
      let context: SkillsInstallContext = { mode: 'current-dir' };
      if (typeof options.dir === 'string') {
        // Preflight check:
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
        baseDir = options.dir;
        context = { mode: 'explicit-dir' };
        if (format === 'table') {
          console.log(
            'Using explicit installation directory\n\n' +
              `Install location: ${path.join(baseDir, slug)}\n`,
          );
        }
      } else {
        const defaultDir = process.cwd();

        if (format === 'table' && !isRecognizedAgentDir(defaultDir)) {
          const agents = getKnownAgents();
          const selected = await promptAgentDir(defaultDir, agents, slug);
          if (selected === null) {
            process.exitCode = 0;
            return;
          }
          baseDir = selected.path;
          if (selected.agent) {
            context = { mode: 'agent', agentDisplayName: selected.agent.displayName };
            // Agent skills directories may not exist yet; cwd always does.
            fs.mkdirSync(baseDir, { recursive: true });
          }
        } else {
          baseDir = defaultDir;
        }
      }
      const data = await withSpinner(
        `Installing ${slug}`,
        () => skillsInstallService.install({ slug, baseDir, preloadedDetail }),
        format,
      );

      if (format === 'json') {
        outputJSON({
          slug: data.slug,
          version: data.version,
          outcome: data.outcome,
          targetDir: data.targetDir,
          security: data.securityLabel,
          sha256: data.sha256,
          ...(data.downgrade ? { downgrade: data.downgrade } : {}),
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
      handleError(toSkillsCliError(error), format);
    }
  };
}

export function registerSkillsInstallCommand(parent: Command): Command {
  const install = parent
    .command('install <slug>')
    .description('Download and install a skill from SkillHub')
    .option('--dir <directory>', 'Directory to install into (default: current directory)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  install.action(skillsInstallAction(install));
  return install;
}
