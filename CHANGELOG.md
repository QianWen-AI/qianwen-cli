# 更新日志

本文件记录了项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [Unreleased]

## [1.0.0] - 2026-05-12

### 新增

- QianWen CLI 首次公开发布
- OAuth 2.0 Device Flow with PKCE 认证（`auth login`、`auth logout`、`auth status`）
- 交互式 REPL 和一次性命令执行模式
- 模型发现（`models list`、`models info`、`models search`）
- 免费额度、Token Plan 和按量计费用量追踪（`usage summary`、`usage breakdown`、`usage free-tier`、`usage payg`）
- 配置管理（`config list`、`config get`、`config set`、`config unset`）
- 环境诊断（`doctor`）和 zsh、bash、fish Shell 补全
- 安全凭证存储：操作系统钥匙串 + AES-256-GCM 加密文件回退
- Agent 友好输出：`--format json`、`--quiet` 和标准化退出码（0–4、130）
- 全局配置 `~/.qianwen/config.json`，支持从 `<cwd>/.qianwen.json` 自动迁移
