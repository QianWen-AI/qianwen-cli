import type { Command } from 'commander';
import { existsSync } from 'fs';
import { VERSION } from '../index.js';
import { createClient } from '../api/client.js';
import {
  resolveCredentials,
  isTokenExpired,
  isTokenExpiringSoon,
  getTokenRemainingTime,
} from '../auth/credentials.js';
import { getGlobalConfigPath, getConfigDir } from '../config/paths.js';
import { getConfigValue } from '../config/manager.js';
import { resolveFormat, outputJSON } from '../output/format.js';
import { theme } from '../ui/theme.js';
import type { StatusLevel } from '../ui/StatusLine.js';
import type { OutputFormat } from '../types/config.js';
import { computeExitCode, formatCheckLabel, type DoctorCheck } from '../view-models/doctor.js';
import { loginCommand, formatCmd } from '../utils/runtime-mode.js';
import { resetGlobalCache } from '../utils/cache.js';
import { site } from '../site.js';

// ── Individual check functions ──────────────────────────────────────

import type { ApiClient } from '../api/client.js';
import type { ResolvedCredential } from '../auth/credentials.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

async function checkCliVersion(client: ApiClient): Promise<DoctorCheck> {
  try {
    const info = await client.checkVersion();
    if (info.update_available) {
      return {
        name: 'cli_version',
        status: 'warn',
        detail: `v${info.current} (v${info.latest} available)`,
        action: `Run: ${formatCmd('update')}`,
      };
    }
    return { name: 'cli_version', status: 'pass', detail: `v${VERSION} (latest)` };
  } catch {
    return {
      name: 'cli_version',
      status: 'warn',
      detail: `v${VERSION} (unable to check for updates)`,
    };
  }
}

async function checkAuth(
  resolved: ResolvedCredential | null,
  client: ApiClient,
): Promise<DoctorCheck> {
  if (!resolved) {
    return {
      name: 'auth',
      status: 'fail',
      detail: 'Not authenticated',
      action: `Run: ${loginCommand()}`,
    };
  }

  // Try to get user identity from server API
  let identity = 'unknown';
  try {
    const authStatus = await client.getAuthStatus();
    const serverAliyunId = authStatus.user?.aliyunId;
    const serverEmail = authStatus.user?.email;
    identity =
      (serverAliyunId && serverAliyunId.trim()) ||
      (serverEmail && serverEmail.trim()) ||
      (resolved.credentials?.user?.aliyunId && resolved.credentials.user.aliyunId.trim()) ||
      (resolved.credentials?.user?.email && resolved.credentials.user.email.trim()) ||
      'unknown';
  } catch {
    // Fallback to local credentials if server is unreachable
    identity =
      (resolved.credentials?.user?.aliyunId && resolved.credentials.user.aliyunId.trim()) ||
      (resolved.credentials?.user?.email && resolved.credentials.user.email.trim()) ||
      'unknown';
  }

  return {
    name: 'auth',
    status: 'pass',
    detail: `Authenticated as ${identity} (${resolved.source})`,
  };
}

function checkToken(resolved: ResolvedCredential | null): DoctorCheck {
  if (!resolved) {
    return {
      name: 'token',
      status: 'fail',
      detail: 'No credentials found',
      action: `Run: ${loginCommand()}`,
    };
  }
  if (!resolved.credentials) {
    return { name: 'token', status: 'pass', detail: `Valid (from ${resolved.source})` };
  }
  if (isTokenExpired(resolved.credentials)) {
    return {
      name: 'token',
      status: 'fail',
      detail: 'Token expired',
      action: `Run: ${loginCommand()}`,
    };
  }
  const remaining = getTokenRemainingTime(resolved.credentials);
  // PRD §7.4: warn if token expires within 1 hour
  if (isTokenExpiringSoon(resolved.credentials, 60)) {
    return {
      name: 'token',
      status: 'warn',
      detail: `Expires soon (${remaining})`,
      action: `Run: ${loginCommand()}`,
    };
  }
  return { name: 'token', status: 'pass', detail: `Valid, expires in ${remaining}` };
}

async function checkNetwork(client: ApiClient): Promise<DoctorCheck> {
  try {
    const result = await client.ping();
    if (!result.reachable) {
      return {
        name: 'network',
        status: 'fail',
        detail: 'API unreachable',
        action: 'Check your network connection',
      };
    }
    if (result.latency > 2000) {
      return {
        name: 'network',
        status: 'fail',
        detail: `High latency (${result.latency}ms)`,
        action: 'Check your network connection',
      };
    }
    if (result.latency > 500) {
      return {
        name: 'network',
        status: 'warn',
        detail: `${result.hostname} reachable (latency ${result.latency}ms)`,
      };
    }
    return {
      name: 'network',
      status: 'pass',
      detail: `${result.hostname} reachable (latency ${result.latency}ms)`,
    };
  } catch {
    return {
      name: 'network',
      status: 'fail',
      detail: 'API unreachable',
      action: 'Check your network connection',
    };
  }
}

