/**
 * Runtime mode detection — distinguishes REPL (interactive) from one-shot mode.
 *
 * In REPL mode, users are already inside the CLI, so hints like
 * "Run: login" suffice. In one-shot mode the full "Run: <cliName> login"
 * is needed because the user invokes commands directly from the shell.
 */

import { site } from '../site.js';

let _isRepl = false;

/** Mark the current process as running in REPL mode. Call once at REPL startup. */
export function setReplMode(): void {
  _isRepl = true;
}

/** Whether the CLI is currently running in REPL / interactive mode. */
export function isReplMode(): boolean {
  return _isRepl;
}

/**
 * Return the appropriate login command hint for the current runtime mode.
 * - REPL:     `"login"`
 * - One-shot: `"qianwen login"`
 */
export function loginCommand(): string {
  return _isRepl ? 'login' : `${site.cliName} login`;
}

/**
 * Format a CLI command for display in user-facing messages.
 * - REPL:     returns `cmd` as-is (e.g. `"auth logout"`)
 * - One-shot: returns with prefix (e.g. `"qianwen auth logout"`)
 */
export function formatCmd(cmd: string): string {
  return _isRepl ? cmd : `${site.cliName} ${cmd}`;
}
