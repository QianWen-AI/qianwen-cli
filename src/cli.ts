// Third-party
import { Command } from 'commander';

// Project metadata & runtime helpers
import { VERSION } from './index.js';
import { site } from './site.js';
import { theme } from './ui/theme.js';
import { isReplMode, formatCmd } from './utils/runtime-mode.js';

// Command groups (alphabetical by feature directory)
import { registerAuthCommands } from './commands/auth/index.js';
import { registerBillingCommands } from './commands/billing/index.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerConfigCommands } from './commands/config/index.js';
import { registerDocsCommands } from './commands/docs/index.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerModelsCommands as registerModelsCommandsImpl } from './commands/models/index.js';
import { registerSubscriptionCommands } from './commands/subscription/index.js';
import {
  usageBreakdownAction,
  usageSummaryAction,
  registerUsageActions,
} from './commands/usage/index.js';
import { collectRepeatable } from './commands/usage/logs.js';
import { registerUpdateCommand, registerVersionCommand } from './commands/version.js';
import { registerWorkspaceCommands } from './commands/workspace/index.js';
import { setCommandHelpMetadata } from './utils/commander-helpers.js';

// ---------------------------------------------------------------------------
// Custom help formatter to match PRD §7.0 format
// ---------------------------------------------------------------------------

function padCmd(name: string, width: number): string {
  return name.padEnd(width);
}

// Help styling helpers — only emit ANSI in REPL mode, matching upstream
// behavior. Plain-pipe / one-shot output stays free of escape codes so
// downstream consumers (grep, agent stdout parsers) see clean text.
function styleSectionTitle(text: string): string {
  return isReplMode() ? theme.help.sectionTitle(text) : text;
}

function styleGroupTitle(text: string): string {
  return isReplMode() ? theme.help.groupTitle(text) : text;
}

function styleCommandName(text: string): string {
  return isReplMode() ? theme.help.commandName(text) : text;
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
  const visibleSubs = cmd.commands.filter((c) => !isHiddenCommand(c));
  const shouldGroupRootCommands = isRoot && visibleSubs.some((c) => getCommandHelpGroup(c));
  const subs = shouldGroupRootCommands ? [...visibleSubs].sort(compareCommands) : visibleSubs;
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
    lines.push(`${indent}${styleSectionTitle(`${label}:`)}`);

    // Calculate max name length for padding
    const maxLen = Math.max(...subs.map((s) => commandNameWithArgs(s).length));

    if (shouldGroupRootCommands) {
      const groups = new Map<string, Command[]>();
      for (const sub of subs) {
        const groupName = getCommandHelpGroup(sub) ?? 'Other';
        const group = groups.get(groupName) ?? [];
        group.push(sub);
        groups.set(groupName, group);
      }

      const groupedEntries = [...groups.entries()].sort(([, a], [, b]) => {
        const firstA = a[0] ? commandHelpOrder(a[0]) : Number.MAX_SAFE_INTEGER;
        const firstB = b[0] ? commandHelpOrder(b[0]) : Number.MAX_SAFE_INTEGER;
        return firstA - firstB;
      });

      for (const [groupName, groupCommands] of groupedEntries) {
        lines.push(`${indent}  ${styleGroupTitle(`${groupName}:`)}`);
        for (const sub of groupCommands.sort(compareCommands)) {
          const nameWithArgs = commandNameWithArgs(sub);
          const padded = padCmd(nameWithArgs, maxLen + 4);
          lines.push(`${indent}    ${styleCommandName(padded)}${sub.description()}`);
        }
      }
    } else {
      for (const sub of subs) {
        const nameWithArgs = commandNameWithArgs(sub);
        const padded = padCmd(nameWithArgs, maxLen + 4);
        lines.push(`${indent}  ${styleCommandName(padded)}${sub.description()}`);
      }
    }
    lines.push('');
  }

  // --- Flags ---
  lines.push(`${indent}${styleSectionTitle('Flags:')}`);
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
    lines.push(`${indent}${styleSectionTitle('Examples:')}`);
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

function getCommandHelpGroup(cmd: Command): string | undefined {
  return (cmd as AnyCommand)._helpGroup as string | undefined;
}

function getCommandHelpOrder(cmd: Command): number | undefined {
  return (cmd as AnyCommand)._helpOrder as number | undefined;
}

function commandNameWithArgs(cmd: Command): string {
  const args = getCommandArgs(cmd);
  const argStr = args.length
    ? args.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ')
    : '';
  return cmd.name() + (argStr ? ' ' + argStr : '');
}

function commandHelpOrder(cmd: Command): number {
  return getCommandHelpOrder(cmd) ?? Number.MAX_SAFE_INTEGER;
}

