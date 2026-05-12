import type { Command } from 'commander';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { theme } from '../ui/theme.js';
import { site } from '../site.js';
import { handleError, invalidArgError } from '../utils/errors.js';
import { resolveFormatFromCommand } from '../output/format.js';
import { getEffectiveConfig } from '../config/manager.js';

type ShellType = 'zsh' | 'bash' | 'fish';

function detectShell(): ShellType | null {
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';
  return null;
}

function getShellRcPath(shell: ShellType): string {
  switch (shell) {
    case 'zsh':
      return join(homedir(), '.zshrc');
    case 'bash':
      return join(homedir(), '.bashrc');
    case 'fish':
      return join(homedir(), '.config', 'fish', 'config.fish');
  }
}

function getSourceCommand(shell: ShellType): string {
  switch (shell) {
    case 'zsh':
      return 'source ~/.zshrc';
    case 'bash':
      return 'source ~/.bashrc';
    case 'fish':
      return 'source ~/.config/fish/config.fish';
  }
}

function getCompletionLine(shell: ShellType): string {
  const cli = site.cliName;
  switch (shell) {
    case 'zsh':
      return `\n# ${site.cliDisplayName} completion\neval "$(${cli} completion generate --shell zsh)"`;
    case 'bash':
      return `\n# ${site.cliDisplayName} completion\neval "$(${cli} completion generate --shell bash)"`;
    case 'fish':
      return `\n# ${site.cliDisplayName} completion\n${cli} completion generate --shell fish | source`;
  }
}

function generateZshCompletion(): string {
  const cli = site.cliName;
  const fnName = `_${cli}`;
  // The script is meant to be eval'd from .zshrc, not placed in $fpath, so the
  // `#compdef` magic comment is dropped. Before calling `compdef` we ensure
  // compinit has run — otherwise zsh emits
  // `compdef:153: _comps: assignment to invalid subscript range` on every
  // command and the noise pollutes Agent stderr parsing (report 6.2 in
  // agent-experience-review.md).
  return `# ${site.cliDisplayName} zsh completion (generated)
if ! whence compdef >/dev/null 2>&1; then
  autoload -Uz compinit
  compinit -i
fi

${fnName}() {
  local cur="\${words[-1]}" prev="\${words[-2]}"

  # ── Option value completions (global, position-independent) ──────────────
  case "$prev" in
    --format)      compadd table json text; return ;;
    --granularity) compadd day month quarter; return ;;
    --period)      compadd today yesterday week month last-month quarter year; return ;;
    --shell)       compadd bash zsh fish; return ;;
    --input|--output) compadd text image audio video; return ;;
  esac

  # ── Top-level dispatch ────────────────────────────────────────────────────
  local -a top_commands
  top_commands=(
    'auth:Manage authentication'
    'models:Browse and search models'
    'usage:View usage and billing'
    'config:Manage CLI configuration'
    'doctor:Run diagnostics'
    'completion:Install shell tab completion'
    'version:Show CLI version'
  )

  if (( CURRENT == 2 )); then
    _describe -t commands '${cli} command' top_commands
    _arguments '(-h --help)'{-h,--help}'[Show help]'
    return
  fi

  # ── Subcommand dispatch ───────────────────────────────────────────────────
  local cmd="\${words[2]}"

  case "$cmd" in
    auth)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('login:Login via Device Flow' 'logout:Remove credentials' 'status:Auth status' 'refresh:Refresh token')
        _describe -t commands 'auth subcommand' subs
        _arguments '(-h --help)'{-h,--help}'[Show help]'
      else
        case "\${words[3]}" in
          login|logout|status)
            _arguments \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          refresh)
            _arguments '(-h --help)'{-h,--help}'[Show help]'
            ;;
        esac
      fi
      ;;

    models)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('list:List models' 'info:Model details' 'search:Search models')
        _describe -t commands 'models subcommand' subs
      else
        case "\${words[3]}" in
          list)
            _arguments \\
              '--input[Input modality]:modality:(text image audio video)' \\
              '--output[Output modality]:modality:(text image audio video)' \\
              '--all[Show all models]' \\
              '--free-tier[Free tier models only]' \\
              '--page[Page number]:n:()' \\
              '--per-page[Models per page]:n:()' \\
              '--verbose[Include extended details]' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          info)
            _arguments \\
              '--model[Model ID]:model:()' \\
              '1:model:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          search)
            _arguments \\
              '1:query:()' \\
              '--page[Page number]:n:()' \\
              '--per-page[Models per page]:n:()' \\
              '--all[Return all results]' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
        esac
      fi
      ;;

    usage)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=(
          'summary:Usage summary across all models'
          'breakdown:Per-model breakdown by date'
          'free-tier:Free tier quota status'
          'payg:Pay-as-you-go usage'
        )
        _describe -t commands 'usage subcommand' subs
      else
        local -a date_opts
        date_opts=(
          '--from[Start date (YYYY-MM-DD)]:date:()'
          '--to[End date (YYYY-MM-DD)]:date:()'
          '--period[Period preset]:period:(today yesterday week month last-month quarter year)'
          '--format[Output format]:format:(table json text)'
        )
        local help_opt='(-h --help)'{-h,--help}'[Show help]'
        case "\${words[3]}" in
          summary|free-tier)
            _arguments $date_opts $help_opt
            ;;
          payg)
            _arguments $date_opts '--days[Days to look back]:n:()' $help_opt
            ;;
          breakdown)
            _arguments \\
              '--model[Model ID (required)]:model:()' \\
              '--granularity[Time granularity]:granularity:(day month quarter)' \\
              '--from[Start date]:date:()' \\
              '--to[End date]:date:()' \\
              '--period[Period preset]:period:(today yesterday week month last-month quarter year)' \\
              '--days[Days to look back]:n:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
        esac
      fi
      ;;

    config)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('list:List all config' 'get:Get a value' 'set:Set a value' 'unset:Remove a value')
        _describe -t commands 'config subcommand' subs
      else
        case "\${words[3]}" in
          list) _arguments '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]' ;;
          get|set|unset) _arguments '1:key:()' '(-h --help)'{-h,--help}'[Show help]' ;;
        esac
      fi
      ;;

    completion)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('install:Install tab completion' 'generate:Print completion script')
        _describe -t commands 'completion subcommand' subs
      else
        _arguments '--shell[Shell type]:shell:(bash zsh fish)' '(-h --help)'{-h,--help}'[Show help]'
      fi
      ;;

    doctor)
      _arguments '(-h --help)'{-h,--help}'[Show help]'
      ;;

    version)
      _arguments \\
        '--check[Check for updates]' \\
        '(-h --help)'{-h,--help}'[Show help]'
      ;;
  esac
}

compdef ${fnName} ${cli}
`;
}

