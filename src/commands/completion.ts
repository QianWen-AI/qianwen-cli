import type { Command } from 'commander';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
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
  // command and the noise pollutes Agent stderr parsing.
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
    --granularity) compadd day month; return ;;
    --period)      compadd today yesterday week month last-month quarter year; return ;;
    --shell)       compadd bash zsh fish; return ;;
    --input|--output|--modality) compadd text image audio video; return ;;
    --charge-type) compadd all postpaid prepaid; return ;;
    --group-by)    compadd model api-key; return ;;
    --thinking)    compadd true false; return ;;
    --upload)      compadd auto oss; return ;;
    --type)        compadd purchase renew upgrade; return ;;
    --source)      compadd official custom; return ;;
    --plan)        compadd token; return ;;
    --spec-type)   compadd pro standard; return ;;
    --language)    compadd en zh; return ;;
    --status)      compadd 0 2xx 4xx 5xx; return ;;
  esac

  # ── Top-level dispatch ────────────────────────────────────────────────────
  local -a top_commands
  top_commands=(
    'auth:Manage authentication'
    'models:Browse and search models'
    'usage:View usage and billing'
    'billing:View billing and costs'
    'subscription:Manage subscriptions'
    'workspace:Manage workspaces'
    'support:Support tickets'
    'update:Update CLI to the latest version'
    'docs:Search and view documentation'
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
        subs=('login:Login via Device Flow' 'logout:Remove credentials' 'status:Auth status')
        _describe -t commands 'auth subcommand' subs
        _arguments '(-h --help)'{-h,--help}'[Show help]'
      else
        case "\${words[3]}" in
          login)
            _arguments \\
              '--format[Output format]:format:(table json text)' \\
              '--init-only[Output device code and exit]' \\
              '--complete[Resume pending login session]' \\
              '--timeout[Polling timeout seconds]:seconds:()' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          logout|status)
            _arguments \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
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
          'logs:Browse call logs'
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
          logs)
            _arguments \\
              '--from[Start date]:date:()' \\
              '--to[End date]:date:()' \\
              '--period[Period preset]:period:(today yesterday week month last-month quarter year)' \\
              '--model[Model ID]:model:()' \\
              '--status[Status filter]:status:(0 2xx 4xx 5xx)' \\
              '--request-id[Request ID]:id:()' \\
              '--page[Page number]:n:()' \\
              '--page-size[Page size]:n:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
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
          get|unset) _arguments '1:key:()' '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]' ;;
          set) _arguments '1:key:()' '1:value:()' '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]' ;;
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

    billing)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('limit:Show billing limit' 'breakdown:Cost breakdown' 'summary:Billing summary')
        _describe -t commands 'billing subcommand' subs
      else
        case "\${words[3]}" in
          limit)
            _arguments '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]'
            ;;
          breakdown)
            _arguments \\
              '--group-by[Group by]:group:(model api-key)' \\
              '--granularity[Granularity]:granularity:(day month)' \\
              '--from[Start date]:date:()' \\
              '--to[End date]:date:()' \\
              '--period[Period preset]:period:(today yesterday week month last-month quarter year)' \\
              '--charge-type[Charge type]:type:(all postpaid prepaid)' \\
              '--top[Top N rows]:n:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          summary)
            _arguments \\
              '--from[Start cycle]:cycle:()' \\
              '--to[End cycle]:cycle:()' \\
              '--charge-type[Charge type]:type:(all postpaid prepaid)' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
        esac
      fi
      ;;

    subscription)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('status:Subscription status' 'orders:List orders' 'tokenplan:Token Plan details')
        _describe -t commands 'subscription subcommand' subs
      else
        case "\${words[3]}" in
          status)
            _arguments \\
              '--plan[Filter by plan]:kind:(token)' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          orders)
            _arguments \\
              '--from[Start date]:date:()' \\
              '--to[End date]:date:()' \\
              '--type[Order type]:kind:(purchase renew upgrade)' \\
              '--page[Page number]:n:()' \\
              '--page-size[Page size]:n:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          tokenplan)
            if (( CURRENT == 4 )); then
              local -a tsubs
              tsubs=('status:Seat-type breakdown' 'seats:List seat instances')
              _describe -t commands 'tokenplan subcommand' tsubs
            else
              case "\${words[4]}" in
                status)
                  _arguments '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]'
                  ;;
                seats)
                  _arguments \\
                    '--spec-type[Seat spec]:type:(pro standard)' \\
                    '--page[Page number]:n:()' \\
                    '--page-size[Page size]:n:()' \\
                    '--format[Output format]:format:(table json text)' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                  ;;
              esac
            fi
            ;;
        esac
      fi
      ;;

    workspace)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('list:List workspaces' 'limit:Workspace limits')
        _describe -t commands 'workspace subcommand' subs
      else
        case "\${words[3]}" in
          list|limit) _arguments '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]' ;;
        esac
      fi
      ;;

    support)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('list:List tickets' 'view:View ticket' 'create:Create ticket' 'reply:Reply to ticket' 'close:Close ticket' 'rate:Rate ticket')
        _describe -t commands 'support subcommand' subs
      else
        case "\${words[3]}" in
          list)
            _arguments \\
              '--page[Page number]:n:()' \\
              '--page-size[Items per page]:n:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          view|create|reply|close)
            _arguments '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]'
            ;;
          rate)
            _arguments \\
              '--rating[Satisfaction rating 1-5]:n:()' \\
              '--comment[Optional comment]:text:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
        esac
      fi
      ;;

    docs)
      if (( CURRENT == 3 )); then
        local -a subs
        subs=('search:Search docs' 'view:View doc page')
        _describe -t commands 'docs subcommand' subs
      else
        case "\${words[3]}" in
          search)
            _arguments \\
              '1:query:()' \\
              '--limit[Page size]:n:()' \\
              '--page[Page number]:n:()' \\
              '--language[Language]:lang:(en zh)' \\
              '--view[View result at index]:index:()' \\
              '--format[Output format]:format:(table json text)' \\
              '(-h --help)'{-h,--help}'[Show help]'
            ;;
          view)
            _arguments '--format[Output format]:format:(table json text)' '(-h --help)'{-h,--help}'[Show help]'
            ;;
        esac
      fi
      ;;

    doctor)
      _arguments \\
        '--format[Output format]:format:(table json text)' \\
        '(-h --help)'{-h,--help}'[Show help]'
      ;;

    version)
      _arguments \\
        '--check[Check for updates]' \\
        '(-h --help)'{-h,--help}'[Show help]'
      ;;

    update)
      _arguments '(-h --help)'{-h,--help}'[Show help]'
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
      COMPREPLY=( $(compgen -W "day month" -- "$cur") ); return 0 ;;
    --period)
      COMPREPLY=( $(compgen -W "today yesterday week month last-month quarter year" -- "$cur") ); return 0 ;;
    --shell)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return 0 ;;
    --input|--output)
      COMPREPLY=( $(compgen -W "text image audio video" -- "$cur") ); return 0 ;;
    --charge-type)
      COMPREPLY=( $(compgen -W "all postpaid prepaid" -- "$cur") ); return 0 ;;
    --group-by)
      COMPREPLY=( $(compgen -W "model api-key" -- "$cur") ); return 0 ;;
    --type)
      COMPREPLY=( $(compgen -W "purchase renew upgrade" -- "$cur") ); return 0 ;;
    --source)
      COMPREPLY=( $(compgen -W "official custom" -- "$cur") ); return 0 ;;
    --plan)
      COMPREPLY=( $(compgen -W "token" -- "$cur") ); return 0 ;;
    --spec-type)
      COMPREPLY=( $(compgen -W "pro standard" -- "$cur") ); return 0 ;;
    --language)
      COMPREPLY=( $(compgen -W "en zh" -- "$cur") ); return 0 ;;
    --status)
      COMPREPLY=( $(compgen -W "0 2xx 4xx 5xx" -- "$cur") ); return 0 ;;
  esac


  # ── Subcommand option completions ─────────────────────────────────────────
  if [ "$COMP_CWORD" -ge 3 ]; then
    case "$cmd" in
      models)
        case "$sub" in
          list)   COMPREPLY=( $(compgen -W "--input --output --all --page --per-page --verbose --format -h --help" -- "$cur") ); return 0 ;;
          info)   COMPREPLY=( $(compgen -W "--model --format -h --help" -- "$cur") ); return 0 ;;
          search) COMPREPLY=( $(compgen -W "--page --per-page --all --format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      usage)
        local date_opts="--from --to --period --format"
        case "$sub" in
          summary|free-tier) COMPREPLY=( $(compgen -W "$date_opts -h --help" -- "$cur") ); return 0 ;;
          payg)              COMPREPLY=( $(compgen -W "$date_opts --days -h --help" -- "$cur") ); return 0 ;;
          breakdown)         COMPREPLY=( $(compgen -W "--model --granularity $date_opts --days -h --help" -- "$cur") ); return 0 ;;
          logs)              COMPREPLY=( $(compgen -W "$date_opts --model --status --request-id --page --page-size -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      config)
        case "$sub" in
          list)      COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
          get|unset) COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
          set)       COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      completion)
        COMPREPLY=( $(compgen -W "--shell -h --help" -- "$cur") ); return 0 ;;
      auth)
        case "$sub" in
          login) COMPREPLY=( $(compgen -W "--format --init-only --complete --timeout -h --help" -- "$cur") ); return 0 ;;
          logout|status) COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      doctor)
        COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
      version)
        COMPREPLY=( $(compgen -W "--check -h --help" -- "$cur") ); return 0 ;;
      billing)
        case "$sub" in
          limit)     COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
          breakdown) COMPREPLY=( $(compgen -W "--group-by --granularity --from --to --period --charge-type --top --format -h --help" -- "$cur") ); return 0 ;;
          summary)   COMPREPLY=( $(compgen -W "--from --to --charge-type --format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      subscription)
        local sub3="\${COMP_WORDS[3]}"
        case "$sub" in
          status) COMPREPLY=( $(compgen -W "--plan --format -h --help" -- "$cur") ); return 0 ;;
          orders) COMPREPLY=( $(compgen -W "--from --to --type --page --page-size --format -h --help" -- "$cur") ); return 0 ;;
          tokenplan)
            case "$sub3" in
              status) COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
              seats)  COMPREPLY=( $(compgen -W "--spec-type --page --page-size --format -h --help" -- "$cur") ); return 0 ;;
              *)      COMPREPLY=( $(compgen -W "status seats -h --help" -- "$cur") ); return 0 ;;
            esac ;;
        esac ;;
      workspace)
        case "$sub" in
          list|limit) COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      support)
        case "$sub" in
          list)    COMPREPLY=( $(compgen -W "--page --page-size --format -h --help" -- "$cur") ); return 0 ;;
          rate)    COMPREPLY=( $(compgen -W "--rating --comment --format -h --help" -- "$cur") ); return 0 ;;
          *)       COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
      docs)
        case "$sub" in
          search) COMPREPLY=( $(compgen -W "--limit --page --language --view --format -h --help" -- "$cur") ); return 0 ;;
          view)   COMPREPLY=( $(compgen -W "--format -h --help" -- "$cur") ); return 0 ;;
        esac ;;
    esac
  fi

  # ── Subcommand completions ────────────────────────────────────────────────
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$cmd" in
      auth)       COMPREPLY=( $(compgen -W "login logout status" -- "$cur") ); return 0 ;;
      models)     COMPREPLY=( $(compgen -W "list info search" -- "$cur") ); return 0 ;;
      usage)      COMPREPLY=( $(compgen -W "summary breakdown free-tier payg logs" -- "$cur") ); return 0 ;;
      billing)    COMPREPLY=( $(compgen -W "limit breakdown summary" -- "$cur") ); return 0 ;;
      subscription) COMPREPLY=( $(compgen -W "status orders tokenplan" -- "$cur") ); return 0 ;;
      workspace)  COMPREPLY=( $(compgen -W "list limit" -- "$cur") ); return 0 ;;
      support)    COMPREPLY=( $(compgen -W "list view create reply close rate" -- "$cur") ); return 0 ;;
      docs)       COMPREPLY=( $(compgen -W "search view" -- "$cur") ); return 0 ;;
      config)     COMPREPLY=( $(compgen -W "list get set unset" -- "$cur") ); return 0 ;;
      completion) COMPREPLY=( $(compgen -W "install generate" -- "$cur") ); return 0 ;;
    esac
  fi

  # ── Top-level command completions ─────────────────────────────────────────
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "auth models usage billing subscription workspace support update docs config doctor completion version -h --help" -- "$cur") )
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
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -f
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a auth          -d 'Manage authentication'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a models        -d 'Browse and search models'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a usage         -d 'View usage and billing'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a billing       -d 'View billing and costs'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a subscription  -d 'Manage subscriptions'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a workspace     -d 'Manage workspaces'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a support       -d 'Support tickets'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a update        -d 'Update CLI to latest version'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a docs          -d 'Search documentation'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a config        -d 'Manage CLI configuration'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a doctor        -d 'Run diagnostics'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a completion    -d 'Install shell tab completion'
complete -c ${cli} -n 'not __fish_seen_subcommand_from auth models usage billing subscription workspace support docs config doctor completion version update' -a version       -d 'Show CLI version'

