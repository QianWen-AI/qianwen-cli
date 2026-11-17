import { Command } from 'commander';
import { theme } from '../ui/theme.js';

// ── Commander internal property helpers — centralized for upgrade safety ──────

interface CommandErrorSupplement {
  code: string;
  message: string;
  supplement: string;
}

const commandErrorSupplements = new WeakMap<Command, CommandErrorSupplement[]>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Commander internal access
type AnyCommand = any;

export function isHiddenCommand(cmd: Command): boolean {
  return (cmd as AnyCommand)._hidden === true;
}

// getCommandArgs reads commander's public `registeredArguments` (no underscore
// prefix), so production property mangling cannot break positional-arg lookup.
export function getCommandArgs(
  cmd: Command,
): Array<{ name: () => string; required: boolean; description: string; variadic: boolean }> {
  return (
    ((cmd as AnyCommand).registeredArguments as Array<{
      name: () => string;
      required: boolean;
      description: string;
      variadic: boolean;
    }>) ?? []
  );
}

export function getCommandExamples(cmd: Command): string[] {
  return ((cmd as AnyCommand)._examples as string[]) ?? [];
}

export function getCommandHelpGroup(cmd: Command): string | undefined {
  return (cmd as AnyCommand)._helpGroup as string | undefined;
}

export function getCommandHelpOrder(cmd: Command): number | undefined {
  return (cmd as AnyCommand)._helpOrder as number | undefined;
}

export function setCommandHidden(cmd: Command, hidden: boolean): void {
  (cmd as AnyCommand)._hidden = hidden;
}

export function setCommandHelpMetadata(cmd: Command, group: string, order: number): void {
  (cmd as AnyCommand)._helpGroup = group;
  (cmd as AnyCommand)._helpOrder = order;
}

export function setLongDescription(cmd: Command, desc: string): void {
  (cmd as AnyCommand)._longDescription = desc;
}

export function getLongDescription(cmd: Command): string {
  return ((cmd as AnyCommand)._longDescription as string) || cmd.description();
}

export function addExamples(cmd: Command, examples: string[]): void {
  (cmd as AnyCommand)._examples = examples;
}

export interface OptionSpec {
  long: string;
  description: string;
  choices: string[];
  takesArg: boolean;
  completion?: 'file' | 'directory';
}

export interface ArgSpec {
  name: string;
  required: boolean;
  variadic: boolean;
  choices?: string[];
  completion?: 'file' | 'directory';
}

export interface CommandNode {
  name: string;
  aliases: string[];
  description: string;
  options: OptionSpec[];
  args: ArgSpec[];
  subcommands: CommandNode[];
}

export interface ExtractCommandTreeOptions {
  includeHidden?: boolean;
}

// A value-taking option is `required` XOR `optional`; a boolean flag is
// neither — hence takesArg ORs the two. argChoices holds `.choices()` values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Commander Option access
type AnyOption = any;

function pathCompletion(name: string): 'file' | 'directory' | undefined {
  if (/^(?:dir|directory)$/.test(name)) return 'directory';
  if (/(?:^|[-|])(?:file|path)(?:$|[-|])/.test(name)) return 'file';
  return undefined;
}

function toOptionSpec(option: AnyOption): OptionSpec {
  const argumentName = /[<[]([^>\]]+)[>\]]/.exec(String(option.flags))?.[1] ?? '';
  const completion =
    option.long === '--dir' || option.long === '--directory'
      ? 'directory'
      : pathCompletion(argumentName);
  return {
    long: option.long as string,
    description: (option.description as string) ?? '',
    choices: (option.argChoices as string[] | undefined) ?? [],
    takesArg: option.required === true || option.optional === true,
    ...(completion ? { completion } : {}),
  };
}

export function extractCommandTree(
  program: Command,
  { includeHidden = false }: ExtractCommandTreeOptions = {},
): CommandNode[] {
  return program.commands
    .filter((cmd) => includeHidden || !isHiddenCommand(cmd))
    .map((cmd) => ({
      name: cmd.name(),
      aliases: cmd.aliases(),
      description: getLongDescription(cmd),
      options: cmd.options.filter((o) => !o.hidden && o.long).map(toOptionSpec),
      args: getCommandArgs(cmd).map((a) => ({
        name: a.name(),
        required: a.required,
        variadic: a.variadic,
        ...(pathCompletion(a.name()) ? { completion: pathCompletion(a.name()) } : {}),
      })),
      subcommands: extractCommandTree(cmd, { includeHidden }),
    }));
}

/**
 * Style a help section title identically to the built-in headings rendered by
 * {@link formatHelp} in cli.ts.  Designed for use inside `addHelpText('after', …)`
 * so that custom sections ("Agent automation:", "Team seat rules:", etc.) match
 * the appearance of standard sections ("Arguments:", "Flags:", "Examples:").
 *
 * Commander decides whether the active output supports colors and strips ANSI
 * when it does not, so this helper must consistently provide the styled form.
 */
export function styleHelpSectionTitle(text: string): string {
  return theme.help.sectionTitle(text);
}

export function addCommandErrorSupplement(cmd: Command, supplement: CommandErrorSupplement): void {
  const supplements = commandErrorSupplements.get(cmd) ?? [];
  supplements.push(supplement);
  commandErrorSupplements.set(cmd, supplements);
}

export function getCommandErrorSupplement(
  cmd: Command,
  error: { code?: string; message?: string },
): string | undefined {
  return commandErrorSupplements
    .get(cmd)
    ?.find((candidate) => candidate.code === error.code && candidate.message === error.message)
    ?.supplement;
}
