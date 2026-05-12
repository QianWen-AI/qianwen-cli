import type { Command } from 'commander';
import { registerLoginCommand } from './login.js';
import { registerLogoutCommand } from './logout.js';
import { registerStatusCommand } from './status.js';

/**
 * Register all auth subcommands on a Commander command.
 * Also registers top-level login/logout aliases on the program root.
 */
export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('Manage authentication (login / logout / status)');

  // Register subcommands under `auth`
  registerLoginCommand(auth);
  registerLogoutCommand(auth);
  registerStatusCommand(auth);

  auth.action(() => {
    auth.outputHelp();
    process.stdout.write('\n');
  });

  // Top-level aliases: `qianwen login` and `qianwen logout`
  registerLoginCommand(program);
  registerLogoutCommand(program);
}