function generateBashCompletion(): string {
  const cli = site.cliName;
  const fnName = `_${cli}`;
  return `${fnName}() {
  local cur prev cmd sub
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  sub="\${COMP_WORDS[2]}"

  # ── Option value completions ──────────────────────────────────────────────
  case "$prev" in
    --format)
      COMPREPLY=( $(compgen -W "table json text" -- "$cur") ); return 0 ;;
    --granularity)
      COMPREPLY=( $(compgen -W "day month quarter" -- "$cur") ); return 0 ;;
    --period)
      COMPREPLY=( $(compgen -W "today yesterday week month last-month quarter year" -- "$cur") ); return 0 ;;
    --shell)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return 0 ;;
    --input|--output)
      COMPREPLY=( $(compgen -W "text image audio video" -- "$cur") ); return 0 ;;
  esac

  # ── Subcommand option completions ─────────────────────────────────────────
  if [ "$COMP_CWORD" -ge 3 ]; then
    case "$cmd" in
      models)
        case "$sub" in
          list)   COMPREPLY=( $(compgen -W "--input --output --all --free-tier --page --per-page --verbose --format -h --help" -- "$cur") ); return 0 ;;
          info)   COMPREPLY=( $(compgen -W "--model --format -h --help" -- "$cur") ); return 0 ;;
          search) COMPREPLY=( $(compgen -W "--page --per-page --all --format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      usage)
        local date_opts="--from --to --period --format"
        case "$sub" in
          summary|free-tier) COMPREPLY=( $(compgen -W "$date_opts -h --help" -- "$cur") ); return 0 ;;
          payg)              COMPREPLY=( $(compgen -W "$date_opts --days -h --help" -- "$cur") ); return 0 ;;
          breakdown)         COMPREPLY=( $(compgen -W "--model --granularity $date_opts --days -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      config)
        case "$sub" in
          list) COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      completion)
        COMPREPLY=( $(compgen -W "--shell -h --help" -- "$cur") ); return 0 ;;
      auth)
        case "$sub" in
          login|logout|status) COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      doctor)
        COMPREPLY=( $(compgen -W "-h --help" -- "$cur") ); return 0 ;;
      version)
        COMPREPLY=( $(compgen -W "--check -h --help" -- "$cur") ); return 0 ;;
    esac
  fi

  # ── Subcommand completions ────────────────────────────────────────────────
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$cmd" in
      auth)       COMPREPLY=( $(compgen -W "login logout status refresh" -- "$cur") ); return 0 ;;
      models)     COMPREPLY=( $(compgen -W "list info search" -- "$cur") ); return 0 ;;
      usage)      COMPREPLY=( $(compgen -W "summary breakdown free-tier payg" -- "$cur") ); return 0 ;;
      config)     COMPREPLY=( $(compgen -W "list get set unset" -- "$cur") ); return 0 ;;
      completion) COMPREPLY=( $(compgen -W "install generate" -- "$cur") ); return 0 ;;
    esac
  fi

  # ── Top-level command completions ─────────────────────────────────────────
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "auth models usage config doctor completion version -h --help" -- "$cur") )
  fi
}

complete -F ${fnName} ${cli}
`;
}

