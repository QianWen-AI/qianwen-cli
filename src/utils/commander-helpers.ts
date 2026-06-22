import { Command } from 'commander';

// ── Commander internal property helpers — centralized for upgrade safety ──────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Commander internal access
type AnyCommand = any;

export function isHiddenCommand(cmd: Command): boolean {
  return (cmd as AnyCommand)._hidden === true;
}

// getCommandArgs reads commander's public `registeredArguments` (no underscore
// prefix), so production property mangling cannot break positional-arg lookup.
export function getCommandArgs(cmd: Command): Array<{ name: () => string; required: boolean }> {
  return (
    ((cmd as AnyCommand).registeredArguments as Array<{ name: () => string; required: boolean }>) ??
    []
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
