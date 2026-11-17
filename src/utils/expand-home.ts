import { homedir } from 'node:os';
import path from 'node:path';

export function isHomePath(input: string): boolean {
  return (
    input === '~' ||
    input.startsWith('~/') ||
    (process.platform === 'win32' && input.startsWith('~\\'))
  );
}

/** Expand only a leading home marker in filesystem arguments, not shell expressions. */
export function expandHomePath(input: string): string {
  return isHomePath(input) ? path.join(homedir(), input.slice(2)) : input;
}