function generateFishCompletion(): string {
  const cli = site.cliName;
  const helperPrefix = `__${cli}`;
  return `# ${site.cliDisplayName} completions for fish

# ── Helpers ───────────────────────────────────────────────────────────────────
function ${helperPrefix}_seen_cmd
  set -l cmd (commandline -opc)
  contains -- $argv[1] $cmd
end

function ${helperPrefix}_seen_sub
  set -l cmd (commandline -opc)
  contains -- $argv[1] $cmd and contains -- $argv[2] $cmd
end

# ── Top-level commands ────────────────────────────────────────────────────────
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -f
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -a auth       -d 'Manage authentication'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -a models     -d 'Browse and search models'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -a usage      -d 'View usage and billing'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -a config     -d 'Manage CLI configuration'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -a doctor     -d 'Run diagnostics'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -a completion -d 'Install shell tab completion'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage config doctor completion version update' -a version    -d 'Show CLI version'

# ── auth subcommands ──────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status refresh' -f
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status refresh' -a login   -d 'Login via Device Flow'
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status refresh' -a logout  -d 'Remove credentials'
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status refresh' -a status  -d 'Auth status'
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status refresh' -a refresh -d 'Refresh token'

# ── models subcommands ────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -f
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -a list   -d 'List models'
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -a info   -d 'Model details'
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -a search -d 'Search models'

complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l input      -d 'Input modality'   -a 'text image audio video'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l output     -d 'Output modality'  -a 'text image audio video'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l all        -d 'Show all models'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l free-tier  -d 'Free tier only'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l page      -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l per-page  -d 'Models per page'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l verbose   -d 'Include extended details'
complete -c ${cli} -n '__fish_seen_subcommand_from info'    -l model    -d 'Model ID'
complete -c ${cli} -n '__fish_seen_subcommand_from info'    -l format   -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from search' -l page      -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from search' -l per-page  -d 'Models per page'
complete -c ${cli} -n '__fish_seen_subcommand_from search' -l all       -d 'Return all results'

# ── usage subcommands ─────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg' -f
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg' -a summary   -d 'Usage summary'
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg' -a breakdown -d 'Per-model breakdown'
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg' -a free-tier -d 'Free tier quota'
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg' -a payg      -d 'Pay-as-you-go usage'

complete -c ${cli} -n '__fish_seen_subcommand_from summary free-tier payg breakdown' -l from   -d 'Start date (YYYY-MM-DD)'
complete -c ${cli} -n '__fish_seen_subcommand_from summary free-tier payg breakdown' -l to     -d 'End date (YYYY-MM-DD)'
complete -c ${cli} -n '__fish_seen_subcommand_from summary free-tier payg breakdown' -l period -d 'Period preset' -a 'today yesterday week month last-month quarter year'
complete -c ${cli} -n '__fish_seen_subcommand_from payg breakdown'                  -l days   -d 'Days to look back'
complete -c ${cli} -n '__fish_seen_subcommand_from breakdown'                       -l model       -d 'Model ID (required)'
complete -c ${cli} -n '__fish_seen_subcommand_from breakdown'                       -l granularity -d 'Time granularity' -a 'day month quarter'

# ── config subcommands ────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -f
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a list  -d 'List config'
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a get   -d 'Get a value'
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a set   -d 'Set a value'
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a unset -d 'Remove a value'

# ── completion subcommands ────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from install generate' -f
complete -c ${cli} -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from install generate' -a install  -d 'Install tab completion'
complete -c ${cli} -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from install generate' -a generate -d 'Print completion script'
complete -c ${cli} -n '__fish_seen_subcommand_from install generate' -l shell -d 'Shell type' -a 'bash zsh fish'

# ── auth options ─────────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from login'  -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from logout' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from status' -l format -d 'Output format' -a 'table json text'

# ── version options ──────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from version' -l check -d 'Check for updates'

# ── Global options ────────────────────────────────────────────────────────────
complete -c ${cli} -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -s h -l help    -d 'Show help'
complete -c ${cli} -s v -l version -d 'Show version'
`;
}

