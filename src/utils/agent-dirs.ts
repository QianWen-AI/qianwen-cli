import os from 'node:os';
import path from 'node:path';

export interface AgentDirEntry {
  name: string;
  displayName: string;
  projectDir: string;
  globalDir: string;
}

const KNOWN_AGENTS: AgentDirEntry[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    projectDir: '.claude/skills',
    globalDir: '.claude/skills',
  },
  {
    name: 'codex',
    displayName: 'Codex',
    projectDir: '.agents/skills',
    globalDir: '.agents/skills',
  },
  {
    name: 'cursor',
    displayName: 'Cursor',
    projectDir: '.cursor/skills',
    globalDir: '.cursor/skills',
  },
  {
    name: 'qoder',
    displayName: 'Qoder',
    projectDir: '.qoder/skills',
    globalDir: '.qoder/skills',
  },
  {
    name: 'qoder-cn',
    displayName: 'Qoder CN',
    projectDir: '.qoder-cn/skills',
    globalDir: '.qoder-cn/skills',
  },
  {
    name: 'qoderwork',
    displayName: 'QoderWork',
    projectDir: '.agents/skills',
    globalDir: '.agents/skills',
  },
  {
    name: 'qoderwork-cn',
    displayName: 'QoderWork CN',
    projectDir: '.agents/skills',
    globalDir: '.agents/skills',
  },
  {
    name: 'qwenwork',
    displayName: 'QwenWork',
    projectDir: '.agents/skills',
    globalDir: '.agents/skills',
  },
  {
    name: 'qwen-code',
    displayName: 'Qwen Code',
    projectDir: '.qwen/skills',
    globalDir: '.qwen/skills',
  },
  {
    name: 'opencode',
    displayName: 'OpenCode',
    projectDir: '.agents/skills',
    globalDir: '.agents/skills',
  },
];

export function getKnownAgents(): AgentDirEntry[] {
  return KNOWN_AGENTS;
}

export function resolveGlobalDir(agent: AgentDirEntry): string {
  return path.join(os.homedir(), agent.globalDir);
}

export function resolveProjectDir(agent: AgentDirEntry): string {
  return path.resolve(process.cwd(), agent.projectDir);
}

export function isRecognizedAgentDir(resolvedPath: string): boolean {
  const target = path.resolve(resolvedPath);
  const sep = path.sep;

  for (const agent of KNOWN_AGENTS) {
    const pattern = sep + agent.projectDir.split('/').join(sep);
    const idx = target.indexOf(pattern);
    if (idx !== -1) {
      const afterIdx = idx + pattern.length;
      if (afterIdx === target.length || target[afterIdx] === sep) {
        return true;
      }
    }
  }

  return false;
}
