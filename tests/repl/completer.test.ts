import { describe, it, expect } from 'vitest';
import {
  TOP_COMMANDS,
  SUBCOMMANDS,
  COMMAND_FLAGS,
  isSubsequence,
  fuzzyFilter,
  tabCompleter,
  getGhostSuffix,
  stripOptionalCliPrefix,
  unknownCommandMsg,
} from '../../src/repl/completer.js';
import { stripAnsi } from '../../src/ui/textWrap.js';

describe('stripOptionalCliPrefix', () => {
  it('removes only the first exact qianwen token', () => {
    expect(stripOptionalCliPrefix(['qianwen', 'billing', 'balance'])).toEqual([
      'billing',
      'balance',
    ]);
    expect(stripOptionalCliPrefix(['qianwen', 'qianwen', 'billing'])).toEqual([
      'qianwen',
      'billing',
    ]);
  });

  it('preserves approximate prefixes, case variants, and qianwen inside arguments', () => {
    expect(stripOptionalCliPrefix(['qianwen-cli', 'billing'])).toEqual(['qianwen-cli', 'billing']);
    expect(stripOptionalCliPrefix(['QianWen', 'billing'])).toEqual(['QianWen', 'billing']);
    expect(stripOptionalCliPrefix(['models', 'search', 'qianwen'])).toEqual([
      'models',
      'search',
      'qianwen',
    ]);
  });
});

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
    // "mod" is a prefix of both "models" and "model3d".
    const [completions, partial] = tabCompleter('mod');
    expect(completions).toEqual(['models', 'model3d']);
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

  it('returns the same completions for a full qianwen prefix and a bare REPL command', () => {
    expect(tabCompleter('qianwen billing balance re')).toEqual(tabCompleter('billing balance re'));
    expect(tabCompleter('qianwen billing balance recharge --channel ')).toEqual([['alipay'], '']);
    expect(tabCompleter('qianwen billing balance recharge ')[0]).not.toContain('--method');
    expect(tabCompleter('qianwen billing balance recharge-history --range ')).toEqual([
      ['1d', '3d', '7d', '30d'],
      '',
    ]);
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

  it('auth + space → completes to login/logout/status only, never refresh', () => {
    const [completions] = tabCompleter('auth ');
    // The three real auth subcommands must all be offered.
    expect(completions).toContain('login');
    expect(completions).toContain('logout');
    expect(completions).toContain('status');
    // `refresh` was never implemented as an auth subcommand; the completer
    // must not advertise it.
    expect(completions).not.toContain('refresh');
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

  it('command without subcommands (doctor) + space → suggests flags + --help', () => {
    const [completions] = tabCompleter('doctor ');
    expect(completions).toEqual(['--format', '--help']);
  });

  it('doctor --format + space → suggests format values', () => {
    const [completions] = tabCompleter('doctor --format ');
    expect(completions).toEqual(['table', 'json', 'text']);
  });

  it('doctor --format t → fuzzy matches format values', () => {
    const [completions, partial] = tabCompleter('doctor --format t');
    expect(completions).toEqual(['table', 'text']);
    expect(partial).toBe('t');
  });

  it('command without subcommands (version) + partial --h → completes --help', () => {
    const [completions, partial] = tabCompleter('version --h');
    expect(completions).toEqual(['--help']);
    expect(partial).toBe('--h');
  });

  it('subcommand with no defined flags (workspace list) + space → suggests --help', () => {
    // `workspace list` is a real leaf subcommand. It has no further nested
    // subcommands; the completer offers its flags plus the auto-injected --help.
    const [completions] = tabCompleter('workspace list ');
    expect(completions).toContain('--help');
  });

  it('auth refresh + space → empty (refresh is not a valid auth subcommand)', () => {
    // `refresh` was never implemented as an auth subcommand, so it is an
    // unknown subcommand and the completer offers nothing — same contract as
    // any other unknown subcommand (cf. "models bogus ").
    expect(tabCompleter('auth refresh ')).toEqual([[], '']);
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

  // ── skills command coverage ──────────────────────────────────

  it('top-level command list includes skills', () => {
    expect(TOP_COMMANDS).toContain('skills');
    const [completions, partial] = tabCompleter('skil');
    expect(completions).toEqual(['skills']);
    expect(partial).toBe('skil');
  });

  it('skills + space → suggests search/install subcommands plus --help', () => {
    expect(SUBCOMMANDS.skills).toEqual(['search', 'install']);
    const [completions] = tabCompleter('skills ');
    expect(completions).toEqual(['search', 'install', '--help']);
  });

  it('partial skills subcommand → filtered candidates', () => {
    const [completions, partial] = tabCompleter('skills in');
    expect(completions).toEqual(['install']);
    expect(partial).toBe('in');
  });

  it('skills search + space → suggests --limit, --format and --help', () => {
    expect(COMMAND_FLAGS['skills search']).toEqual(['--limit', '--format']);
    const [completions] = tabCompleter('skills search term ');
    expect(completions).toContain('--limit');
    expect(completions).toContain('--format');
    expect(completions).toContain('--help');
  });

  it('skills install + space → suggests --dir, --format and --help but not --limit', () => {
    expect(COMMAND_FLAGS['skills install']).toEqual(['--dir', '--format']);
    const [completions] = tabCompleter('skills install my-skill ');
    expect(completions).toContain('--dir');
    expect(completions).toContain('--format');
    expect(completions).toContain('--help');
    expect(completions).not.toContain('--limit');
  });

  it('skills install partial --d → completes to --dir', () => {
    const [completions, partial] = tabCompleter('skills install my-skill --d');
    expect(completions).toEqual(['--dir']);
    expect(partial).toBe('--d');
  });

  it('skills search --format + space → suggests format values', () => {
    const [completions] = tabCompleter('skills search term --format ');
    expect(completions).toEqual(['table', 'json', 'text']);
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
    // "au" now matches both "auth" and "audio", so it is no longer unique;
    // use a prefix that resolves to a single command.
    expect(getGhostSuffix('mus')).toBe('ic'); // → music
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

  it('completes a flag value for 1-level command (doctor --format ta → ble)', () => {
    expect(getGhostSuffix('doctor --format ta')).toBe('ble');
  });

  it('returns the same ghost text for a full qianwen prefix and a bare command', () => {
    expect(getGhostSuffix('qianwen billing balance re')).toBe(getGhostSuffix('billing balance re'));
    expect(getGhostSuffix('qianwen billing balance recharge --channel ali')).toBe('pay');
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

describe('tabCompleter — yunqi 三级补全', () => {
  const RESOURCES = ['forums', 'exhibitors', 'subscriptions', 'summaries', '--help'];

  it('yunqi + 空格 → 子命令', () => {
    expect(tabCompleter('yunqi ')[0]).toEqual(['list', 'subscribe', 'unsubscribe', '--help']);
  });

  it('yunqi list + 空格 → 资源名而非 flag', () => {
    expect(tabCompleter('yunqi list ')[0]).toEqual(RESOURCES);
  });

  it('部分资源名 → 过滤后的候选', () => {
    const [completions, partial] = tabCompleter('yunqi list su');
    expect(completions).toEqual(['subscriptions', 'summaries']);
    expect(partial).toBe('su');
  });

  it('未知资源名 → 无候选', () => {
    expect(tabCompleter('yunqi list typo ')[0]).toEqual([]);
  });

  it('forums 只提示论坛 flag，不提示展商专属 flag', () => {
    const [completions] = tabCompleter('yunqi list forums ');
    expect(completions).toContain('--industry');
    expect(completions).toContain('--theme-name');
    expect(completions).toContain('--page');
    expect(completions).toContain('--format');
    expect(completions).not.toContain('--enabled');
    expect(completions).not.toContain('--hall-name');
  });

  it('exhibitors 只提示展商 flag，不提示论坛专属 flag', () => {
    const [completions] = tabCompleter('yunqi list exhibitors ');
    expect(completions).toContain('--enabled');
    expect(completions).toContain('--hall-name');
    expect(completions).toContain('--format');
    expect(completions).not.toContain('--industry');
    expect(completions).not.toContain('--theme-name');
    expect(completions).not.toContain('--guest-name');
  });

  it('subscriptions 不接受业务参数，只提示 --format', () => {
    expect(tabCompleter('yunqi list subscriptions ')[0]).toEqual(['--format', '--help']);
  });

  it('summaries 只提示 --forum-id 与 --format', () => {
    expect(tabCompleter('yunqi list summaries ')[0]).toEqual(['--forum-id', '--format', '--help']);
  });

  it('--enabled 后提示 true/false', () => {
    expect(tabCompleter('yunqi list exhibitors --enabled ')).toEqual([['true', 'false'], '']);
  });

  it('两个资源共享的 --keyword 在两侧都可补全', () => {
    expect(tabCompleter('yunqi list forums --key')[0]).toEqual(['--keyword']);
    expect(tabCompleter('yunqi list exhibitors --key')[0]).toEqual(['--keyword']);
  });

  it('已用过的 flag 不再重复提示', () => {
    const [completions] = tabCompleter('yunqi list summaries --forum-id F-1 ');
    expect(completions).not.toContain('--forum-id');
    expect(completions).toContain('--format');
  });

  it('静态补全表与运行时校验的资源集合一致', () => {
    expect(SUBCOMMANDS['yunqi list']).toEqual([
      'forums',
      'exhibitors',
      'subscriptions',
      'summaries',
    ]);
    for (const resource of SUBCOMMANDS['yunqi list']) {
      expect(COMMAND_FLAGS[`yunqi list ${resource}`]).toBeDefined();
    }
  });
});