# ── auth subcommands ──────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status' -f
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status' -a login   -d 'Login via Device Flow'
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status' -a logout  -d 'Remove credentials'
complete -c ${cli} -n '__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status' -a status  -d 'Auth status'

# ── models subcommands ────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -f
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -a list   -d 'List models'
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -a info   -d 'Model details'
complete -c ${cli} -n '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from list info search' -a search -d 'Search models'

complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l input      -d 'Input modality'   -a 'text image audio video'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l output     -d 'Output modality'  -a 'text image audio video'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l all        -d 'Show all models'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l page      -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l per-page  -d 'Models per page'
complete -c ${cli} -n '__fish_seen_subcommand_from list'   -l verbose   -d 'Include extended details'
complete -c ${cli} -n '__fish_seen_subcommand_from info'    -l model    -d 'Model ID'
complete -c ${cli} -n '__fish_seen_subcommand_from info'    -l format   -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from search' -l page      -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from search' -l per-page  -d 'Models per page'
complete -c ${cli} -n '__fish_seen_subcommand_from search' -l all       -d 'Return all results'

# ── usage subcommands ─────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg logs' -f
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg logs' -a summary   -d 'Usage summary'
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg logs' -a breakdown -d 'Per-model breakdown'
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg logs' -a free-tier -d 'Free tier quota'
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg logs' -a payg      -d 'Pay-as-you-go usage'
complete -c ${cli} -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from summary breakdown free-tier payg logs' -a logs      -d 'Browse call logs'

