import { Command } from 'commander';
import { resolveCredentials } from '../../auth/credentials.js';
import { createClient } from '../../api/client.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { formatKeyValue } from '../../output/text.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError } from '../../utils/errors.js';
import { loginCommand } from '../../utils/runtime-mode.js';
import { theme } from '../../ui/theme.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { resetGlobalCache } from '../../utils/cache.js';
import type { ResolvedFormat } from '../../types/config.js';

export function registerStatusCommand(parent: Command): void {
  parent
    .command('status')
    .description('Show current authentication status')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async function (this: Command, _opts) {
      const config = getEffectiveConfig();
      const format = resolveFormatFromCommand(this, config);
      try {
        await runStatus(format);
      } catch (error: any) {
        // Re-throw REPL exit interception — command already printed its output
        if (error?.code === 'repl.exit.intercepted') throw error;
        handleError(error, format);
      }
    });
}

async function runStatus(format: ResolvedFormat): Promise<void> {
  const resolved = resolveCredentials();

  if (!resolved) {
    if (format === 'json') {
      printJSON({ authenticated: false, server_verified: false });
    } else {
      console.log(`  ${theme.error(theme.symbols.fail)} Not authenticated. Run: ${loginCommand()}`);
    }
    process.exit(EXIT_CODES.AUTH_FAILURE);
  }

  const client = await createClient();
  const status = await client.getAuthStatus();

  // Token expired or not authenticated
  if (!status.authenticated) {
    if (format === 'json') {
      printJSON({ authenticated: false, server_verified: false, reason: 'token_expired' });
    } else {
      console.log(`  ${theme.error(theme.symbols.fail)} Not authenticated (token expired)`);
      console.log(`  Run: ${loginCommand()}`);
    }
    resetGlobalCache();
    process.exit(EXIT_CODES.AUTH_FAILURE);
  }

  const credentials = resolved.credentials;

  // Local-only verification (CLI mode — no server call)
  if (format === 'json') {
    printJSON({
      authenticated: true,
      server_verified: status.server_verified,
      auth_mode: resolved.auth_mode,
      source: resolved.source,
      warning: status.warning,
      user: {
        aliyunId: status.user?.aliyunId ?? credentials?.user?.aliyunId ?? '',
      },
      token: {
        expires_at: credentials?.expires_at ?? 'unknown',
        scopes: status.token?.scopes ?? [],
      },
    });
    return;
  }

  // table / text format
  const expiresStr = credentials?.expires_at
    ? formatDateTime(new Date(credentials.expires_at))
    : 'unknown';
  const scopes = status.token?.scopes?.join('  ') ?? '';
  const label = 'Authenticated';

  console.log('');
  console.log(`  ${theme.success(theme.symbols.pass)}  ${label}`);
  if (status.warning) {
    console.log(`  ${theme.warning(theme.symbols.warn)} ${status.warning}`);
  }
  console.log('');

  const entries: Array<[string, string]> = [
    ['User', status.user?.aliyunId ?? credentials?.user?.aliyunId ?? 'unknown'],
    ['Token expires', expiresStr],
    ['Source', resolved.source],
    ['Scope', scopes],
  ];

  console.log(formatKeyValue(entries));
  console.log('');
}

function formatDateTime(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}
