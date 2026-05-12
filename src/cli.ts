import { Command } from 'commander';
import { VERSION } from './index.js';
import { registerModelsCommands as registerModelsCommandsImpl } from './commands/models/index.js';
import { registerConfigCommands } from './commands/config/index.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerVersionCommand, registerUpdateCommand } from './commands/version.js';
import { isReplMode } from './utils/runtime-mode.js';
import {
  usageSummaryAction,
  usageBreakdownAction,
  registerUsageActions,
} from './commands/usage/index.js';
import { registerAuthCommands } from './commands/auth/index.js';
import { site } from './site.js';

// ---------------------------------------------------------------------------
// Custom help formatter to match PRD §7.0 format
// ---------------------------------------------------------------------------

function padCmd(name: string, width: number): string {
  return name.padEnd(width);
}

/**
 * Build a fully custom help string for a Command.
 * Returns the PRD-style help text (L0 / L1 / L2).
 */
function formatHelp(cmd: Command): string {
  const lines: string[] = [];
  const indent = '  ';

  // --- Usage line ---
  // In REPL mode, strip the root program name so help reads
  // "Usage: models …" instead of "Usage: <cliName> models …".
  const isRoot = !cmd.parent;
  const fullName = isReplMode() && isRoot ? '' : cmd.name();
  const ancestors: string[] = [];
  let p = cmd.parent;
  while (p) {
    // Skip the root program name in REPL mode
    if (!(isReplMode() && !p.parent)) {
      ancestors.unshift(p.name());
    }
    p = p.parent;
  }
  const prefix = ancestors.length ? ancestors.join(' ') + ' ' : '';
  const subs = cmd.commands.filter((c) => !isHiddenCommand(c));
  const hasSubcommands = subs.length > 0;
  // A command is "root" when it has no parent (the actual program root).
  // In REPL mode ancestors may be empty even for L1 commands (models, auth …)
  // because the root name is stripped, so use `isRoot` for level detection.

  // Determine usage suffix
  let usageSuffix: string;
  if (isRoot && hasSubcommands) {
    // L0: <cliName> <command> [flags]
    usageSuffix = '<command> [flags]';
  } else if (hasSubcommands) {
    usageSuffix = '<subcommand> [flags]';
  } else {
    // Collect arguments
    const args = getCommandArgs(cmd);
    const argParts: string[] = [];
    if (args) {
      for (const a of args) {
        argParts.push(a.required ? `<${a.name()}>` : `[${a.name()}]`);
      }
    }
    usageSuffix = [...argParts, '[flags]'].join(' ');
  }

  const namePart = [prefix, fullName].filter(Boolean).join('');
  lines.push(`${indent}Usage: ${namePart ? namePart + ' ' : ''}${usageSuffix}`);
  lines.push('');

  // --- Description ---
  const desc = getLongDescription(cmd);
  if (desc) {
    lines.push(`${indent}${desc}`);
    lines.push('');
  }

  // --- Subcommands / Commands ---
  if (hasSubcommands) {
    const label = isRoot ? 'Commands' : 'Subcommands';
    lines.push(`${indent}${label}:`);

    // Calculate max name length for padding
    const maxLen = Math.max(
      ...subs.map((s) => {
        const sArgs = getCommandArgs(s);
        const argStr = sArgs.length
          ? sArgs.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ')
          : '';
        return (s.name() + (argStr ? ' ' + argStr : '')).length;
      }),
    );

    for (const sub of subs) {
      const subArgs = getCommandArgs(sub);
      const argStr = subArgs.length
        ? subArgs.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ')
        : '';
      const nameWithArgs = sub.name() + (argStr ? ' ' + argStr : '');
      lines.push(`${indent}  ${padCmd(nameWithArgs, maxLen + 4)}${sub.description()}`);
    }
    lines.push('');
  }

  // --- Flags ---
  lines.push(`${indent}Flags:`);
  // Collect visible options + always include -h, --help
  const opts = cmd.options.filter((o) => !o.hidden);
  // Build flag entries in PRD order: regular opts, -h/--help, then -v/--version at end
  type FlagEntry = { flags: string; desc: string };
  const flagEntries: FlagEntry[] = [];
  // Regular options (non-version, non-help)
  for (const o of opts) {
    if (o.long === '--version') continue; // will be appended at end
    flagEntries.push({ flags: o.flags, desc: o.description });
  }
  flagEntries.push({ flags: '-h, --help', desc: 'Show this help' });
  // Version flag last (only on top-level)
  const versionOpt = opts.find((o) => o.long === '--version');
  if (versionOpt) {
    flagEntries.push({ flags: versionOpt.flags, desc: versionOpt.description });
  }
  const maxOptLen = Math.max(...flagEntries.map((f) => f.flags.length));
  for (const f of flagEntries) {
    lines.push(`${indent}  ${padCmd(f.flags, maxOptLen + 4)}${f.desc}`);
  }
  lines.push('');

  // --- Examples (stored via .summary()) ---
  const examples = getCommandExamples(cmd);
  if (examples.length > 0) {
    lines.push(`${indent}Examples:`);
    for (const ex of examples) {
      lines.push(`${indent}  ${ex}`);
    }
    lines.push('');
  }

  // --- Footer ---
  if (hasSubcommands) {
    if (isRoot) {
      lines.push(
        `${indent}Run ${fullName ? fullName + ' ' : ''}<command> --help for command-specific help.`,
      );
    } else {
      const cmdPath = [prefix, fullName].filter(Boolean).join('');
      lines.push(
        `${indent}Run ${cmdPath ? cmdPath + ' ' : ''}<subcommand> --help for subcommand-specific help.`,
      );
    }
  }

  return lines.join('\n');
}

