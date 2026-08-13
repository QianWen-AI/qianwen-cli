/**
 * Tests for agent-dirs — known Agent skill directory registry and detection:
 * getKnownAgents inventory, resolveGlobalDir path building, resolveProjectDir
 * path building, and the isRecognizedAgentDir matching rules (path contains
 * a known projectDir as a contiguous path segment).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: homedirMock },
    homedir: homedirMock,
  };
});

import {
  getKnownAgents,
  resolveGlobalDir,
  resolveProjectDir,
  isRecognizedAgentDir,
} from '../../src/utils/agent-dirs.js';

const HOME = '/mock-home';
const CWD = '/mock-project';

let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  homedirMock.mockReturnValue(HOME);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(CWD);
});

afterEach(() => {
  cwdSpy.mockRestore();
  homedirMock.mockReset();
});

describe('getKnownAgents', () => {
  it('returns 10 known agents', () => {
    const agents = getKnownAgents();
    expect(agents).toHaveLength(10);
    for (const agent of agents) {
      expect(agent.name).toBeTruthy();
      expect(agent.displayName).toBeTruthy();
      expect(agent.projectDir).toBeTruthy();
      expect(agent.globalDir).toBeTruthy();
    }
  });

  it('lists agents in the configured display order with correct project dirs', () => {
    const agents = getKnownAgents();
    expect(agents.map((a) => [a.displayName, `./${a.projectDir}`])).toEqual([
      ['Claude Code', './.claude/skills'],
      ['Codex', './.agents/skills'],
      ['Cursor', './.cursor/skills'],
      ['Qoder', './.qoder/skills'],
      ['Qoder CN', './.qoder-cn/skills'],
      ['QoderWork', './.agents/skills'],
      ['QoderWork CN', './.agents/skills'],
      ['QwenWork', './.agents/skills'],
      ['Qwen Code', './.qwen/skills'],
      ['OpenCode', './.agents/skills'],
    ]);
  });
});

describe('resolveGlobalDir', () => {
  it('resolves absolute path based on home directory', () => {
    const claude = getKnownAgents().find((a) => a.name === 'claude-code');
    expect(claude).toBeDefined();
    expect(resolveGlobalDir(claude!)).toBe(path.join(HOME, '.claude/skills'));
  });

  it('works for multi-level globalDir', () => {
    const qoderCn = getKnownAgents().find((a) => a.name === 'qoder-cn');
    expect(qoderCn).toBeDefined();
    expect(resolveGlobalDir(qoderCn!)).toBe(path.join(HOME, '.qoder-cn/skills'));
  });
});

describe('resolveProjectDir', () => {
  it('resolves absolute path based on cwd', () => {
    const claude = getKnownAgents().find((a) => a.name === 'claude-code');
    expect(claude).toBeDefined();
    expect(resolveProjectDir(claude!)).toBe(path.resolve(CWD, '.claude/skills'));
  });

  it('works for multi-level projectDir', () => {
    const qwen = getKnownAgents().find((a) => a.name === 'qwen-code');
    expect(qwen).toBeDefined();
    expect(resolveProjectDir(qwen!)).toBe(path.resolve(CWD, '.qwen/skills'));
  });
});

describe('isRecognizedAgentDir', () => {
  it('returns true when path contains a known projectDir segment', () => {
    expect(isRecognizedAgentDir(path.join(HOME, '.claude/skills'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(CWD, '.agents/skills'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(CWD, '.qoder/skills'))).toBe(true);
  });

  it('returns true when path contains segment followed by sub-paths', () => {
    expect(isRecognizedAgentDir(path.join(HOME, '.claude/skills/pdf-extractor'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(CWD, '.agents/skills/a/b'))).toBe(true);
  });

  it('returns false when path does not contain any known segment', () => {
    expect(isRecognizedAgentDir(path.join(CWD, 'skills'))).toBe(false);
    expect(isRecognizedAgentDir('/somewhere/else')).toBe(false);
    expect(isRecognizedAgentDir('/Users/xxx/project/random-dir')).toBe(false);
  });

  it('requires segment to be on path separator boundaries', () => {
    expect(isRecognizedAgentDir(path.join(HOME, '.claude/skills-extra'))).toBe(false);
    expect(isRecognizedAgentDir(path.join(HOME, '.claude/skillsX'))).toBe(false);
    expect(isRecognizedAgentDir(`${path.join(HOME, '.claude/skills')}${path.sep}sub`)).toBe(true);
  });

  it('recognizes segment at any depth in the path', () => {
    expect(isRecognizedAgentDir('/a/b/c/.claude/skills')).toBe(true);
    expect(isRecognizedAgentDir('/deep/nested/project/.agents/skills/my-skill')).toBe(true);
    expect(isRecognizedAgentDir('/Users/user/work/.cursor/skills')).toBe(true);
  });
});