complete -c ${cli} -n '__fish_seen_subcommand_from summary free-tier payg breakdown logs' -l from   -d 'Start date (YYYY-MM-DD)'
complete -c ${cli} -n '__fish_seen_subcommand_from summary free-tier payg breakdown logs' -l to     -d 'End date (YYYY-MM-DD)'
complete -c ${cli} -n '__fish_seen_subcommand_from summary free-tier payg breakdown logs' -l period -d 'Period preset' -a 'today yesterday week month last-month quarter year'
complete -c ${cli} -n '__fish_seen_subcommand_from payg breakdown logs'                  -l days   -d 'Days to look back'
complete -c ${cli} -n '__fish_seen_subcommand_from breakdown'                       -l model       -d 'Model ID (required)'
complete -c ${cli} -n '__fish_seen_subcommand_from breakdown'                       -l granularity -d 'Time granularity' -a 'day month quarter'
complete -c ${cli} -n '__fish_seen_subcommand_from logs' -l model -d 'Model ID'
complete -c ${cli} -n '__fish_seen_subcommand_from logs' -l status -d 'Status filter' -a '0 2xx 4xx 5xx'
complete -c ${cli} -n '__fish_seen_subcommand_from logs' -l request-id -d 'Request ID'
complete -c ${cli} -n '__fish_seen_subcommand_from logs' -l page -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from logs' -l page-size -d 'Page size'
complete -c ${cli} -n '__fish_seen_subcommand_from logs' -l format -d 'Output format' -a 'table json text'

