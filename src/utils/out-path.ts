import { accessSync, constants, existsSync, mkdirSync, statSync } from 'fs';
import { dirname } from 'path';
import { CliError } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';
import { friendlyFsMessage } from './api-errors.js';

function toIoError(error: unknown): CliError {
  const message = friendlyFsMessage(error) ?? 'Cannot write the output path.';
  return new CliError({ code: 'IO_ERROR', message, exitCode: EXIT_CODES.GENERAL_ERROR });
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Verify that `out` can be written before starting a billable generation.
 * Resolves the target directory the way the downloader does, creates it when
 * missing, and checks write access. Throws an IO_ERROR CliError otherwise.
 * A trailing-slash or existing-directory `out` is treated as a directory.
 */
export function preflightOutPath(out: string | undefined): void {
  if (out === undefined || out.length === 0) return;

  const treatAsDir = out.endsWith('/') || isDir(out);
  const dir = treatAsDir ? out.replace(/\/+$/, '') || '/' : dirname(out) || '.';

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw toIoError(error);
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch (error) {
    throw toIoError(error);
  }
}