function generateCompletion(shell: ShellType): string {
  switch (shell) {
    case 'zsh':
      return generateZshCompletion();
    case 'bash':
      return generateBashCompletion();
    case 'fish':
      return generateFishCompletion();
  }
}

export function registerCompletionCommand(program: Command): void {
  const completion = program.command('completion').description('Install shell tab completion');

  completion
    .command('install')
    .description('Install tab completion for your shell')
    .option('--shell <shell>', 'Shell type: bash, zsh, fish')
    .action((opts) => {
      const shell = (opts.shell as ShellType) ?? detectShell();
      if (!shell) {
        const config = getEffectiveConfig();
        const format = resolveFormatFromCommand(completion, config);
        handleError(invalidArgError('Unable to detect shell. Use --shell <bash|zsh|fish>'), format);
      }

      if (!['zsh', 'bash', 'fish'].includes(shell)) {
        const config = getEffectiveConfig();
        const format = resolveFormatFromCommand(completion, config);
        handleError(invalidArgError(`Unsupported shell '${shell}'. Supported: bash, zsh, fish`), format);
      }

      console.log(`Detected shell: ${shell}`);

      const rcPath = getShellRcPath(shell);

      // Check if already installed
      if (existsSync(rcPath)) {
        const content = readFileSync(rcPath, 'utf-8');
        if (content.includes(`${site.cliName} completion generate`)) {
          console.log(
            `${theme.success(theme.symbols.pass)}  Completion already installed in ${rcPath}`,
          );
          return;
        }
      }

      const completionLine = getCompletionLine(shell);
      appendFileSync(rcPath, completionLine);

      const sourceCmd = getSourceCommand(shell);
      console.log(
        `${theme.success(theme.symbols.pass)}  Done! Restart your terminal or run: ${sourceCmd}`,
      );
    });

  completion
    .command('generate')
    .description('Generate completion script')
    .option('--shell <shell>', 'Shell type: bash, zsh, fish')
    .action((opts) => {
      const shell = (opts.shell as ShellType) ?? detectShell();
      if (!shell) {
        const config = getEffectiveConfig();
        const format = resolveFormatFromCommand(completion, config);
        handleError(invalidArgError('Unable to detect shell. Use --shell <bash|zsh|fish>'), format);
      }

      if (!['zsh', 'bash', 'fish'].includes(shell)) {
        const config = getEffectiveConfig();
        const format = resolveFormatFromCommand(completion, config);
        handleError(invalidArgError(`Unsupported shell '${shell}'. Supported: bash, zsh, fish`), format);
      }

      process.stdout.write(generateCompletion(shell));
    });

  completion.action(() => {
    completion.outputHelp();
    process.stdout.write('\n');
  });
}