# ── config subcommands ────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -f
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a list  -d 'List config'
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a get   -d 'Get a value'
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a set   -d 'Set a value'
complete -c ${cli} -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from list get set unset' -a unset -d 'Remove a value'
complete -c ${cli} -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from list get set unset' -l format -d 'Output format' -a 'table json text'

# ── completion subcommands ────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from install generate' -f
complete -c ${cli} -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from install generate' -a install  -d 'Install tab completion'
complete -c ${cli} -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from install generate' -a generate -d 'Print completion script'
complete -c ${cli} -n '__fish_seen_subcommand_from install generate' -l shell -d 'Shell type' -a 'bash zsh fish'

# ── auth options ─────────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from login'  -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from login'  -l init-only -d 'Output device code and exit'
complete -c ${cli} -n '__fish_seen_subcommand_from login'  -l complete -d 'Resume pending login session'
complete -c ${cli} -n '__fish_seen_subcommand_from login'  -l timeout -d 'Polling timeout seconds'
complete -c ${cli} -n '__fish_seen_subcommand_from logout' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from status' -l format -d 'Output format' -a 'table json text'

# ── doctor options ───────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from doctor' -l format -d 'Output format' -a 'table json text'

# ── version options ──────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from version' -l check -d 'Check for updates'



# ── billing subcommands ──────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from billing; and not __fish_seen_subcommand_from limit breakdown summary' -f
complete -c ${cli} -n '__fish_seen_subcommand_from billing; and not __fish_seen_subcommand_from limit breakdown summary' -a limit     -d 'Show billing limit'
complete -c ${cli} -n '__fish_seen_subcommand_from billing; and not __fish_seen_subcommand_from limit breakdown summary' -a breakdown -d 'Cost breakdown'
complete -c ${cli} -n '__fish_seen_subcommand_from billing; and not __fish_seen_subcommand_from limit breakdown summary' -a summary   -d 'Billing summary'

