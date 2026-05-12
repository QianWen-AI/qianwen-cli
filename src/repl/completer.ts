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
  'auth',
  'models',
  'usage',
  'config',
  'doctor',
  'completion',
  'version',
  'help',
  'clear',
];

export const SUBCOMMANDS: Record<string, string[]> = {
  auth: ['login', 'logout', 'status', 'refresh'],
  models: ['list', 'info', 'search'],
  usage: ['summary', 'free-tier', 'payg', 'breakdown'],
  config: ['list', 'get', 'set', 'unset'],
  completion: ['install', 'generate'],
};

/** Available flags per "cmd subcmd". */
export const COMMAND_FLAGS: Record<string, string[]> = {
  'models list': [
    '--input',
    '--output',
    '--all',
    '--free-tier',
    '--page',
    '--per-page',
    '--verbose',
    '--format',
  ],
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
  'config list': ['--format'],
  'auth login': ['--format'],
  'auth logout': ['--format'],
  'auth status': ['--format'],
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
};

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

  // Commands without subcommands (doctor, version, etc.)
  if (!subs) {
    if (TOP_COMMANDS.includes(cmd)) {
      const topFlags = [...(COMMAND_FLAGS[cmd] ?? []), HELP_FLAG];
      const completedTokens = endsWithSpace ? tokens.slice(1) : tokens.slice(1, -1);
      const usedFlags = new Set(completedTokens.filter((t) => t.startsWith('--')));
      const remainingFlags = topFlags.filter((f) => !usedFlags.has(f));
      if (endsWithSpace) return [remainingFlags, ''];
      if (tokens.length >= 2 && !endsWithSpace)
        return [fuzzyFilter(remainingFlags, tokens[tokens.length - 1]), tokens[tokens.length - 1]];
    }
    return [[], ''];
  }

  // After "<top> " (trailing space) the split produces ['<top>', ''] so
  // length=2 with endsWithSpace=true. Suggest the full subcommand list + --help.
  if (tokens.length === 2 && endsWithSpace) {
    return [[...subs, HELP_FLAG], ''];
  }

  if (tokens.length === 2 && !endsWithSpace) {
    return [fuzzyFilter([...subs, HELP_FLAG], tokens[1]), tokens[1]];
  }

  const sub = tokens[1];
  if (!sub || !subs.includes(sub)) return [[], ''];

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
    const knownValues = FLAG_VALUES[prevToken];
    if (knownValues) return [knownValues, ''];
    return [remainingFlags, ''];
  }

  const partial = tokens[tokens.length - 1];
  const prevToken = tokens.length >= 3 ? tokens[tokens.length - 2] : null;

  if (prevToken) {
    const knownValues = FLAG_VALUES[prevToken];
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
        const usedFlags = new Set(tokens.slice(1, -1).filter((t) => t.startsWith('--')));
        candidates = topFlags.filter((f) => !usedFlags.has(f));
        partial = tokens[tokens.length - 1];
      } else {
        return '';
      }
    } else if (tokens.length === 2) {
      candidates = [...subs, HELP_FLAG];
      partial = tokens[1];
    } else {
      const sub = tokens[1];
      if (!subs.includes(sub)) return '';

      const flagKey = `${cmd} ${sub}`;
      const avail = [...(COMMAND_FLAGS[flagKey] ?? []), HELP_FLAG];
      const prevToken = tokens[tokens.length - 2];
      partial = tokens[tokens.length - 1];

      const knownValues = FLAG_VALUES[prevToken];
      if (knownValues) {
        candidates = knownValues;
      } else {
        const usedFlags = new Set(tokens.slice(2, -1).filter((t) => t.startsWith('--')));
        candidates = avail.filter((f) => !usedFlags.has(f));
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