function checkShellCompletion(): DoctorCheck {
  const shell = process.env.SHELL ?? '';
  let rcPath: string | null = null;
  let marker = `${site.cliName} completion generate`;

  if (shell.includes('zsh')) rcPath = join(homedir(), '.zshrc');
  else if (shell.includes('bash')) rcPath = join(homedir(), '.bashrc');
  else if (shell.includes('fish')) {
    rcPath = join(homedir(), '.config', 'fish', 'config.fish');
    marker = site.cliName;
  }

  if (rcPath) {
    try {
      if (existsSync(rcPath) && readFileSync(rcPath, 'utf-8').includes(marker)) {
        return { name: 'shell_completion', status: 'pass', detail: 'Installed' };
      }
    } catch {
      /* ignore */
    }
  }
  return {
    name: 'shell_completion',
    status: 'warn',
    detail: 'Not installed',
    action: `Run: ${formatCmd('completion install')}`,
  };
}

function checkGlobalConfig(): DoctorCheck {
  const path = getGlobalConfigPath();
  if (existsSync(path)) {
    return { name: 'global_config', status: 'pass', detail: `${getConfigDir()}/config.json` };
  }
  return { name: 'global_config', status: 'info', detail: 'Not found (using defaults)' };
}

// ── Orchestrator ────────────────────────────────────────────────────

async function runChecks(): Promise<DoctorCheck[]> {
  const client = await createClient();
  const resolved = resolveCredentials();

  return [
    await checkCliVersion(client),
    await checkAuth(resolved, client),
    checkToken(resolved),
    await checkNetwork(client),
    checkShellCompletion(),
    checkGlobalConfig(),
  ];
}

const STATUS_SYMBOLS: Record<StatusLevel, string> = {
  pass: theme.symbols.pass,
  fail: theme.symbols.fail,
  warn: theme.symbols.warn,
  info: theme.symbols.info,
};

const STATUS_COLORS: Record<StatusLevel, (s: string) => string> = {
  pass: theme.success,
  fail: theme.error,
  warn: theme.warning,
  info: theme.info,
};

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run environment diagnostics')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .action(async (opts) => {
      const format = resolveFormat(
        opts.format ?? program.opts().format,
        getConfigValue('output.format') as OutputFormat,
      );

      const checks = await runChecks();
      const exitCode = computeExitCode(checks);

      if (format === 'json') {
        const summary = {
          pass: checks.filter((c) => c.status === 'pass').length,
          warn: checks.filter((c) => c.status === 'warn').length,
          info: checks.filter((c) => c.status === 'info').length,
          fail: checks.filter((c) => c.status === 'fail').length,
        };

        outputJSON({
          checks: checks.map((c) => {
            const item: Record<string, unknown> = {
              name: c.name,
              status: c.status,
              detail: c.detail,
            };
            if (c.action) item.action = c.action;
            return item;
          }),
          summary,
          exit_code: exitCode,
        });

        resetGlobalCache();
        process.exit(exitCode);
        return;
      }

      // Table / text mode
      const isText = format === 'text';
      console.log('');
      console.log(
        isText
          ? `  ${site.doctorTitle}  .  v${VERSION}`
          : `  ${theme.bold(site.doctorTitle)}  ${theme.dim(theme.symbols.dot)}  v${VERSION}`,
      );
      console.log('');

      const labelWidth = 20;
      for (const check of checks) {
        const label = formatCheckLabel(check.name).padEnd(labelWidth);
        if (isText) {
          const plainSymbol = STATUS_SYMBOLS[check.status];
          const actionStr = check.action ? `  ${check.action}` : '';
          console.log(`  ${plainSymbol}  ${label}${check.detail}${actionStr}`);
        } else {
          const symbol = STATUS_COLORS[check.status](STATUS_SYMBOLS[check.status]);
          const actionStr = check.action ? theme.dim(`  ${check.action}`) : '';
          console.log(`  ${symbol}  ${theme.bold(label)}${check.detail}${actionStr}`);
        }
      }

      console.log('');

      // Summary line
      const failCount = checks.filter((c) => c.status === 'fail').length;
      const warnCount = checks.filter((c) => c.status === 'warn').length;
      const parts: string[] = [];
      if (failCount === 0) {
        parts.push('All critical checks passed');
      } else {
        parts.push(`${failCount} check(s) failed`);
      }
      if (warnCount > 0) {
        parts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`);
      }
      console.log(`  ${parts.join(isText ? ' . ' : ' ' + theme.symbols.dot + ' ')}`);
      console.log('');

      resetGlobalCache();
      process.exit(exitCode);
    });
}