complete -c ${cli} -n '__fish_seen_subcommand_from billing limit'     -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l group-by     -d 'Group by' -a 'model api-key'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l granularity  -d 'Granularity' -a 'day month'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l from -d 'Start date'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l to -d 'End date'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l period -d 'Period preset' -a 'today yesterday week month last-month quarter year'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l charge-type -d 'Charge type' -a 'all postpaid prepaid'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l top -d 'Top N rows'
complete -c ${cli} -n '__fish_seen_subcommand_from billing breakdown' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from billing summary'   -l from -d 'Start cycle'
complete -c ${cli} -n '__fish_seen_subcommand_from billing summary'   -l to -d 'End cycle'
complete -c ${cli} -n '__fish_seen_subcommand_from billing summary'   -l charge-type -d 'Charge type' -a 'all postpaid prepaid'
complete -c ${cli} -n '__fish_seen_subcommand_from billing summary'   -l format -d 'Output format' -a 'table json text'

# ── subscription subcommands ─────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from subscription; and not __fish_seen_subcommand_from status orders tokenplan' -f
complete -c ${cli} -n '__fish_seen_subcommand_from subscription; and not __fish_seen_subcommand_from status orders tokenplan' -a status    -d 'Subscription status'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription; and not __fish_seen_subcommand_from status orders tokenplan' -a orders    -d 'List orders'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription; and not __fish_seen_subcommand_from status orders tokenplan' -a tokenplan -d 'Token Plan details'

complete -c ${cli} -n '__fish_seen_subcommand_from subscription status' -l plan -d 'Filter by plan' -a 'token'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription status' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription orders' -l from -d 'Start date'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription orders' -l to -d 'End date'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription orders' -l type -d 'Order type' -a 'purchase renew upgrade'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription orders' -l page -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription orders' -l page-size -d 'Page size'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription orders' -l format -d 'Output format' -a 'table json text'

complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan; and not __fish_seen_subcommand_from status seats' -f
complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan; and not __fish_seen_subcommand_from status seats' -a status -d 'Seat-type breakdown'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan; and not __fish_seen_subcommand_from status seats' -a seats  -d 'List seat instances'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan status' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan seats' -l spec-type -d 'Seat spec' -a 'pro standard'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan seats' -l page -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan seats' -l page-size -d 'Page size'
complete -c ${cli} -n '__fish_seen_subcommand_from subscription tokenplan seats' -l format -d 'Output format' -a 'table json text'

