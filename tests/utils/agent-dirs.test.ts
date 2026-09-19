/**
 * Tests for agent-dirs — the 17-agent skill directory registry and detection:
 * getKnownAgents inventory, home-based resolveGlobalDir (no platform
 * branching), cwd-based resolveProjectDir (null for agents without project
 * mode), the isRecognizedAgentDir matching rules (path contains a known
 * projectDir as a contiguous path segment) and the recommendScope location
 * heuristic (home vs project recommendation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import type { AgentDirEntry } from '../../src/utils/agent-dirs.js';

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
  recommendScope,
} from '../../src/utils/agent-dirs.js';

const HOME = '/mock-home';
const CWD = '/mock-project';

const EXPECTED_AGENTS = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    globalDir: '.claude/skills',
    projectDir: '.claude/skills',
  },
  { name: 'codex', displayName: 'Codex', globalDir: '.codex/skills', projectDir: '.agents/skills' },
  {
    name: 'cursor',
    displayName: 'Cursor',
    globalDir: '.cursor/skills',
    projectDir: '.cursor/skills',
  },
  { name: 'qoder', displayName: 'Qoder', globalDir: '.qoder/skills', projectDir: '.qoder/skills' },
  {
    name: 'qoder-cn',
    displayName: 'Qoder CN',
    globalDir: '.qoder-cn/skills',
    projectDir: '.qoder-cn/skills',
  },
  {
    name: 'qoderwork',
    displayName: 'QoderWork',
    globalDir: '.qoderwork/skills',
    projectDir: '.qoder/skills',
  },
  {
    name: 'qoderwork-cn',
    displayName: 'QoderWork CN',
    globalDir: '.qoderworkcn/skills',
    projectDir: '.qoder/skills',
  },
  {
    name: 'qwenwork',
    displayName: 'QwenWork',
    globalDir: '.qwenworkcn/skills',
    projectDir: '.qoder/skills',
  },
  {
    name: 'qwen-code',
    displayName: 'Qwen Code',
    globalDir: '.qwen/skills',
    projectDir: '.qwen/skills',
  },
  {
    name: 'opencode',
    displayName: 'OpenCode',
    globalDir: '.config/opencode/skills',
    projectDir: '.opencode/skills',
  },
  {
    name: 'workbuddy',
    displayName: 'WorkBuddy',
    globalDir: '.workbuddy/skills',
    projectDir: '.workbuddy/skills',
  },
  { name: 'trae', displayName: 'Trae', globalDir: '.trae/skills', projectDir: '.trae/skills' },
  {
    name: 'trae-cn',
    displayName: 'Trae CN',
    globalDir: '.trae/skills',
    projectDir: '.trae-cn/skills',
  },
  {
    name: 'openclaw',
    displayName: 'OpenClaw',
    globalDir: '.openclaw/skills',
    projectDir: '.openclaw/skills',
  },
  { name: 'hermes', displayName: 'Hermes', globalDir: '.hermes/skills', projectDir: null },
  {
    name: 'kimi-code',
    displayName: 'Kimi Code',
    globalDir: '.kimi-code/skills',
    projectDir: '.kimi-code/skills',
  },
  { name: 'zcode', displayName: 'ZCode', globalDir: '.zcode/skills', projectDir: '.zcode/skills' },
];

let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  homedirMock.mockReturnValue(HOME);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(CWD);
});

afterEach(() => {
  cwdSpy.mockRestore();
  homedirMock.mockReset();
});

function findAgent(name: string): AgentDirEntry {
  const agent = getKnownAgents().find((a) => a.name === name);
  expect(agent).toBeDefined();
  return agent!;
}

describe('getKnownAgents — 17-agent registry', () => {
  it('returns exactly 17 agents', () => {
    expect(getKnownAgents()).toHaveLength(17);
  });

  it('contains no duplicate names', () => {
    const names = getKnownAgents().map((a) => a.name);
    expect(new Set(names).size).toBe(17);
  });

  it.each(EXPECTED_AGENTS)(
    '$displayName → globalDir $globalDir, projectDir $projectDir',
    (expected) => {
      const agent = getKnownAgents().find((a) => a.name === expected.name);
      expect(agent).toBeDefined();
      expect(agent?.displayName).toBe(expected.displayName);
      expect(agent?.globalDir).toBe(expected.globalDir);
      expect(agent?.projectDir).toBe(expected.projectDir);
    },
  );

  it('Hermes projectDir is null (project-level unsupported)', () => {
    expect(findAgent('hermes').projectDir).toBeNull();
  });
});

describe('resolveGlobalDir — home-based absolute paths', () => {
  it('resolves OpenCode to home/.config/opencode/skills (multi-level, no platform branch)', () => {
    expect(resolveGlobalDir(findAgent('opencode'))).toBe(
      path.join(HOME, '.config', 'opencode', 'skills'),
    );
  });

  it('resolves Codex to home/.codex/skills (corrected from the legacy .agents/skills)', () => {
    expect(resolveGlobalDir(findAgent('codex'))).toBe(path.join(HOME, '.codex', 'skills'));
  });

  it.each(EXPECTED_AGENTS)('resolves $displayName under the mocked home', (expected) => {
    expect(resolveGlobalDir(findAgent(expected.name))).toBe(path.join(HOME, expected.globalDir));
  });

  it('does not branch into %APPDATA% for a Windows-style home directory', () => {
    homedirMock.mockReturnValue('C:\\Users\\tester');

    const resolved = resolveGlobalDir(findAgent('opencode'));

    expect(resolved.startsWith('C:\\Users\\tester')).toBe(true);
    expect(resolved).not.toContain('AppData');
  });
});

describe('resolveProjectDir — cwd-based absolute paths', () => {
  it('returns null for Hermes (project-level not supported)', () => {
    expect(resolveProjectDir(findAgent('hermes'))).toBeNull();
  });

  it('resolves QoderWork to cwd/.qoder/skills (differs from its globalDir)', () => {
    expect(resolveProjectDir(findAgent('qoderwork'))).toBe(path.resolve(CWD, '.qoder/skills'));
  });

  it.each(EXPECTED_AGENTS.filter((a) => a.projectDir !== null))(
    'resolves $displayName under the mocked cwd',
    (expected) => {
      expect(resolveProjectDir(findAgent(expected.name))).toBe(
        path.resolve(CWD, expected.projectDir!),
      );
    },
  );
});

describe('isRecognizedAgentDir — projectDir segment matching', () => {
  it('recognizes the newly added agent project dirs', () => {
    const dirs = [
      '.workbuddy/skills',
      '.trae/skills',
      '.trae-cn/skills',
      '.openclaw/skills',
      '.kimi-code/skills',
      '.zcode/skills',
    ];
    for (const dir of dirs) {
      expect(isRecognizedAgentDir(path.join(CWD, dir))).toBe(true);
    }
    expect(isRecognizedAgentDir(path.join(CWD, '.trae/skills/my-skill'))).toBe(true);
  });

  it('recognizes the corrected project dirs at any depth', () => {
    expect(isRecognizedAgentDir(path.join(CWD, '.qoder/skills'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(CWD, '.opencode/skills'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(CWD, '.agents/skills'))).toBe(true);
    expect(isRecognizedAgentDir('/deep/nested/project/.qoder/skills/my-skill')).toBe(true);
  });

  it('does not treat the Hermes global dir as a recognized project dir', () => {
    expect(isRecognizedAgentDir(path.join(CWD, '.hermes/skills'))).toBe(false);
  });

  it('keeps rejecting unknown directories and prefix-similar segments', () => {
    expect(isRecognizedAgentDir(path.join(CWD, 'skills'))).toBe(false);
    expect(isRecognizedAgentDir('/somewhere/else')).toBe(false);
    expect(isRecognizedAgentDir(path.join(HOME, '.claude/skills-extra'))).toBe(false);
    expect(isRecognizedAgentDir(path.join(HOME, '.claude/skillsX'))).toBe(false);
  });

  it('recognizes global skill directories under HOME', () => {
    expect(isRecognizedAgentDir(path.join(HOME, '.codex/skills'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(HOME, '.claude/skills'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(HOME, '.config/opencode/skills'))).toBe(true);
    expect(isRecognizedAgentDir(path.join(HOME, '.hermes/skills'))).toBe(true);
  });

  it('recognizes subdirectories inside a global skill directory', () => {
    expect(isRecognizedAgentDir(path.join(HOME, '.codex/skills/my-skill'))).toBe(true);
  });

  it('does not recognize the parent of a global skill directory', () => {
    expect(isRecognizedAgentDir(path.join(HOME, '.codex'))).toBe(false);
    expect(isRecognizedAgentDir(path.join(HOME, '.config/opencode'))).toBe(false);
  });

  it('matches case-insensitively on Windows (NTFS)', async () => {
    const originalPlatform = process.platform;
    const originalResolve = path.resolve;
    const originalSep = path.sep;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Simulate Windows path behavior on non-Windows hosts
    (path as Record<string, unknown>).sep = '\\';
    (path as Record<string, unknown>).resolve = (p: string) => p;
    try {
      expect(isRecognizedAgentDir('C:\\Users\\Foo\\.QODER\\Skills')).toBe(true);
      expect(isRecognizedAgentDir('c:\\users\\foo\\.qoder\\skills')).toBe(true);
      expect(isRecognizedAgentDir('C:\\Users\\Foo\\.Claude\\Skills')).toBe(true);
      expect(isRecognizedAgentDir('C:\\Users\\Foo\\.unknown\\skills')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      (path as Record<string, unknown>).sep = originalSep;
      (path as Record<string, unknown>).resolve = originalResolve;
    }
  });
});

describe('recommendScope — location-based scope recommendation', () => {
  it('recommends project when cwd is a subdirectory under home', () => {
    expect(recommendScope(path.join(HOME, 'Test', 'cli-skill-test'))).toBe('project');
  });

  it('recommends project when cwd is outside the home directory', () => {
    expect(recommendScope('/workspace/project-x')).toBe('project');
  });

  it('recommends global when cwd equals the home directory', () => {
    expect(recommendScope(HOME)).toBe('global');
  });

  it('recommends global when cwd is a global skill directory', () => {
    expect(recommendScope(path.join(HOME, '.codex/skills'))).toBe('global');
    expect(recommendScope(path.join(HOME, '.claude/skills'))).toBe('global');
    expect(recommendScope(path.join(HOME, '.config/opencode/skills'))).toBe('global');
    expect(recommendScope(path.join(HOME, '.hermes/skills'))).toBe('global');
  });

  it('recommends global when cwd is a subdirectory inside a global skill directory', () => {
    expect(recommendScope(path.join(HOME, '.codex/skills/my-skill'))).toBe('global');
  });

  it('recommends project for a sibling directory sharing the home prefix', () => {
    expect(recommendScope(`${HOME}-evil`)).toBe('project');
  });

  it('recommends project for a non-skill subdirectory under home', () => {
    expect(recommendScope(path.join(HOME, '.codex'))).toBe('project');
    expect(recommendScope(path.join(HOME, '.config/opencode'))).toBe('project');
  });

  it('recommends global when cwd equals home with a trailing slash', () => {
    expect(recommendScope(HOME + '/')).toBe('global');
  });

  it('recommends global when cwd equals a global skill directory with a trailing slash', () => {
    expect(recommendScope(path.join(HOME, '.codex/skills') + '/')).toBe('global');
  });
});
