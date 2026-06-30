/**
 * Pure REPL helpers — extracted from repl.ts so they're testable without
 * standing up readline / process.stdin.
 *
 * The command tree (TOP_COMMANDS / SUBCOMMANDS / COMMAND_FLAGS / FLAG_VALUES)
 * is hand-maintained: it must stay in sync with src/commands/ on changes.
 */

import chalk from 'chalk';
import { didYouMean } from '../utils/strings.js';

// ── Command tree ──────────────────────────────────────────────────────

export const TOP_COMMANDS = [
  // Identity & primary resources
  'auth',
  'models',
  'usage',
  // Billing & subscription
  'billing',
  'subscription',
  // Account-scoped resources
  'workspace',
  // Operations & references
  'support',
  'update',
  'docs',
  // Local utilities & meta
  'config',
  'doctor',
  'completion',
  'version',
  // REPL built-ins
  'help',
  'clear',
];

export const SUBCOMMANDS: Record<string, string[]> = {
  auth: ['login', 'logout', 'status'],
  models: ['list', 'info', 'search'],
  usage: ['summary', 'free-tier', 'payg', 'breakdown', 'logs'],
  billing: ['limit', 'breakdown', 'summary', 'balance'],
  'billing balance': ['summary', 'recharge'],
  subscription: ['status', 'orders', 'tokenplan'],
  'subscription tokenplan': ['status', 'seats'],
  workspace: ['list', 'limit'],
  support: ['list', 'view', 'create', 'reply', 'close', 'rate'],
  docs: ['search', 'view'],
  config: ['list', 'get', 'set', 'unset'],
  completion: ['install', 'generate'],
};

/** Available flags per "cmd subcmd". */
export const COMMAND_FLAGS: Record<string, string[]> = {
  'models list': ['--input', '--output', '--all', '--page', '--per-page', '--verbose', '--format'],
  'models info': ['--model', '--format'],
  'models search': ['--page', '--per-page', '--all', '--format'],
  'usage summary': ['--from', '--to', '--period', '--format'],
  'usage breakdown': [
    '--model',
    '--granularity',
    '--from',
    '--to',
    '--period',
    '--days',
    '--format',
  ],
  'usage free-tier': ['--from', '--to', '--period', '--format'],
  'usage payg': ['--from', '--to', '--period', '--days', '--format'],
  'usage logs': [
    '--from',
    '--to',
    '--period',
    '--model',
    '--status',
    '--request-id',
    '--page',
    '--page-size',
    '--format',
  ],
  'billing limit': ['--format'],
  'billing breakdown': [
    '--granularity',
    '--group-by',
    '--from',
    '--to',
    '--period',
    '--charge-type',
    '--top',
    '--format',
  ],
  'billing summary': ['--from', '--to', '--charge-type', '--format'],
  'billing balance': [],
  'billing balance summary': ['--format'],
  'billing balance recharge': ['--format'],
  'subscription status': ['--plan', '--format'],
  'subscription orders': ['--from', '--to', '--type', '--page', '--page-size', '--format'],
  'subscription tokenplan': [],
  'subscription tokenplan status': ['--format'],
  'subscription tokenplan seats': ['--spec-type', '--page', '--page-size', '--format'],
  'account info': ['--format'],
  'api-key list': ['--description', '--workspace', '--page', '--page-size', '--format'],
  'workspace list': ['--format'],
  'workspace limit': ['--format'],
  'alert rules': ['--resource-type', '--page', '--page-size', '--format'],
  'alert history': ['--rule-id', '--from', '--to', '--period', '--page', '--page-size', '--format'],
  'alert notifications': [
    '--alert-history-id',
    '--from',
    '--to',
    '--next-token',
    '--page-size',
    '--format',
  ],
  'alert templates': ['--source', '--page', '--page-size', '--format'],
  'support list': ['--page', '--page-size', '--format'],
  'support view': ['--format'],
  'support create': ['--list-categories', '--category-id', '--description', '--format'],
  'support reply': ['--message', '--format'],
  'support close': ['--yes', '--format'],
  'support confirm': ['--format'],
  'support rate': ['--rating', '--comment', '--format'],
  'docs search': ['--limit', '--page', '--language', '--view', '--format'],
  'docs view': ['--format'],
  'config list': ['--format'],
  'config get': ['--format'],
  'config set': ['--format'],
  'config unset': ['--format'],
  'auth login': ['--format', '--init-only', '--complete', '--timeout'],
  'auth logout': ['--format'],
  'auth status': ['--format'],
  update: [],
  doctor: ['--format'],
  version: ['--check'],
  'completion install': ['--shell'],
  'completion generate': ['--shell'],
};

