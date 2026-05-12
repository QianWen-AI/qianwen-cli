import { describe, it, expect } from 'vitest';
import {
  TOP_COMMANDS,
  isSubsequence,
  fuzzyFilter,
  tabCompleter,
  getGhostSuffix,
  unknownCommandMsg,
} from '../../src/repl/completer.js';

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('fuzzyFilter', () => {
  it('returns all candidates for empty query', () => {
    expect(fuzzyFilter(['auth', 'usage', 'models'], '')).toEqual(['auth', 'usage', 'models']);
  });

  it('matches prefix first', () => {
    expect(fuzzyFilter(['auth', 'usage', 'models'], 'au')).toEqual(['auth']);
  });

  it('matches substring when no prefix', () => {
    expect(fuzzyFilter(['login', 'logout', 'status'], 'gout')).toEqual(['logout']);
  });

  it('matches subsequence as fallback', () => {
    expect(fuzzyFilter(['models', 'config'], 'mdl')).toEqual(['models']);
  });

  it('returns empty for no match', () => {
    expect(fuzzyFilter(['auth', 'usage'], 'xyz')).toEqual([]);
  });

  it('normalizes the query to lowercase (candidates kept verbatim)', () => {
    // Real candidates in the command tree are lowercase; only the query is
    // normalized. So an upper-case query against lowercase candidates matches.
    expect(fuzzyFilter(['auth', 'usage'], 'AU')).toEqual(['auth']);
  });
});

describe('isSubsequence', () => {
  it('matches in-order chars', () => {
    expect(isSubsequence('mdl', 'models')).toBe(true);
  });
  it('rejects out-of-order chars', () => {
    expect(isSubsequence('lmd', 'models')).toBe(false);
  });
  it('handles empty query', () => {
    expect(isSubsequence('', 'models')).toBe(true);
  });
});

// ── Tab completer ────────────────────────────────────────────────────

describe('tabCompleter', () => {
  it('empty line → all top commands', () => {
    const [completions, partial] = tabCompleter('');
    expect(completions).toEqual(TOP_COMMANDS);
    expect(partial).toBe('');
  });

  it('partial top command → fuzzy-filtered candidates', () => {
    const [completions, partial] = tabCompleter('mod');
    expect(completions).toEqual(['models']);
    expect(partial).toBe('mod');
  });

  it('top command + space → list of subcommands', () => {
    const [completions] = tabCompleter('models ');
    expect(completions).toEqual(['list', 'info', 'search', '--help']);
  });

  it('partial subcommand → filtered subcommands', () => {
    const [completions, partial] = tabCompleter('models in');
    expect(completions).toEqual(['info']);
    expect(partial).toBe('in');
  });

  it('subcommand + space → suggests available flags', () => {
    const [completions] = tabCompleter('usage breakdown ');
    expect(completions).toContain('--model');
    expect(completions).toContain('--granularity');
    expect(completions).toContain('--format');
  });

  it('partial flag → filtered flags', () => {
    const [completions, partial] = tabCompleter('usage breakdown --gr');
    expect(completions).toEqual(['--granularity']);
    expect(partial).toBe('--gr');
  });

  it('after flag with known values + space → suggests values', () => {
    const [completions] = tabCompleter('usage breakdown --granularity ');
    expect(completions).toEqual(['day', 'month', 'quarter']);
  });

  it('partial value after enumerated flag → filtered values', () => {
    const [completions, partial] = tabCompleter('usage breakdown --granularity m');
    expect(completions).toEqual(['month']);
    expect(partial).toBe('m');
  });

  it('already-used flags are removed from suggestions', () => {
    const [completions] = tabCompleter('usage breakdown --model qwen3-max --');
    expect(completions).not.toContain('--model');
    expect(completions).toContain('--granularity');
  });

  it('unknown top command → empty', () => {
    expect(tabCompleter('bogus ')).toEqual([[], '']);
  });

  it('unknown subcommand → empty (no flag suggestion)', () => {
    expect(tabCompleter('models bogus ')).toEqual([[], '']);
  });

  // ── --help auto-injection ───────────────────────────────────────────

  it('top command with subcommands + space → includes --help alongside subcommands', () => {
    const [completions] = tabCompleter('auth ');
    expect(completions).toContain('login');
    expect(completions).toContain('--help');
  });

  it('partial --h after top command → completes to --help', () => {
    const [completions, partial] = tabCompleter('auth --h');
    expect(completions).toEqual(['--help']);
    expect(partial).toBe('--h');
  });

  it('subcommand + space → includes --help in flags', () => {
    const [completions] = tabCompleter('models list ');
    expect(completions).toContain('--format');
    expect(completions).toContain('--help');
  });

  it('partial --h after subcommand → completes to --help', () => {
    const [completions, partial] = tabCompleter('usage summary --h');
    expect(completions).toEqual(['--help']);
    expect(partial).toBe('--h');
  });

  it('command without subcommands (doctor) + space → suggests --help', () => {
    const [completions] = tabCompleter('doctor ');
    expect(completions).toEqual(['--help']);
  });

  it('command without subcommands (version) + partial --h → completes --help', () => {
    const [completions, partial] = tabCompleter('version --h');
    expect(completions).toEqual(['--help']);
    expect(partial).toBe('--h');
  });

  it('subcommand with no defined flags (auth refresh) + space → suggests --help', () => {
    const [completions] = tabCompleter('auth refresh ');
    expect(completions).toEqual(['--help']);
  });

  it('--help is excluded once already used', () => {
    const [completions] = tabCompleter('models list --help ');
    expect(completions).not.toContain('--help');
  });

  // ── New option coverage ───────────────────────────────────────────

  it('models list suggests --page, --per-page, --verbose', () => {
    const [completions] = tabCompleter('models list ');
    expect(completions).toContain('--page');
    expect(completions).toContain('--per-page');
    expect(completions).toContain('--verbose');
  });

  it('models search suggests --page, --per-page, --all but not --input/--output', () => {
    const [completions] = tabCompleter('models search term ');
    expect(completions).toContain('--page');
    expect(completions).toContain('--per-page');
    expect(completions).toContain('--all');
    // models search does not support --input/--output (only models list does)
    expect(completions).not.toContain('--input');
    expect(completions).not.toContain('--output');
  });

  it('models info suggests --model and --format', () => {
    const [completions] = tabCompleter('models info ');
    expect(completions).toContain('--model');
    expect(completions).toContain('--format');
    expect(completions).toContain('--help');
  });

  it('auth login suggests --format', () => {
    const [completions] = tabCompleter('auth login ');
    expect(completions).toContain('--format');
    expect(completions).toContain('--help');
  });

  it('auth logout suggests --format', () => {
    const [completions] = tabCompleter('auth logout ');
    expect(completions).toContain('--format');
  });

  it('auth status suggests --format', () => {
    const [completions] = tabCompleter('auth status ');
    expect(completions).toContain('--format');
  });

  it('version suggests --check and --help', () => {
    const [completions] = tabCompleter('version ');
    expect(completions).toContain('--check');
    expect(completions).toContain('--help');
  });

  it('version partial --ch completes to --check', () => {
    const [completions, partial] = tabCompleter('version --ch');
    expect(completions).toEqual(['--check']);
    expect(partial).toBe('--ch');
  });
});

