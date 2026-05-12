# QianWen CLI

<p>
  <img src="./assets/QianWenAILogo.svg" alt="QianWenAI" width="220" />
</p>

> 千问云官方命令行工具。在终端或 AI Agent 运行时中，发现模型、查看用量、管理认证与诊断本地环境。

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-Apache--2.0-green)

**中文** · [English](README_en.md)

![QianWen CLI REPL 欢迎界面](./assets/QianWenCLI.png)

---

## 功能特性

- **交互模式与一次性命令**：不带参数运行 `qianwen` 进入 REPL，传递命令则适用于脚本、CI 和 Agent 工具。
- **Agent 友好协议**：命令支持 `--format json`、标准化退出码、可解析的 JSON 错误信息，以及 `--quiet` 仅返回退出码。
- **模型与用量工作流**：浏览模型、查看模型详情、按关键词搜索，以及查看免费额度、Token Plan 和按量计费用量。
- **原生凭证存储**：凭证存储在操作系统钥匙串中（可用时），并支持加密文件回退。无需 `keytar` 或原生 Node 绑定。
- **自文档化命令树**：每个命令均支持 `--help`，生成的帮助信息即为权威语法参考。

---

## 安装

### npm

```bash
npm install -g @qianwenai/qianwen-cli
```

验证安装：

```bash
qianwen version
```

若出现 `command not found: qianwen`，说明 npm 全局 bin 目录未加入 PATH。执行对应 shell 的命令即可：

| Shell | 命令 |
|---|---|
| bash | `echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc` |
| zsh | `echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc` |

### 从源码构建

```bash
git clone https://github.com/QianWen-AI/qianwen-cli.git
cd qianwen-cli
pnpm install
pnpm run build
pnpm link --global
```

验证安装：

```bash
qianwen version
```

---

## 快速开始

### 开发者

```bash
# 1. OAuth Device Flow 登录
qianwen auth login

# 2. 列出可用模型
qianwen models list

# 3. 查看模型详情
qianwen models info qwen3-coder-plus

# 4. 查看当前用量
qianwen usage summary

# 5. 诊断认证、网络、配置和本地环境
qianwen doctor
```

不带参数运行 `qianwen` 将进入 REPL。REPL 使用与一次性模式相同的命令树，并支持 readline 历史、Tab 补全和丰富的终端表格。

### AI Agent

使用一次性命令并显式请求 JSON 输出：

```bash
qianwen auth status --format json
qianwen models list --all --format json
qianwen usage summary --period month --format json
qianwen doctor --format json
```

推荐的 Agent 启动流程：

```bash
# 1. 检查凭证是否可用
qianwen auth status --format json

# 2. 如果认证缺失或过期，初始化非交互式登录
qianwen auth login --init-only --format json

# 3. 让用户打开返回的验证 URL，然后完成轮询
qianwen auth login --complete --format json
```

---

## 示例

浏览可用模型，查看模态信息、免费额度和定价：

![QianWen CLI 模型列表](./assets/model_list.png)

一站式查看免费额度、Token Plan 和按量计费用量：

![QianWen CLI 用量概览](./assets/usage_summary.png)

需要选择仍有试用容量的模型时，查看免费额度详情：

![QianWen CLI 免费额度](./assets/usage_freetier.png)

运行诊断，验证认证、网络访问、配置和 Shell 补全：

![QianWen CLI 诊断检查](./assets/doctor.png)

---

## 命令

| 领域 | 命令 | 常用标志 |
|---|---|---|
| 认证 | `auth login`, `auth logout`, `auth status` | `--init-only`, `--complete`, `--timeout`, `--format` |
| 模型 | `models list`, `models info`, `models search` | `--input`, `--output`, `--all`, `--verbose`, `--page`, `--per-page`, `--format` |
| 用量 | `usage summary`, `usage breakdown`, `usage free-tier`, `usage payg` | `--period`, `--from`, `--to`, `--days`, `--model`, `--granularity`, `--format` |
| 配置 | `config list`, `config get`, `config set`, `config unset` | `--format` |
| 诊断 | `doctor` | `--format` |
| Shell | `completion install`, `completion generate` | `--shell` |
| 版本 | `version` | `--check` |

使用帮助查看完整语法：

```bash
qianwen --help
qianwen models --help
qianwen usage breakdown --help
```

---

## 输出与退出码

输出格式解析优先级：

1. `--format` 标志
2. 配置中的 `output.format`
3. TTY 检测：交互终端使用表格，管道或重定向使用 JSON

```bash
qianwen models list
qianwen models list --format json
qianwen models list --format text
qianwen --quiet doctor
```

退出码：

| 代码 | 含义 |
|---:|---|
| `0` | 成功 |
| `1` | 通用错误或用法错误 |
| `2` | 认证错误 |
| `3` | 网络错误 |
| `4` | 配置错误 |
| `130` | 中断 |

JSON 错误遵循稳定格式：

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "未认证。请先运行 `qianwen auth login`。",
    "exit_code": 2
  }
}
```

自动化场景建议使用 `--format json`，表格输出仅供人工阅读。

JSON 输出示例：

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

## 认证

`qianwen auth login` 使用 OAuth 2.0 Device Authorization Grant with PKCE。

交互式登录：

```bash
qianwen auth login
```

非交互式登录：

```bash
qianwen auth login --init-only --format json
qianwen auth login --complete --format json
```

凭证存储在操作系统钥匙串中（可用时）。如果钥匙串不可用，CLI 会回退到加密的本地凭证文件。设置 `QIANWEN_KEYRING=plaintext` 强制使用明文文件存储（调试用）；`no`、`0`、`false` 和 `off` 也会跳过钥匙串。

---

## 配置

QianWen CLI 使用一个全局配置文件：

```text
~/.qianwen/config.json
```

公开配置项：

| 键 | 值 | 默认 |
|---|---|---|
| `output.format` | `auto`, `table`, `json`, `text` | `auto` |

```bash
qianwen config set output.format json
qianwen config get output.format
qianwen config list
qianwen config unset output.format
```

---

## 贡献

我们欢迎修复、文档改进和功能提议。

1. 从最新的 `master` 分支开始。
2. 创建一个聚焦的分支，例如 `fix/auth-token-expiry` 或 `doc/install-options`。
3. 使用 `pnpm install` 安装依赖。
4. 进行修改，并在行为变更时添加或更新测试。
5. 在提交 PR 之前运行相关检查：

```bash
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build
```

6. 使用 [Conventional Commits](https://www.conventionalcommits.org/) 提交，如 `feat:`、`fix:`、`doc:`、`refactor:` 和 `chore:`。
7. 推送分支并向 `master` 发起 Pull Request。
8. 填写 PR 模板，关联相关 Issue，描述用户可见变更，CLI UX 变更需附截图或终端输出。

面向产品的变更应包含文档更新，并需要产品和工程评审。

---

## 许可证

本项目基于 [Apache-2.0 许可证](LICENSE) 授权。
