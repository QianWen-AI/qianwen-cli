import { Command } from 'commander';
import { resolveCredentials, deleteCredentials } from '../../auth/credentials.js';
import { createClient } from '../../api/client.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError } from '../../utils/errors.js';
import { theme } from '../../ui/theme.js';
import type { ResolvedFormat } from '../../types/config.js';

export function registerLogoutCommand(parent: Command): void {
  parent
    .command('logout')
    .description('Log out and remove stored credentials')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async function (this: Command, _opts) {
      const config = getEffectiveConfig();
      const format = resolveFormatFromCommand(this, config);
      try {
        await runLogout(format);
      } catch (error) {
        handleError(error, format);
      }
    });
}

async function runLogout(format: ResolvedFormat): Promise<void> {
  // Check if user is authenticated before attempting logout
  const resolved = resolveCredentials();

  if (!resolved) {
    if (format === 'json') {
      printJSON({ success: true, message: 'Not logged in' });
    } else {
      console.log(`  Not logged in`);
    }
    return;
  }

  // Step 1: Server-side token revocation (best-effort)
  try {
    const client = await createClient();
    await client.revokeSession();
  } catch {
    // Best-effort: network failure is acceptable, local cleanup proceeds
  }

  // Step 2: Local credential cleanup (always proceeds — clears both keychain and file)
  deleteCredentials();

  if (format === 'json') {
    printJSON({ success: true, message: 'Logged out', source: resolved.source });
    return;
  }

  // table / text
  console.log(`  ${theme.success(theme.symbols.pass)} Logged out successfully`);
}
