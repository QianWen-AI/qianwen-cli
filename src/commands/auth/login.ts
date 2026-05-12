import { exec } from 'child_process';
import chalk from 'chalk';
import { Command } from 'commander';
import {
  executeDeviceFlow,
  executeDeviceFlowInitOnly,
  executeDeviceFlowComplete,
  type DeviceFlowCompleteOptions,
} from '../../auth/device-flow.js';
import {
  resolveCredentials,
  isTokenExpired,
  getTokenRemainingTime,
} from '../../auth/credentials.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError } from '../../utils/errors.js';
import { loginCommand, formatCmd } from '../../utils/runtime-mode.js';
import { site } from '../../site.js';
import { theme } from '../../ui/theme.js';
import { createClient } from '../../api/client.js';
import { resetGlobalCache } from '../../utils/cache.js';
import type { ResolvedFormat } from '../../types/config.js';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description(`Login to ${site.cliDisplayName} via Device Flow`)
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)')
    .option('--init-only', 'Output device code and exit immediately (for non-interactive use)')
    .option('--complete', 'Resume and complete a pending device-flow login')
    .option(
      '--timeout <seconds>',
      'Polling timeout in seconds for --complete (default: 120)',
      parseInt,
    )
    .action(async function (this: Command, opts) {
      const config = getEffectiveConfig();
      let format = resolveFormatFromCommand(this, config);
      const initOnly = !!opts.initOnly;
      const complete = !!opts.complete;
      const timeoutSeconds: number | undefined =
        opts.timeout && opts.timeout > 0 ? opts.timeout : undefined;

      // Non-TTY auto-degrade: if neither --init-only nor --complete is
      // explicitly provided, switch to init-only + json so headless Agents
      // do not block on the polling loop.
      const isNonTTY = !process.stdin.isTTY || !process.stdout.isTTY;
      let autoInitOnly = false;
      if (isNonTTY && !initOnly && !complete) {
        autoInitOnly = true;
        format = 'json';
        process.stderr.write(
          'Non-interactive environment detected. Running in --init-only mode.\n' +
            'Open the URL in browser and authorize. After that, run `' + site.cliName + ' auth login --complete` to confirm authentication status.\n',
        );
      }

      // For --complete: respect explicit --format, otherwise default to json
      // in non-TTY (so Agents always get structured output) and text in TTY.
      if (complete && !opts.format) {
        format = isNonTTY ? 'json' : 'text';
      }

      try {
        if (initOnly || autoInitOnly) {
          await runLoginInitOnly();
        } else if (complete) {
          await runLoginComplete(format, timeoutSeconds);
        } else {
          await runLogin(format);
        }
      } catch (error) {
        handleError(error, format);
      }
    });
}

async function runLogin(format: ResolvedFormat): Promise<void> {
  // Check if already authenticated with a valid token
  const resolved = resolveCredentials();
  if (resolved && resolved.credentials && !isTokenExpired(resolved.credentials)) {
    const remaining = getTokenRemainingTime(resolved.credentials);

    const client = await createClient();
    const status = await client.getAuthStatus();
    const aliyunId = status.user?.aliyunId ?? resolved.credentials.user.aliyunId ?? 'unknown';

    if (format === 'json') {
      printJSON({
        events: [
          {
            event: 'already_authenticated',
            authenticated: true,
            source: resolved.source,
            server_verified: status.server_verified,
            user: { aliyunId },
            token: { expires_at: resolved.credentials.expires_at, remaining },
          },
        ],
      });
    } else {
      console.log('');
      console.log(
        `  ${theme.success(theme.symbols.pass)} Already authenticated as ${theme.bold(aliyunId)}`,
      );
      console.log(`  Token expires in ${remaining}`);
      console.log(`  Credential source: ${resolved.source}`);
      console.log(`  To re-login, run: ${chalk.bold(formatCmd('auth logout'))} first`);
      console.log('');
    }
    return;
  }

  if (format === 'json') {
    await runLoginJSON();
  } else {
    await runLoginInteractive();
  }
}