// ── Ghost text ───────────────────────────────────────────────────────

describe('getGhostSuffix', () => {
  it('returns empty for empty line', () => {
    expect(getGhostSuffix('')).toBe('');
  });

  it('returns empty when line ends with whitespace', () => {
    expect(getGhostSuffix('models ')).toBe('');
  });

  it('completes a partial top command (single match)', () => {
    expect(getGhostSuffix('au')).toBe('th'); // → auth
  });

  it('returns longest common prefix when multiple match', () => {
    // co → completion + config — both start with "co"
    // LCP among {completion, config} after "co" is "" (next chars 'm' vs 'n')
    expect(getGhostSuffix('co')).toBe('');
    // 'com' uniquely picks completion → suffix is 'pletion'
    expect(getGhostSuffix('com')).toBe('pletion');
  });

  it('completes a subcommand', () => {
    expect(getGhostSuffix('models in')).toBe('fo');
  });

  it('returns empty for unknown top command', () => {
    expect(getGhostSuffix('xyz')).toBe('');
  });

  it('returns empty for unknown subcommand prefix', () => {
    expect(getGhostSuffix('models xyz')).toBe('');
  });

  it('completes a flag name', () => {
    expect(getGhostSuffix('usage breakdown --gr')).toBe('anularity');
  });

  it('completes a flag value', () => {
    expect(getGhostSuffix('usage breakdown --format te')).toBe('xt');
  });
});

// ── Unknown-command message ──────────────────────────────────────────

describe('unknownCommandMsg', () => {
  it('shows did-you-mean for typo of a top command', () => {
    const msg = stripAnsi(unknownCommandMsg('mdoels'));
    expect(msg).toContain('Unknown command: mdoels.');
    expect(msg).toContain('Did you mean models?');
  });

  it('shows did-you-mean for typo of a subcommand under known top', () => {
    const msg = stripAnsi(unknownCommandMsg('models lst'));
    expect(msg).toContain('Did you mean list?');
  });

  it('falls back to generic help hint when nothing matches', () => {
    const msg = stripAnsi(unknownCommandMsg('totally-bogus-thing'));
    expect(msg).toContain('Run help for available commands.');
    expect(msg).not.toContain('Did you mean');
  });

  it('does not suggest subcommand when top command itself is unknown', () => {
    const msg = stripAnsi(unknownCommandMsg('bogus list'));
    expect(msg).not.toContain('Did you mean');
  });
});