/** Universal flag injected into every command level. */
const HELP_FLAG = '--help';

/** Valid values per flag (for flags that take an enumerated argument). */
export const FLAG_VALUES: Record<string, string[]> = {
  '--format': ['table', 'json', 'text'],
  '--granularity': ['day', 'month', 'quarter'],
  '--period': ['today', 'yesterday', 'week', 'month', 'last-month', 'quarter', 'year'],
  '--shell': ['bash', 'zsh', 'fish'],
  '--input': ['text', 'image', 'audio', 'video'],
  '--output': ['text', 'image', 'audio', 'video'],
  '--charge-type': ['all', 'subscription', 'payg'],
  '--type': ['purchase', 'renew', 'upgrade'],
  '--source': ['official', 'custom'],
  '--language': ['en', 'zh'],
  '--plan': ['token'],
  '--spec-type': ['pro', 'standard'],
  '--status': ['0', '2xx', '4xx', '5xx'],
  '--group-by': ['model', 'api-key'],
};

/** Per-command flag value overrides (takes precedence over FLAG_VALUES). */
export const COMMAND_FLAG_VALUES: Record<string, Record<string, string[]>> = {
  'billing breakdown': {
    '--group-by': ['model', 'api-key'],
    '--granularity': ['day', 'month'],
  },
};

/** Resolve flag values with command-specific overrides. */
function getFlagValues(cmdKey: string, flag: string): string[] | undefined {
  return COMMAND_FLAG_VALUES[cmdKey]?.[flag] ?? FLAG_VALUES[flag];
}

// ── Fuzzy helpers ─────────────────────────────────────────────────────