/**
 * Open a URL in the user's default browser.
 * Falls back silently if the browser cannot be opened.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open ${JSON.stringify(url)}`
      : process.platform === 'win32'
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;

  exec(cmd, (err) => {
    if (err) {
      // Silently ignore — the URL is already printed for manual copy
    }
  });
}

async function fetchUserIdentifier(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const creds = resolveCredentials();
    if (!creds) return '';
    const config = getEffectiveConfig();
    const baseUrl = (config['api.endpoint'] as string).replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/api/account/info.json`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
      signal: controller.signal,
    });
    if (response.ok) {
      const json = (await response.json()) as { data?: { aliyunId?: string } };
      return json.data?.aliyunId ?? '';
    }
  } catch {
    // ignore
  } finally {
    clearTimeout(timeout);
  }
  return '';
}

async function runLoginInteractive(): Promise<void> {
  let authCompleted = false;

  const success = await executeDeviceFlow({
    onCodeReceived({ verificationUrl, expiresIn }) {
      const _minutes = Math.floor(expiresIn / 60);
      console.log('');
      console.log(`  Opening browser to authorize...`);
      console.log(`  If the browser does not open, visit this URL manually:`);
      console.log(`  ${theme.info(verificationUrl)}`);
      console.log('');
      openBrowser(verificationUrl);
      process.stdout.write(`  Waiting for authorization...`);
    },
    onPolling() {
      process.stdout.write('.');
    },
    onSuccess(_user) {
      process.stdout.write('\n');
      authCompleted = true;
    },
    onError(error) {
      process.stdout.write('\n');
      console.error(`  ${theme.error(theme.symbols.fail)} ${error}`);
      console.log('');
    },
    onExpired() {
      process.stdout.write('\n');
      console.error(
        `  ${theme.error(theme.symbols.fail)} Device code expired. Please try again: ${chalk.bold(loginCommand())}`,
      );
      console.log('');
    },
  });

  if (!success) {
    resetGlobalCache();
    process.exitCode = 1;
    return;
  }

  if (authCompleted) {
    const identifier = await fetchUserIdentifier();
    if (identifier) {
      console.log(
        `  ${theme.success(theme.symbols.pass)} Authenticated as ${theme.bold(identifier)}`,
      );
    } else {
      console.log(`  ${theme.success(theme.symbols.pass)} Authenticated`);
    }
    console.log('');
  }
}

async function runLoginJSON(): Promise<void> {
  // Collect all events and output as a single JSON document at the end
  const events: Record<string, unknown>[] = [];

  const success = await executeDeviceFlow({
    onCodeReceived({ verificationUrl, expiresIn }) {
      events.push({
        event: 'device_code',
        verification_url: verificationUrl,
        expires_in: expiresIn,
      });
    },
    onPolling() {
      // No output in JSON mode during polling
    },
    onSuccess(user) {
      events.push({
        event: 'success',
        authenticated: true,
        user: { aliyunId: user.aliyunId || user.email },
      });
    },
    onError(error) {
      events.push({
        event: 'error',
        authenticated: false,
        error,
      });
    },
    onExpired() {
      events.push({
        event: 'expired',
        authenticated: false,
        error: 'Device code expired. Please try again.',
      });
    },
  });

  printJSON({ events });

  if (!success) {
    resetGlobalCache();
    process.exitCode = 1;
  }
}

/**
 * --init-only mode: request device code, persist pending state, output JSON, and exit.
 * Used by non-interactive Agents and the non-TTY auto-degrade path.
 */
async function runLoginInitOnly(): Promise<void> {
  // If already authenticated, output status and exit (no degradation needed)
  const resolved = resolveCredentials();
  if (resolved && resolved.credentials && !isTokenExpired(resolved.credentials)) {
    const remaining = getTokenRemainingTime(resolved.credentials);
    const client = await createClient();
    const status = await client.getAuthStatus();
    const aliyunId = status.user?.aliyunId ?? resolved.credentials.user.aliyunId ?? 'unknown';
    printJSON({
      events: [
        {
          event: 'already_authenticated',
          authenticated: true,
          source: resolved.source,
          server_verified: status.server_verified,
          user: { aliyunId },
          token: { expires_at: resolved.credentials.expires_at, remaining },
        },
      ],
    });
    return;
  }

  const initResponse = await executeDeviceFlowInitOnly();
  printJSON({
    events: [
      {
        event: 'device_code',
        verification_url: initResponse.verification_url,
        expires_in: initResponse.expires_in,
      },
    ],
  });
}

