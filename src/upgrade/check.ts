/**
 * GitHub Release version checker.
 *
 * Minimal remote version detection: queries the public GitHub Releases API for
 * the latest tag, compares against the locally-injected build version, and
 * produces a channel-aware upgrade hint. No downloading, no caching, no
 * auto-update — callers print the hint, the user runs the command themselves.
 *
 * Any error (network failure, timeout, rate-limit, non-2xx, malformed JSON)
 * is swallowed and reported as "no update available" so the CLI never breaks
 * on a flaky network.
 */

import { startRequest, endRequest, isEnabled } from '../api/debug-buffer.js';

const GITHUB_API = 'https://api.github.com/repos/QianWen-AI/qianwen-cli/releases/latest';
const INSTALL_SH = 'https://raw.githubusercontent.com/QianWen-AI/qianwen-cli/main/install.sh';
const INSTALL_PS1 = 'https://raw.githubusercontent.com/QianWen-AI/qianwen-cli/main/install.ps1';
const NPM_PACKAGE = '@qianwenai/qianwen-cli';
const REQUEST_TIMEOUT_MS = 5000;

export type InstallChannel = 'npm' | 'sh' | 'ps1';
export type NodePackageManager = 'bun' | 'pnpm' | 'npm';

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(v: string): SemVer {
  const cleaned = v.replace(/^v/, '').split('-')[0] ?? '';
  const parts = cleaned.split('.');
  return {
    major: parseInt(parts[0] ?? '0', 10) || 0,
    minor: parseInt(parts[1] ?? '0', 10) || 0,
    patch: parseInt(parts[2] ?? '0', 10) || 0,
  };
}

/**
 * Compare two semver strings by their numeric major.minor.patch segments.
 * Returns -1 if a < b, 1 if a > b, 0 if equal. Prerelease suffixes are ignored.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] < pb[key]) return -1;
    if (pa[key] > pb[key]) return 1;
  }
  return 0;
}

function stripV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/**
 * Fetch the latest release tag from GitHub. Returns the version string
 * without the leading "v" (e.g. "1.2.3"), or null on any failure.
 *
 * Honors the GITHUB_TOKEN / GH_TOKEN environment variables to lift the
 * anonymous 60/hour rate limit to 5000/hour. This is an implicit, opt-in
 * mechanism; it is not documented to end users.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Redact Authorization before passing to the debug buffer so the token
  // never lands in the HTTP Debug Report.
  const debugHeaders: Record<string, unknown> = { ...headers };
  if (typeof debugHeaders.Authorization === 'string') {
    const t = debugHeaders.Authorization;
    debugHeaders.Authorization = t.length > 12 ? `${t.slice(0, 7)}****${t.slice(-4)}` : '****';
  }
  const debugId = isEnabled() ? startRequest('GET', GITHUB_API, debugHeaders, null, 'upgrade') : -1;

  try {
    const res = await fetch(GITHUB_API, { headers, signal: controller.signal });

    if (!res.ok) {
      if (debugId >= 0) {
        let body = '';
        try {
          body = await res.clone().text();
        } catch {
          // ignore body read failure
        }
        endRequest(debugId, res.status, res.statusText, body, true);
      }
      return null;
    }

    const text = await res.text();
    if (debugId >= 0) endRequest(debugId, res.status, res.statusText, text, false);

    const data = JSON.parse(text) as { tag_name?: unknown };
    const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
    if (!tag) return null;

    return stripV(tag);
  } catch {
    if (debugId >= 0) endRequest(debugId, null, 'NetworkError', null, true);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect the installation channel from the current runtime + platform.
 *
 *   Bun + win32  → ps1   (irm install.ps1 | iex)
 *   Bun + other  → sh    (curl install.sh  | sh)
 *   Node (any)   → npm   (npm install -g)
 *
 * Bun is detected via `process.versions.bun`, which is the documented runtime
 * marker and survives both `bun run` and Bun-built single-file executables.
 */
export function detectChannel(): InstallChannel {
  const isBun = typeof process.versions.bun === 'string' && process.versions.bun.length > 0;
  if (!isBun) return 'npm';
  return process.platform === 'win32' ? 'ps1' : 'sh';
}

/**
 * Guess which package manager installed this CLI by inspecting the module
 * path. Matching requires real path separators on either side of the marker
 * directory so an incidental substring (e.g. `my.bun.demo`) can't trigger a
 * false positive.
 *
 *   .../.bun/install/global/node_modules/...  → bun
 *   .../node_modules/.pnpm/...                → pnpm
 *   anything else                             → npm (default fallback)
 *
 * Accepts an optional URL so tests can exercise each branch without mocking
 * `import.meta.url`.
 */
export function detectNodePackageManager(moduleUrl: string = import.meta.url): NodePackageManager {
  let path = moduleUrl;
  try {
    path = new URL(moduleUrl).pathname;
  } catch {
    // Non-URL input — fall back to raw string matching.
  }
  if (/[\\/]\.bun[\\/]/.test(path)) return 'bun';
  if (/[\\/]\.pnpm[\\/]/.test(path)) return 'pnpm';
  return 'npm';
}

/**
 * Build a channel-appropriate upgrade hint. Returns plain text lines ready
 * to print — no ANSI styling so the caller controls presentation.
 */
export function getUpgradeHint(
  channel: InstallChannel,
  _latestVersion: string,
  packageManager: NodePackageManager = detectNodePackageManager(),
): string[] {
  const lines: string[] = ['To update, run:'];

  switch (channel) {
    case 'npm':
      switch (packageManager) {
        case 'bun':
          lines.push(`  bun add -g ${NPM_PACKAGE}@latest`);
          break;
        case 'pnpm':
          lines.push(`  pnpm add -g ${NPM_PACKAGE}@latest`);
          break;
        default:
          lines.push(`  npm install -g ${NPM_PACKAGE}@latest`);
          break;
      }
      break;
    case 'ps1':
      lines.push(`  irm ${INSTALL_PS1} | iex`);
      break;
    case 'sh':
      lines.push(`  curl -fsSL ${INSTALL_SH} | sh`);
      break;
  }

  return lines;
}