function compareCommands(a: Command, b: Command): number {
  return commandHelpOrder(a) - commandHelpOrder(b) || a.name().localeCompare(b.name());
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
  setLongDescription(
    models,
    `Browse, search, and inspect available models on ${site.cliDisplayName}.`,
  );

  const list = models.commands.find((c) => c.name() === 'list')!;
  setLongDescription(list, 'List available models with pricing, modality, and free tier info.');
  addExamples(list, [
    formatCmd('models list'),
    formatCmd('models list --input image --output text'),
    formatCmd('models list --all --format json'),
  ]);

  const info = models.commands.find((c) => c.name() === 'info')!;
  addExamples(info, [
    formatCmd('models info qwen3.6-plus'),
    formatCmd('models info qwen3.6-plus --format json'),
  ]);

  const search = models.commands.find((c) => c.name() === 'search')!;
  addExamples(search, [
    formatCmd('models search "function calling"'),
    formatCmd('models search image --format json'),
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
    formatCmd('usage summary'),
    formatCmd('usage summary --period last-month --format json'),
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
    `Show usage breakdown for a specific model (time-series).\n\n  Note: PAYG only — free tier consumption is not available as a historical\n  series. Use \`${formatCmd('usage free-tier')}\` for current quota state.`,
  );

  addExamples(breakdownCmd, [
    formatCmd('usage breakdown --model qwen-plus --period last-month --granularity month'),
    formatCmd('usage breakdown --model qwen-plus --days 7 --format json'),
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
    formatCmd('usage free-tier'),
    formatCmd('usage free-tier --format json'),
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
    formatCmd('usage payg'),
    formatCmd('usage payg --period last-month'),
    formatCmd('usage payg --from 2026-01-01 --to 2026-03-31'),
  ]);

  const logsCmd = usage
    .command('logs')
    .description('Browse paginated call logs filtered by time, model, and status')
    .option('--from <date>', 'Start date (YYYY-MM-DD or RFC3339)')
    .option('--to <date>', 'End date (YYYY-MM-DD or RFC3339)')
    .option('--period <preset>', 'Period preset: 1h, 24h, 7d, today, yesterday, week, month, ...')
    .option('--model <id>', 'Model id (repeatable)', collectRepeatable)
    .option(
      '--status <type>',
      'Status filter: 0 (cancel), 2xx (success), 4xx (client error), 5xx (server error). Repeatable',
      collectRepeatable,
    )
    .option('--request-id <id>', 'Exact request id; ignores other filters when set')
    .option('--page <n>', 'Page number', (v) => parseInt(v, 10), 1)
    .option('--page-size <n>', 'Page size (1..100)', (v) => parseInt(v, 10), 20)
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  addExamples(logsCmd, [
    formatCmd('usage logs'),
    formatCmd('usage logs --period 24h --status 4xx --status 5xx'),
    formatCmd('usage logs --model qwen-plus --page 2 --page-size 50'),
    formatCmd('usage logs --request-id 12345-abcdef --format json'),
  ]);

  // Register remaining usage actions
  registerUsageActions(summaryCmd, breakdownCmd, freeTierCmd, paygCmd, logsCmd);

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
// Top-level help metadata (group + ordering)
// ---------------------------------------------------------------------------

function setTopLevelHelpMetadata(
  program: Command,
  commandName: string,
  group: string,
  order: number,
): void {
  const command = program.commands.find((c) => c.name() === commandName);
  if (command) setCommandHelpMetadata(command, group, order);
}

function applyTopLevelHelpMetadata(program: Command): void {
  setTopLevelHelpMetadata(program, 'models', 'Core', 110);
  setTopLevelHelpMetadata(program, 'docs', 'Core', 120);

  setTopLevelHelpMetadata(program, 'auth', 'Account & access', 200);
  setTopLevelHelpMetadata(program, 'workspace', 'Account & access', 220);

  setTopLevelHelpMetadata(program, 'usage', 'Usage & billing', 300);
  setTopLevelHelpMetadata(program, 'billing', 'Usage & billing', 310);
  setTopLevelHelpMetadata(program, 'subscription', 'Usage & billing', 320);

  setTopLevelHelpMetadata(program, 'doctor', 'Operations', 400);
  setTopLevelHelpMetadata(program, 'config', 'Operations', 410);
  setTopLevelHelpMetadata(program, 'completion', 'Operations', 420);
  setTopLevelHelpMetadata(program, 'version', 'Operations', 430);

  setTopLevelHelpMetadata(program, 'update', 'Operations', 440);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createProgram(): Command {
  const program = new Command();

  program
    .name(site.cliName)
    .description(
      `Manage ${site.cliDisplayName} models, usage, and configuration from your terminal.`,
    )
    .version(VERSION, '-v, --version', 'Show version')
    .option('--format <table|json|text>', 'Output format (default: auto)')
    .option('-q, --quiet', 'Suppress all output; rely on exit code only');

  // Register all command groups (logical grouping → alphabetical within group)
  // Identity & primary resources
  registerAuthCommands(program);
  registerModelsCommands(program);
  registerUsageCommandsWithMeta(program);

  // Billing & subscription
  registerBillingCommands(program);
  registerSubscriptionCommands(program);

  // Account-scoped resources
  registerWorkspaceCommands(program);

  // Operations & references
  registerDocsCommands(program);

  // Local utilities & meta
  registerConfigCommands(program);
  registerDoctorCommand(program);
  registerCompletionCommand(program);
  registerVersionCommand(program);
  registerUpdateCommand(program);

  applyTopLevelHelpMetadata(program);

  // Hide the top-level login/logout aliases from L0 help
  const loginAlias = program.commands.find((c) => c.name() === 'login');
  if (loginAlias) setCommandHidden(loginAlias, true);
  const logoutAlias = program.commands.find((c) => c.name() === 'logout');
  if (logoutAlias) setCommandHidden(logoutAlias, true);

  // Apply custom help formatting to all commands
  applyCustomHelp(program);
  applyExitOverride(program);

  // Override the top-level help
  program.configureHelp({
    formatHelp: () => formatHelp(program),
  });

  return program;
}