/** True if every character of query appears in order in target. */
export function isSubsequence(query: string, target: string): boolean {
  let qi = 0;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Filter candidates against a partial string.
 * Priority: prefix match → substring match → subsequence match.
 */
export function fuzzyFilter(candidates: string[], partial: string): string[] {
  if (!partial) return candidates;
  const q = partial.toLowerCase();
  const prefix = candidates.filter((c) => c.startsWith(q));
  if (prefix.length) return prefix;
  const sub = candidates.filter((c) => c.includes(q));
  if (sub.length) return sub;
  return candidates.filter((c) => isSubsequence(q, c));
}

// ── Tab completer ─────────────────────────────────────────────────────

/**
 * readline completer: returns [completions, substringToReplace].
 * Supports: top-level commands → subcommands → flag names → flag values.
 */
export function tabCompleter(line: string): [string[], string] {
  const trimmed = line.trimStart();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  const endsWithSpace = /\s$/.test(line);

  if (tokens.length === 0) return [TOP_COMMANDS, ''];

  if (tokens.length === 1 && !endsWithSpace) {
    return [fuzzyFilter(TOP_COMMANDS, tokens[0]), tokens[0]];
  }

  const cmd = tokens[0];
  const subs = SUBCOMMANDS[cmd];
  const ownFlags = COMMAND_FLAGS[cmd] ?? [];

  // Commands without subcommands (doctor, version, etc.)
  if (!subs) {
    if (TOP_COMMANDS.includes(cmd)) {
      const topFlags = [...(COMMAND_FLAGS[cmd] ?? []), HELP_FLAG];
      const completedTokens = endsWithSpace ? tokens.slice(1) : tokens.slice(1, -1);
      const usedFlags = new Set(completedTokens.filter((t) => t.startsWith('--')));
      const remainingFlags = topFlags.filter((f) => !usedFlags.has(f));
      if (endsWithSpace) {
        const prevToken = tokens[tokens.length - 2];
        const knownValues = FLAG_VALUES[prevToken];
        if (knownValues) return [knownValues, ''];
        return [remainingFlags, ''];
      }
      if (tokens.length >= 2 && !endsWithSpace) {
        const partial = tokens[tokens.length - 1];
        const prevToken = tokens.length >= 3 ? tokens[tokens.length - 2] : null;
        if (prevToken) {
          const knownValues = FLAG_VALUES[prevToken];
          if (knownValues) return [fuzzyFilter(knownValues, partial), partial];
        }
        return [fuzzyFilter(remainingFlags, partial), partial];
      }
    }
    return [[], ''];
  }

  // After "<top> " (trailing space) the split produces ['<top>', ''] so
  // length=2 with endsWithSpace=true. Suggest subcommands + own flags + --help.
  if (tokens.length === 2 && endsWithSpace) {
    return [[...subs, ...ownFlags, HELP_FLAG], ''];
  }

  if (tokens.length === 2 && !endsWithSpace) {
    return [fuzzyFilter([...subs, ...ownFlags, HELP_FLAG], tokens[1]), tokens[1]];
  }

  const sub = tokens[1];

  // tokens[1] is not a known subcommand. If the command has its own flags,
  // treat the tail as direct flag completion at the command level.
  if (!subs.includes(sub)) {
    if (ownFlags.length === 0) return [[], ''];

    const availableFlags = [...ownFlags, HELP_FLAG];
    const completedTokens = endsWithSpace ? tokens.slice(1) : tokens.slice(1, -1);
    const usedFlags = new Set(completedTokens.filter((t) => t.startsWith('--')));
    const remainingFlags = availableFlags.filter((f) => !usedFlags.has(f));

    if (endsWithSpace) {
      const prevToken = tokens[tokens.length - 2];
      const knownValues = getFlagValues(cmd, prevToken);
      if (knownValues) return [knownValues, ''];
      return [remainingFlags, ''];
    }

    const partial = tokens[tokens.length - 1];
    const prevToken = tokens.length >= 3 ? tokens[tokens.length - 2] : null;
    if (prevToken) {
      const knownValues = getFlagValues(cmd, prevToken);
      if (knownValues) return [fuzzyFilter(knownValues, partial), partial];
    }
    return [fuzzyFilter(remainingFlags, partial), partial];
  }

  // 3-level subcommand support: e.g. `subscription tokenplan status`.
  const subSubKey = `${cmd} ${sub}`;
  const subSubs = SUBCOMMANDS[subSubKey];
  if (subSubs) {
    if (tokens.length === 3 && endsWithSpace) {
      return [[...subSubs, HELP_FLAG], ''];
    }
    if (tokens.length === 3 && !endsWithSpace) {
      return [fuzzyFilter([...subSubs, HELP_FLAG], tokens[2]), tokens[2]];
    }

    const subsub = tokens[2];
    if (!subSubs.includes(subsub)) return [[], ''];

    const flagKey3 = `${cmd} ${sub} ${subsub}`;
    const availableFlags3 = [...(COMMAND_FLAGS[flagKey3] ?? []), HELP_FLAG];
    const completedTokens3 = endsWithSpace ? tokens.slice(3) : tokens.slice(3, -1);
    const usedFlags3 = new Set(completedTokens3.filter((t) => t.startsWith('--')));
    const remainingFlags3 = availableFlags3.filter((f) => !usedFlags3.has(f));

    if (endsWithSpace) {
      const prevToken3 = tokens[tokens.length - 2];
      const knownValues3 = FLAG_VALUES[prevToken3];
      if (knownValues3) return [knownValues3, ''];
      return [remainingFlags3, ''];
    }

    const partial3 = tokens[tokens.length - 1];
    const prev3 = tokens.length >= 4 ? tokens[tokens.length - 2] : null;
    if (prev3) {
      const knownValues3 = FLAG_VALUES[prev3];
      if (knownValues3) return [fuzzyFilter(knownValues3, partial3), partial3];
    }
    return [fuzzyFilter(remainingFlags3, partial3), partial3];
  }

  const flagKey = `${cmd} ${sub}`;
  const availableFlags = [...(COMMAND_FLAGS[flagKey] ?? []), HELP_FLAG];

  const completedTokens = endsWithSpace ? tokens.slice(2) : tokens.slice(2, -1);
  const usedFlags = new Set(completedTokens.filter((t) => t.startsWith('--')));
  const remainingFlags = availableFlags.filter((f) => !usedFlags.has(f));

  if (endsWithSpace) {
    // After trailing space, the last *typed* token is at len-2 (the empty
    // string at len-1 came from split on the space). Use it to detect whether
    // we should suggest values for a flag that takes an enumerated argument.
    const prevToken = tokens[tokens.length - 2];
    const knownValues = getFlagValues(flagKey, prevToken);
    if (knownValues) return [knownValues, ''];
    return [remainingFlags, ''];
  }

  const partial = tokens[tokens.length - 1];
  const prevToken = tokens.length >= 3 ? tokens[tokens.length - 2] : null;

  if (prevToken) {
    const knownValues = getFlagValues(flagKey, prevToken);
    if (knownValues) return [fuzzyFilter(knownValues, partial), partial];
  }

  return [fuzzyFilter(remainingFlags, partial), partial];
}

// ── Ghost text ────────────────────────────────────────────────────────

/**
 * Return the suffix to show as ghost text given the current line.
 * Uses prefix-only matching to avoid false positives.
 * Returns '' when no clear single completion exists.
 */
export function getGhostSuffix(line: string): string {
  const trimmed = line.trimStart();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  const endsWithSpace = /\s$/.test(line);

  if (tokens.length === 0 || endsWithSpace) return '';

  let candidates: string[];
  let partial: string;

  if (tokens.length === 1) {
    candidates = TOP_COMMANDS;
    partial = tokens[0];
  } else {
    const cmd = tokens[0];
    const subs = SUBCOMMANDS[cmd];
    if (!subs) {
      if (tokens.length >= 2) {
        const topFlags = [...(COMMAND_FLAGS[cmd] ?? []), HELP_FLAG];
        const prevToken = tokens[tokens.length - 2];
        partial = tokens[tokens.length - 1];
        const knownValues = FLAG_VALUES[prevToken];
        if (knownValues) {
          candidates = knownValues;
        } else {
          const usedFlags = new Set(tokens.slice(1, -1).filter((t) => t.startsWith('--')));
          candidates = topFlags.filter((f) => !usedFlags.has(f));
        }
      } else {
        return '';
      }
    } else if (tokens.length === 2) {
      candidates = [...subs, HELP_FLAG];
      partial = tokens[1];
    } else {
      const sub = tokens[1];
      if (!subs.includes(sub)) return '';

      const subSubKey = `${cmd} ${sub}`;
      const subSubs = SUBCOMMANDS[subSubKey];
      if (subSubs) {
        if (tokens.length === 3) {
          candidates = [...subSubs, HELP_FLAG];
          partial = tokens[2];
        } else {
          const subsub = tokens[2];
          if (!subSubs.includes(subsub)) return '';
          const flagKey3 = `${cmd} ${sub} ${subsub}`;
          const avail3 = [...(COMMAND_FLAGS[flagKey3] ?? []), HELP_FLAG];
          const prevToken3 = tokens[tokens.length - 2];
          partial = tokens[tokens.length - 1];
          const knownValues3 = FLAG_VALUES[prevToken3];
          if (knownValues3) {
            candidates = knownValues3;
          } else {
            const usedFlags3 = new Set(tokens.slice(3, -1).filter((t) => t.startsWith('--')));
            candidates = avail3.filter((f) => !usedFlags3.has(f));
          }
        }
      } else {
        const flagKey = `${cmd} ${sub}`;
        const avail = [...(COMMAND_FLAGS[flagKey] ?? []), HELP_FLAG];
        const prevToken = tokens[tokens.length - 2];
        partial = tokens[tokens.length - 1];

        const knownValues = getFlagValues(flagKey, prevToken);
        if (knownValues) {
          candidates = knownValues;
        } else {
          const usedFlags = new Set(tokens.slice(2, -1).filter((t) => t.startsWith('--')));
          candidates = avail.filter((f) => !usedFlags.has(f));
        }
      }
    }
  }

  if (!partial) return '';

  const prefix = candidates.filter((c) => c.startsWith(partial));

  if (prefix.length === 1) {
    return prefix[0].slice(partial.length);
  }
  if (prefix.length > 1) {
    let lcp = prefix[0];
    for (const h of prefix.slice(1)) {
      let i = 0;
      while (i < lcp.length && i < h.length && lcp[i] === h[i]) i++;
      lcp = lcp.slice(0, i);
    }
    return lcp.slice(partial.length);
  }

  return '';
}

// ── Unknown-command message ───────────────────────────────────────────

/**
 * Build a "Unknown command … Did you mean: X?" message for the REPL.
 * Returns ANSI-colored text (chalk). Strip colors with chalk.level=0
 * or `s.replace(/\u001b\[[0-9;]*m/g, '')` in tests if needed.
 */
export function unknownCommandMsg(input: string): string {
  const tokens = input.trim().split(/\s+/);
  let suggestion: string | null = null;

  if (tokens.length === 1) {
    suggestion = didYouMean(tokens[0], TOP_COMMANDS);
  } else if (tokens.length >= 2) {
    const subs = SUBCOMMANDS[tokens[0]];
    if (subs) suggestion = didYouMean(tokens[1], subs);
  }

  const base = `  Unknown command: ${chalk.bold(input)}.`;
  if (suggestion) return `${base} Did you mean ${chalk.bold(suggestion)}?`;
  return `${base} Run ${chalk.dim('help')} for available commands.`;
}
