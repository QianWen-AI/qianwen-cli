# QianWen CLI

<p>
  <img src="./assets/QianWenAILogo.svg" alt="QianWenAI" width="220" />
</p>

> Official command-line tool for [QianWen](https://www.qianwenai.com/). Discover models, check usage, manage authentication, and diagnose local setup from a terminal or an AI agent runtime.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-Apache--2.0-green)

**English** · [中文](./README.md)

![QianWen CLI REPL welcome screen](./assets/QianWenCLI.png)

---

## Features

- **Interactive and one-shot modes**: run `qianwen` with no arguments for a REPL, or pass a command for scripts, CI, and agent tools.
- **Agent-ready contract**: commands support `--format json`, standardized exit codes, parseable JSON errors, and `--quiet` for exit-code-only checks.
- **Model and usage workflows**: browse models, inspect model metadata, search by keyword, and review Free Tier, Token Plan, and PAYG usage.
- **Native credential storage**: credentials are stored in the OS keychain when available, with an encrypted file fallback. No `keytar` or native Node binding is required.
- **Self-documenting command tree**: every command supports `--help`; generated help is the canonical syntax reference.

---

## Installation

Choose the channel that matches your environment. npm and source builds are available.

### npm

```bash
npm install -g @qianwenai/qianwen-cli
```

Verify the install:

```bash
qianwen version
```

If you see `command not found: qianwen` after installation, the npm global bin directory is not in your PATH. Run the command for your shell:

| Shell | Command |
|---|---|
| bash | `echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc` |
| zsh | `echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc` |

### Build from Source

```bash
git clone https://github.com/QianWen-AI/qianwen-cli.git
cd qianwen-cli
pnpm install
pnpm run build
pnpm link --global
```

Verify the install:

```bash
qianwen version
```

---

## Quick Start

### For Developers

```bash
# 1. Log in with OAuth Device Flow
qianwen auth login

# 2. List available models
qianwen models list

# 3. Inspect a model
qianwen models info qwen3-coder-plus

# 4. Review current usage
qianwen usage summary

# 5. Check auth, network, config, and local environment
qianwen doctor
```

Running `qianwen` with no arguments opens the REPL. The REPL uses the same command tree as one-shot mode and adds readline history, tab completion, and rich terminal tables.

### For AI Agents

Use one-shot commands and request JSON explicitly:

```bash
qianwen auth status --format json
qianwen models list --all --format json
qianwen usage summary --period month --format json
qianwen doctor --format json
```

Recommended Agent startup flow:

```bash
# 1. Check if credentials are available
qianwen auth status --format json

# 2. If authentication is missing or expired, initiate non-interactive login
qianwen auth login --init-only --format json

# 3. Prompt the user to open the returned verification URL, then complete polling
qianwen auth login --complete --format json
```

---

## Examples

Browse available models and inspect their modality, free tier quota, and pricing from the terminal:

![QianWen CLI models list](./assets/model_list.png)

Review account usage across Free Tier, Token Plan, and PAYG in one command:

![QianWen CLI usage summary](./assets/usage_summary.png)

Drill into free tier quota status when you need to choose a model with remaining trial capacity:

![QianWen CLI free tier usage](./assets/usage_freetier.png)

Run diagnostics to verify authentication, network access, configuration, and shell completion:

![QianWen CLI doctor diagnostics](./assets/doctor.png)

---

## Commands

| Area | Commands | Common flags |
|---|---|---|
| Auth | `auth login`, `auth logout`, `auth status` | `--init-only`, `--complete`, `--timeout`, `--format` |
| Models | `models list`, `models info`, `models search` | `--input`, `--output`, `--all`, `--verbose`, `--page`, `--per-page`, `--format` |
| Usage | `usage summary`, `usage breakdown`, `usage free-tier`, `usage payg` | `--period`, `--from`, `--to`, `--days`, `--model`, `--granularity`, `--format` |
| Config | `config list`, `config get`, `config set`, `config unset` | `--format` |
| Diagnostics | `doctor` | `--format` |
| Shell | `completion install`, `completion generate` | `--shell` |
| Version | `version` | `--check` |

Use help for exact syntax:

```bash
qianwen --help
qianwen models --help
qianwen usage breakdown --help
```

---

## Output and Exit Codes

Output format resolution order:

1. `--format` flag
2. `output.format` from config
3. TTY detection: table in an interactive terminal, JSON when piped or captured

```bash
qianwen models list
qianwen models list --format json
qianwen models list --format text
qianwen --quiet doctor
```

Exit codes:

| Code | Meaning |
|---:|---|
| `0` | Success |
| `1` | General or usage error |
| `2` | Authentication error |
| `3` | Network error |
| `4` | Configuration error |
| `130` | Interrupted |

JSON errors follow a stable shape:

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Not authenticated. Run `qianwen auth login` first.",
    "exit_code": 2
  }
}
```

For automation, prefer `--format json` and treat table output as human-only.

Example JSON output:

```json
{
  "models": [
    {
      "id": "qwen3-coder-plus",
      "modality": { "input": ["text"], "output": ["text"] },
      "pricing": { "tiers": [{ "input": 0.5, "output": 2.0, "unit": "CNY/1M tokens" }] }
    }
  ],
  "total": 1,
  "page": 1,
  "per_page": 20,
  "total_pages": 1
}
```

---

## Authentication

`qianwen auth login` uses OAuth 2.0 Device Authorization Grant with PKCE.

Interactive login:

```bash
qianwen auth login
```

Non-interactive login:

```bash
qianwen auth login --init-only --format json
qianwen auth login --complete --format json
```

Credentials are stored in the OS keychain when available. If keychain access is unavailable, the CLI falls back to an encrypted local credential file. Set `QIANWEN_KEYRING=plaintext` to force plaintext file storage for debugging; `no`, `0`, `false`, and `off` also skip keychain access.

---

## Configuration

QianWen CLI uses one global config file:

```text
~/.qianwen/config.json
```

Public configuration keys:

| Key | Values | Default |
|---|---|---|
| `output.format` | `auto`, `table`, `json`, `text` | `auto` |

```bash
qianwen config set output.format json
qianwen config get output.format
qianwen config list
qianwen config unset output.format
```

---

## Contributing

We welcome fixes, documentation improvements, and feature proposals.

1. Start from the latest `master`.
2. Create a focused branch, for example `fix/auth-token-expiry` or `doc/install-options`.
3. Install dependencies with `pnpm install`.
4. Make the change and add or update tests when behavior changes.
5. Run the relevant checks before opening a PR:

```bash
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build
```

6. Commit with [Conventional Commits](https://www.conventionalcommits.org/), such as `feat:`, `fix:`, `doc:`, `refactor:`, and `chore:`.
7. Push your branch and open a pull request against `master`.
8. Fill in the PR template, link related issues, describe user-visible changes, and include screenshots or terminal output for CLI UX changes.

Product-facing changes should include documentation updates and need product and engineering review.

---

## License

This project is licensed under the [Apache-2.0 License](LICENSE).