# ── workspace subcommands ────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from workspace; and not __fish_seen_subcommand_from list limit' -f
complete -c ${cli} -n '__fish_seen_subcommand_from workspace; and not __fish_seen_subcommand_from list limit' -a list  -d 'List workspaces'
complete -c ${cli} -n '__fish_seen_subcommand_from workspace; and not __fish_seen_subcommand_from list limit' -a limit -d 'Workspace limits'
complete -c ${cli} -n '__fish_seen_subcommand_from workspace list'  -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from workspace limit' -l format -d 'Output format' -a 'table json text'

# ── support subcommands ──────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from support; and not __fish_seen_subcommand_from list view create reply close rate' -f
complete -c ${cli} -n '__fish_seen_subcommand_from support; and not __fish_seen_subcommand_from list view create reply close rate' -a list    -d 'List tickets'
complete -c ${cli} -n '__fish_seen_subcommand_from support; and not __fish_seen_subcommand_from list view create reply close rate' -a view    -d 'View ticket'
complete -c ${cli} -n '__fish_seen_subcommand_from support; and not __fish_seen_subcommand_from list view create reply close rate' -a create  -d 'Create ticket'
complete -c ${cli} -n '__fish_seen_subcommand_from support; and not __fish_seen_subcommand_from list view create reply close rate' -a reply   -d 'Reply to ticket'
complete -c ${cli} -n '__fish_seen_subcommand_from support; and not __fish_seen_subcommand_from list view create reply close rate' -a close   -d 'Close ticket'
complete -c ${cli} -n '__fish_seen_subcommand_from support; and not __fish_seen_subcommand_from list view create reply close rate' -a rate    -d 'Rate ticket'

complete -c ${cli} -n '__fish_seen_subcommand_from support list' -l page -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from support list' -l page-size -d 'Items per page'
complete -c ${cli} -n '__fish_seen_subcommand_from support list' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from support rate' -l rating -d 'Rating 1-5'
complete -c ${cli} -n '__fish_seen_subcommand_from support rate' -l comment -d 'Optional comment'
complete -c ${cli} -n '__fish_seen_subcommand_from support rate' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from support view create reply close' -l format -d 'Output format' -a 'table json text'

# ── docs subcommands ─────────────────────────────────────────────────────────
complete -c ${cli} -n '__fish_seen_subcommand_from docs; and not __fish_seen_subcommand_from search view' -f
complete -c ${cli} -n '__fish_seen_subcommand_from docs; and not __fish_seen_subcommand_from search view' -a search -d 'Search docs'
complete -c ${cli} -n '__fish_seen_subcommand_from docs; and not __fish_seen_subcommand_from search view' -a view   -d 'View doc page'

complete -c ${cli} -n '__fish_seen_subcommand_from docs search' -l limit -d 'Page size'
complete -c ${cli} -n '__fish_seen_subcommand_from docs search' -l page -d 'Page number'
complete -c ${cli} -n '__fish_seen_subcommand_from docs search' -l language -d 'Language' -a 'en zh'
complete -c ${cli} -n '__fish_seen_subcommand_from docs search' -l view -d 'View result at index'
complete -c ${cli} -n '__fish_seen_subcommand_from docs search' -l format -d 'Output format' -a 'table json text'
complete -c ${cli} -n '__fish_seen_subcommand_from docs view' -l format -d 'Output format' -a 'table json text'

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
        handleError(
          invalidArgError(`Unsupported shell '${shell}'. Supported: bash, zsh, fish`),
          format,
        );
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
      try {
        // Shells like fish keep their rc file under a nested config directory
        // (~/.config/fish) that may not exist yet on a fresh setup; create it
        // so the append does not fail with ENOENT.
        mkdirSync(dirname(rcPath), { recursive: true });
        appendFileSync(rcPath, completionLine);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Error: Failed to write completion config to ${rcPath}: ${reason}`);
        process.exit(1);
      }

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
        handleError(
          invalidArgError(`Unsupported shell '${shell}'. Supported: bash, zsh, fish`),
          format,
        );
      }

      process.stdout.write(generateCompletion(shell));
    });

  completion.action(() => {
    completion.outputHelp();
    process.stdout.write('\n');
  });
}