// ── Commander internal property helpers — centralized for upgrade safety ──────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Commander internal access
type AnyCommand = any;

function isHiddenCommand(cmd: Command): boolean {
  return (cmd as AnyCommand)._hidden === true;
}

function getCommandArgs(cmd: Command): Array<{ name: () => string; required: boolean }> {
  return ((cmd as AnyCommand)._args as Array<{ name: () => string; required: boolean }>) ?? [];
}

function getCommandExamples(cmd: Command): string[] {
  return ((cmd as AnyCommand)._examples as string[]) ?? [];
}

function setCommandHidden(cmd: Command, hidden: boolean): void {
  (cmd as AnyCommand)._hidden = hidden;
}

// Helper: set a long description for L1/L2 help (distinct from the short one shown in parent listing)
function setLongDescription(cmd: Command, desc: string): void {
  (cmd as AnyCommand)._longDescription = desc;
}

function getLongDescription(cmd: Command): string {
  return ((cmd as AnyCommand)._longDescription as string) || cmd.description();
}

// Helper: add examples metadata to a command
function addExamples(cmd: Command, examples: string[]): void {
  (cmd as AnyCommand)._examples = examples;
}

// ---------------------------------------------------------------------------
// Apply custom help to every command recursively
// ---------------------------------------------------------------------------

function applyCustomHelp(cmd: Command): void {
  cmd.configureHelp({
    formatHelp: () => formatHelp(cmd),
  });
  cmd.helpOption('-h, --help', 'Show this help');
  for (const sub of cmd.commands) {
    applyCustomHelp(sub);
  }
}

