import os from 'node:os';
import path from 'node:path';

export interface AgentDirEntry {
  name: string;
  displayName: string;
  /** Project-level skills directory; null when the Agent has no project mode. */
  projectDir: string | null;
  globalDir: string;
}

export type AgentScope = 'project' | 'global';

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
    globalDir: '.codex/skills',
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
    projectDir: '.qoder/skills',
    globalDir: '.qoderwork/skills',
  },
  {
    name: 'qoderwork-cn',
    displayName: 'QoderWork CN',
    projectDir: '.qoder/skills',
    globalDir: '.qoderworkcn/skills',
  },
  {
    name: 'qwenwork',
    displayName: 'QwenWork',
    projectDir: '.qoder/skills',
    globalDir: '.qwenworkcn/skills',
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
    projectDir: '.opencode/skills',
    globalDir: '.config/opencode/skills',
  },
  {
    name: 'workbuddy',
    displayName: 'WorkBuddy',
    projectDir: '.workbuddy/skills',
    globalDir: '.workbuddy/skills',
  },
  {
    name: 'trae',
    displayName: 'Trae',
    projectDir: '.trae/skills',
    globalDir: '.trae/skills',
  },
  {
    name: 'trae-cn',
    displayName: 'Trae CN',
    projectDir: '.trae-cn/skills',
    globalDir: '.trae/skills',
  },
  {
    name: 'openclaw',
    displayName: 'OpenClaw',
    projectDir: '.openclaw/skills',
    globalDir: '.openclaw/skills',
  },
  {
    name: 'hermes',
    displayName: 'Hermes',
    projectDir: null,
    globalDir: '.hermes/skills',
  },
  {
    name: 'kimi-code',
    displayName: 'Kimi Code',
    projectDir: '.kimi-code/skills',
    globalDir: '.kimi-code/skills',
  },
  {
    name: 'zcode',
    displayName: 'ZCode',
    projectDir: '.zcode/skills',
    globalDir: '.zcode/skills',
  },
];

export function getKnownAgents(): AgentDirEntry[] {
  return KNOWN_AGENTS;
}

export function resolveGlobalDir(agent: AgentDirEntry): string {
  return path.join(os.homedir(), agent.globalDir);
}

export function resolveProjectDir(agent: AgentDirEntry): string | null {
  if (agent.projectDir === null) return null;
  return path.resolve(process.cwd(), agent.projectDir);
}

export function recommendScope(cwd: string): AgentScope {
  const isWin = process.platform === 'win32';
  const norm = (p: string): string => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  const normalizedCwd = norm(cwd);
  const home = norm(os.homedir());

  if (normalizedCwd === home) return 'global';
  for (const agent of KNOWN_AGENTS) {
    const globalAbsolute = norm(path.join(os.homedir(), agent.globalDir));
    if (normalizedCwd === globalAbsolute || normalizedCwd.startsWith(globalAbsolute + path.sep)) {
      return 'global';
    }
  }
  return 'project';
}

export function isRecognizedAgentDir(resolvedPath: string): boolean {
  const isWin = process.platform === 'win32';
  const target = isWin ? path.resolve(resolvedPath).toLowerCase() : path.resolve(resolvedPath);
  const sep = path.sep;

  for (const agent of KNOWN_AGENTS) {
    if (agent.projectDir === null) continue;
    const raw = sep + agent.projectDir.split('/').join(sep);
    const pattern = isWin ? raw.toLowerCase() : raw;
    const idx = target.indexOf(pattern);
    if (idx !== -1) {
      const afterIdx = idx + pattern.length;
      if (afterIdx === target.length || target[afterIdx] === sep) {
        return true;
      }
    }
  }

  const home = os.homedir();
  for (const agent of KNOWN_AGENTS) {
    const rawGlobal = path.join(home, agent.globalDir);
    const globalAbsolute = isWin ? rawGlobal.toLowerCase() : rawGlobal;
    if (target === globalAbsolute || target.startsWith(globalAbsolute + sep)) {
      return true;
    }
  }

  return false;
}
