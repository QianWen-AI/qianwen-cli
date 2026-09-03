import { Command } from 'commander';

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
