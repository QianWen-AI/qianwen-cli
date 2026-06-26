# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-06-26

### Added

- `support list`, `support view`, `support create`, `support reply`, `support close`, `support rate` commands for ticket lifecycle management

## [1.1.0] - 2026-06-19

### Added

- `docs search` / `docs view` commands for browsing QianWen documentation
- `billing summary`, `billing breakdown`, `billing limit` commands
- `workspace list` / `workspace limit` commands
- `subscription status`, `subscription orders`, `subscription tokenplan` commands
- `usage logs` command for detailed API call history
- Interactive paginated tables for long list outputs

### Changed

- Expanded model metadata in `models info` with pricing and capability details

### Fixed

- Windows ConHost terminal compatibility for interactive UI
- Usage logs timestamp precision (full datetime)

## [1.0.1] - 2026-05-20

### Added

- One-line install scripts: `install.sh` (macOS/Linux) and `install.ps1` (Windows, CLM-compatible)
- `version --check` upgrade hints via GitHub Releases API
- `usage breakdown` exposes `granularity` field
- Persistent local cache for faster one-shot commands

### Changed

- `formatCmd()` unifies command prefix rendering across REPL and one-shot modes
- `models list/info` pricing degrades to em-dash for invalid/non-finite values
- `usage breakdown` field renamed `isToday` → `isCurrent`; label `← current`
- Free-tier placeholder changed to `Enable to unlock free-tier`
- Windows Bun credential fallback derives AES key from persisted device ID
- CI injects `__VERSION__`/`__BUILD_TIME__`/`__NODE_ENV__` into release artifacts
- CHANGELOG, GitHub issue/PR templates, and README version badges switched to English

### Fixed

- `humanizeNumber`/`humanizeWithUnit` guard against NaN/Infinity inputs with em-dash fallback

## [1.0.0] - 2026-04-30

### Added

- QianWen CLI initial public release
- OAuth 2.0 Device Flow with PKCE authentication (`auth login`, `auth logout`, `auth status`)
- Interactive REPL and one-shot command execution modes
- Model discovery (`models list`, `models info`, `models search`)
- Free tier, Token Plan, and pay-as-you-go usage tracking (`usage summary`, `usage breakdown`, `usage free-tier`, `usage payg`)
- Configuration management (`config list`, `config get`, `config set`, `config unset`)
- Environment diagnostics (`doctor`) and zsh, bash, fish shell completions
- Secure credential storage: OS keychain + AES-256-GCM encrypted file fallback
- Agent-friendly output: `--format json`, `--quiet`, and standardized exit codes (0–4, 130)
- Global configuration `~/.qianwen/config.json` with automatic migration from `<cwd>/.qianwen.json`