/**
 * --complete mode: perform a single token exchange check against a pending session.
 * Always produces output — JSON events for non-TTY / --format json,
 * human-readable text for TTY.
 */
async function runLoginComplete(format: ResolvedFormat, timeoutSeconds?: number): Promise<void> {
  const events: Record<string, unknown>[] = [];
  const isJSON = format === 'json';
  let success = false;
  // Track user from onSuccess callback; actual display deferred until after
  // fetchUserIdentifier() — same pattern as runLoginInteractive().
  const callbackUser: { email: string; aliyunId: string; received: boolean } = {
    email: '',
    aliyunId: '',
    received: false,
  };

  try {
    const completeOptions: DeviceFlowCompleteOptions = {};
    if (timeoutSeconds) completeOptions.timeoutSeconds = timeoutSeconds;

    success = await executeDeviceFlowComplete(
      {
        onCodeReceived() {
          // Not used in --complete mode
        },
        onPolling() {
          if (!isJSON) process.stdout.write('.');
        },
        onSuccess(user) {
          callbackUser.email = user.email;
          callbackUser.aliyunId = user.aliyunId;
          callbackUser.received = true;
        },
        onError(error) {
          // Map specific messages to structured event types
          const isPending = /not yet completed/i.test(error);
          if (isJSON) {
            events.push({
              event: isPending ? 'pending' : 'error',
              authenticated: false,
              message: error,
            });
          } else {
            console.log('');
            console.error(`  ${theme.error(theme.symbols.fail)} ${error}`);
            console.log('');
          }
        },
        onExpired() {
          if (isJSON) {
            events.push({
              event: 'expired',
              authenticated: false,
              message:
                "Device code has expired. Please run '" + site.cliName + " auth login' to start a new login flow.",
            });
          } else {
            console.log('');
            console.error(
              `  ${theme.error(theme.symbols.fail)} Device code expired. Please try again: ${chalk.bold(loginCommand())}`,
            );
            console.log('');
          }
        },
      },
      completeOptions,
    );
  } catch (error) {
    // Catch unexpected errors (e.g. createClient failure) and surface them
    // as structured output so stdout is never empty.
    const message = error instanceof Error ? error.message : String(error);
    if (isJSON) {
      events.push({
        event: 'error',
        authenticated: false,
        message,
      });
    } else {
      console.error(`  ${theme.error(theme.symbols.fail)} ${message}`);
      console.log('');
    }
  }

  // If login succeeded, fetch authoritative user identity from server
  // (poll response may omit user info), matching runLoginInteractive() behavior.
  if (success && callbackUser.received) {
    const identifier = await fetchUserIdentifier();
    const displayId = identifier || callbackUser.aliyunId || callbackUser.email;
    if (isJSON) {
      events.push({
        event: 'success',
        authenticated: true,
        user: { aliyunId: displayId },
      });
    } else {
      console.log('');
      if (displayId) {
        console.log(
          `  ${theme.success(theme.symbols.pass)} Authenticated as ${theme.bold(displayId)}`,
        );
      } else {
        console.log(`  ${theme.success(theme.symbols.pass)} Authenticated`);
      }
      console.log('');
    }
  }

  // Guarantee JSON output is always emitted, even when no callbacks fired.
  if (isJSON) {
    if (events.length === 0) {
      events.push({
        event: 'error',
        authenticated: false,
        message: 'Unexpected: no events were generated during --complete.',
      });
    }
    printJSON({ events });
  }

  if (!success) {
    resetGlobalCache();
    process.exitCode = 1;
  }
}