// Apply .exitOverride() and silence Commander's default writeErr on every
// subcommand so a missing `<id>` arg under `models info`, an unknown subcommand
// under `usage`, etc. all surface through bin/qianwen.ts as structured JSON
// when --format json is in effect.
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {} });
  for (const sub of cmd.commands) {
    applyExitOverride(sub);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

// Auth commands are now imported from src/commands/auth/index.ts

function registerModelsCommands(program: Command): void {
  // Delegate to real implementation
  registerModelsCommandsImpl(program);

  // Apply descriptions and examples to the registered commands
  const models = program.commands.find((c) => c.name() === 'models')!;
  setLongDescription(models, `Browse, search, and inspect available models on ${site.cliDisplayName}.`);

  const list = models.commands.find((c) => c.name() === 'list')!;
  setLongDescription(list, 'List available models with pricing, modality, and free tier info.');
  addExamples(list, [
    `${site.cliName} models list`,
    `${site.cliName} models list --input image --output text`,
    `${site.cliName} models list --all --format json`,
  ]);

  const info = models.commands.find((c) => c.name() === 'info')!;
  addExamples(info, [
    `${site.cliName} models info qwen3.6-plus`,
    `${site.cliName} models info qwen3.6-plus --format json`,
  ]);

  const search = models.commands.find((c) => c.name() === 'search')!;
  addExamples(search, [
    `${site.cliName} models search "function calling"`,
    `${site.cliName} models search image --format json`,
  ]);
}

function registerUsageCommandsWithMeta(program: Command): void {
  const usage = program.command('usage').description('View usage and billing');

  const summaryCmd = usage
    .command('summary')
    .description('Show usage summary across all models')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option(
      '--period <preset>',
      'Period preset: today, yesterday, week, month, last-month, quarter, year, YYYY-MM',
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  // Wire up the real summary action
  summaryCmd.action(usageSummaryAction(summaryCmd));

  addExamples(summaryCmd, [
    `${site.cliName} usage summary`,
    `${site.cliName} usage summary --period last-month --format json`,
  ]);

  const breakdownCmd = usage
    .command('breakdown')
    .description('Show per-day/month/quarter usage for a model (PAYG only)')
    // Use .option (not .requiredOption) so the missing --model case is handled
    // by the action's structured invalidArgError, giving Agents a parseable
    // {"error":...} JSON instead of Commander's bare `error: required option ...`.
    .option('--model <id>', 'Model ID (required)')
    .option('--granularity <g>', 'Time granularity: day, month, quarter (default: day)')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option(
      '--period <preset>',
      'Period preset: today, yesterday, week, month, last-month, quarter, year, YYYY-MM',
    )
    .option('--days <n>', 'Number of days to look back')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  breakdownCmd.action(usageBreakdownAction(breakdownCmd));

  setLongDescription(
    breakdownCmd,
    `Show usage breakdown for a specific model (time-series).\n\n  Note: PAYG only — free tier consumption is not available as a historical\n  series. Use \`${site.cliName} usage free-tier\` for current quota state.`,
  );

  addExamples(breakdownCmd, [
    `${site.cliName} usage breakdown --model qwen-plus --period last-month --granularity month`,
    `${site.cliName} usage breakdown --model qwen-plus --days 7 --format json`,
  ]);

  const freeTierCmd = usage
    .command('free-tier')
    .description('Browse all free tier models with quota status')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option(
      '--period <preset>',
      'Period preset: today, yesterday, week, month, last-month, quarter, year, YYYY-MM',
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  addExamples(freeTierCmd, [
    `${site.cliName} usage free-tier`,
    `${site.cliName} usage free-tier --format json`,
  ]);

  const paygCmd = usage
    .command('payg')
    .description('Browse pay-as-you-go usage across all models')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option(
      '--period <preset>',
      'Period preset: today, yesterday, week, month, last-month, quarter, year, YYYY-MM',
    )
    .option('--days <n>', 'Number of days to look back')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  addExamples(paygCmd, [
    `${site.cliName} usage payg`,
    `${site.cliName} usage payg --period last-month`,
    `${site.cliName} usage payg --from 2026-01-01 --to 2026-03-31`,
  ]);

  // Register remaining usage actions
  registerUsageActions(summaryCmd, breakdownCmd, freeTierCmd, paygCmd);

  usage.action(() => {
    usage.outputHelp();
    process.stdout.write('\n');
  });
}

// Config commands are now in src/commands/config/index.ts

// Doctor command is now in src/commands/doctor.ts

// Completion command is now in src/commands/completion.ts

// Version command is now in src/commands/version.ts

// Update command is now in src/commands/version.ts

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createProgram(): Command {
  const program = new Command();

  program
    .name(site.cliName)
    .description(`Manage ${site.cliDisplayName} models, usage, and configuration from your terminal.`)
    .version(VERSION, '-v, --version', 'Show version')
    .option('--format <table|json|text>', 'Output format (default: auto)')
    .option('-q, --quiet', 'Suppress all output; rely on exit code only');

  // Register all command groups
  registerAuthCommands(program);
  registerModelsCommands(program);
  registerUsageCommandsWithMeta(program);
  registerConfigCommands(program);
  registerDoctorCommand(program);
  registerCompletionCommand(program);
  registerVersionCommand(program);
  registerUpdateCommand(program);

  // Hide the top-level login/logout aliases from L0 help
  const loginAlias = program.commands.find((c) => c.name() === 'login');
  if (loginAlias) setCommandHidden(loginAlias, true);
  const logoutAlias = program.commands.find((c) => c.name() === 'logout');
  if (logoutAlias) setCommandHidden(logoutAlias, true);
  // Hide update from L0 help (not in PRD L0 example)
  const updateAlias = program.commands.find((c) => c.name() === 'update');
  if (updateAlias) setCommandHidden(updateAlias, true);

  // Apply custom help formatting to all commands
  applyCustomHelp(program);
  applyExitOverride(program);

  // Override the top-level help to match PRD L0 exactly
  program.configureHelp({
    formatHelp: () => formatHelp(program),
  });

  return program;
}
