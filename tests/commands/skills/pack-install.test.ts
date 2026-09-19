/**
 * Tests for `skills pack-install` — pack-name validation (T-6), baseDir
 * resolution (--dir / table agent pick / cwd fallback warning T-7), the
 * protective --dir preflight (root guard, not-found, not-writable), the
 * tri-format output contract (JSON five-field shape, ANSI-free text rows
 * with B2 row-level co-occurrence assertions, single Ink render), the
 * confirmation injection (interactive table page B10 vs --dir implicit
 * confirm T-8), terminal error propagation, member-failure exit codes,
 * USER_CANCELLED (exit 0, B3) and signed-URL non-disclosure.
 */
import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { PackInstallResult } from '../../../src/types/skills.js';
import type { AgentDirSelection } from '../../../src/ui/AgentDirPrompt.js';
import { CliError } from '../../../src/utils/errors.js';
import { getCommandExamples } from '../../../src/utils/commander-helpers.js';
import {
  renderInkForTest,
  clearRenderedFrames,
  renderedFrames,
} from '../../helpers/ink-render-mock.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };
let workDir: string;
let prevCwd: string;
let prevStdinIsTTY: boolean | undefined;

const {
  renderWithInkSpy,
  isRecognizedAgentDirMock,
  promptAgentDirMock,
  spinnerPauseSpy,
  spinnerResumeSpy,
  useInputSpy,
} = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: ReactElement) => Promise<void>>(),
  isRecognizedAgentDirMock: vi.fn<(resolvedPath: string) => boolean>(),
  promptAgentDirMock:
    vi.fn<
      (defaultPath: string, agents: unknown[], slug: string) => Promise<AgentDirSelection | null>
    >(),
  spinnerPauseSpy: vi.fn(),
  spinnerResumeSpy: vi.fn(),
  useInputSpy: vi.fn(),
}));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
// Hard no-credentials environment: pack-install must work while logged out.
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: vi.fn(() => {
    throw new Error('Not authenticated. Please run `qianwen auth login` first.');
  }),
  getCredentials: vi.fn(() => null),
  resolveCredentials: vi.fn(() => null),
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
  pauseSpinner: spinnerPauseSpy,
  resumeSpinner: spinnerResumeSpy,
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderWithInkSync: renderWithInkSpy,
  renderInteractive: renderWithInkSpy,
}));
vi.mock('../../../src/utils/agent-dirs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/agent-dirs.js')>();
  return {
    ...actual,
    isRecognizedAgentDir: isRecognizedAgentDirMock,
  };
});
vi.mock('../../../src/ui/AgentDirPrompt.js', () => ({
  promptAgentDir: promptAgentDirMock,
}));
// PackInstallConfirm mounts useInput, which ink-testing-library's stdin stub
// cannot host (no ref()); neutralize the hook so the review page still renders
// a frame (DocsViewer.test convention).
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useInput: useInputSpy };
});

import { registerSkillsPackInstallCommand } from '../../../src/commands/skills/pack-install.js';

function build(program: import('commander').Command) {
  const skills = program.command('skills');
  registerSkillsPackInstallCommand(skills);
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
  isRecognizedAgentDirMock.mockReset();
  isRecognizedAgentDirMock.mockReturnValue(true);
  promptAgentDirMock.mockReset();
  promptAgentDirMock.mockResolvedValue(null);
  spinnerPauseSpy.mockReset();
  spinnerResumeSpy.mockReset();
  useInputSpy.mockReset();
  prevCwd = process.cwd();
  prevStdinIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  workDir = mkdtempSync(path.join(tmpdir(), 'qianwen-pack-install-cmd-'));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  Object.defineProperty(process.stdin, 'isTTY', { value: prevStdinIsTTY, configurable: true });
  rmSync(workDir, { recursive: true, force: true });
});

const PACK = 'qwen-pack';

const memberInstalled = {
  fullSlug: '@qianwen-ai/skill-a',
  outcome: 'installed',
  version: '1.2.0',
  targetDir: '/tmp/skills/skill-a',
} as const;

const memberChanged = {
  fullSlug: '@qianwen-ai/skill-b',
  outcome: 'changed',
  version: '1.2.0',
  previousVersion: '1.1.0',
  targetDir: '/tmp/skills/skill-b',
} as const;

const memberNoop = {
  fullSlug: '@other-ns/skill-c',
  outcome: 'noop',
  version: '0.9.0',
} as const;

const memberOverride = {
  fullSlug: '@qianwen-ai/skill-b',
  outcome: 'changed',
  version: '1.2.0',
  previousVersion: '0.5.0',
  previousSlug: '@other-ns/old-skill',
  targetDir: '/tmp/skills/skill-b',
} as const;

const memberFailed = {
  fullSlug: '@qianwen-ai/skill-d',
  outcome: 'failed',
  error: {
    code: 'DOWNLOAD_FAILED',
    message: 'Skill package download failed. Check your network and try again.',
  },
} as const;

/** Four-member fixture: installed / changed / noop / failed, one each. */
const fourMemberResult: PackInstallResult = {
  pack: PACK,
  displayName: 'Qianwen Official Pack',
  overallStatus: 'partial',
  baseDir: '/tmp/skills',
  summary: { installed: 1, changed: 1, skipped: 1, failed: 1 },
  items: [memberInstalled, memberChanged, memberNoop, memberFailed],
};

const successResult: PackInstallResult = {
  pack: PACK,
  displayName: 'Qianwen Official Pack',
  overallStatus: 'success',
  baseDir: '/tmp/skills',
  summary: { installed: 2, changed: 0, skipped: 1, failed: 0 },
  items: [memberInstalled, memberChanged, memberNoop],
};

const allNoopResult: PackInstallResult = {
  pack: PACK,
  displayName: 'Qianwen Official Pack',
  overallStatus: 'success',
  baseDir: '/tmp/skills',
  summary: { installed: 0, changed: 0, skipped: 2, failed: 0 },
  items: [memberNoop, { ...memberNoop, fullSlug: '@qianwen-ai/skill-e' }],
};

const allFailedResult: PackInstallResult = {
  pack: PACK,
  displayName: 'Qianwen Official Pack',
  overallStatus: 'failed',
  baseDir: '/tmp/skills',
  summary: { installed: 0, changed: 0, skipped: 0, failed: 2 },
  items: [
    memberFailed,
    {
      ...memberFailed,
      fullSlug: '@qianwen-ai/skill-e',
      error: {
        code: 'INSTALL_FAILED',
        message: "Failed to install skill '@qianwen-ai/skill-e'. Existing files were not changed.",
      },
    },
  ],
};

const noopPlusFailedResult: PackInstallResult = {
  pack: PACK,
  displayName: 'Qianwen Official Pack',
  overallStatus: 'partial',
  baseDir: '/tmp/skills',
  summary: { installed: 0, changed: 0, skipped: 1, failed: 1 },
  items: [
    memberNoop,
    {
      ...memberFailed,
      error: { code: 'UNMANAGED_CONFLICT', message: 'The target directory already exists.' },
    },
  ],
};

// Minimal registry entry mirroring src/utils/agent-dirs.ts for agent-pick mocks.
const openCodeAgent = {
  name: 'opencode',
  displayName: 'OpenCode',
  projectDir: '.agents/skills',
  globalDir: '.config/opencode/skills',
};

function stubPack(result: PackInstallResult, calls?: Array<Record<string, unknown>>) {
  holder.services = makeMockServices({
    skillsPackService: {
      installPack: async (opts: Record<string, unknown>) => {
        calls?.push(opts);
        return result;
      },
    },
  });
}

function stubPackError(error: unknown) {
  holder.services = makeMockServices({
    skillsPackService: {
      installPack: async () => {
        throw error;
      },
    },
  });
}

/** Capture process.exitCode for paths that set it without throwing. */
async function runCapturingExitCode(argv: string[]) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const r = await runCommand(build, argv);
  const finalExit = process.exitCode;
  process.exitCode = prev;
  return { ...r, finalExit };
}

/** First output line containing the needle (B2: row-level co-occurrence). */
function lineOf(output: string, needle: string): string {
  return output.split('\n').find((line) => line.includes(needle)) ?? '';
}

// ── §4.1 Registration and arguments ─────────────────────────────────────────

describe('skills pack-install — registration and arguments', () => {
  it('advertises pack-install examples including a --dir variant', () => {
    const program = new Command();
    const skills = program.command('skills');
    const packInstall = registerSkillsPackInstallCommand(skills);
    const examples = getCommandExamples(packInstall);
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.some((e) => e.includes('skills pack-install'))).toBe(true);
    expect(examples.some((e) => e.includes('--dir'))).toBe(true);
  });

  it('missing pack-name → commander error, action never runs', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const r = await runCommand(build, ['skills', 'pack-install']);
    expect(r.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  const INVALID_PACK_NAMES = ['@ns/pack', 'ns/pack', 'has space', ''];

  it.each(INVALID_PACK_NAMES)(
    'rejects invalid pack name %j with INVALID_SLUG (json, exit 1) before any service call',
    async (bad) => {
      const calls: Array<Record<string, unknown>> = [];
      stubPack(successResult, calls);
      const r = await runCommand(build, ['skills', 'pack-install', bad, '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stderr)).toEqual({
        error: {
          code: 'INVALID_SLUG',
          message: `Invalid pack name: ${bad}.`,
          exit_code: 1,
        },
      });
      expect(r.stdout).toBe('');
      expect(calls).toHaveLength(0);
    },
  );

  it('keeps the exact plain wording on stderr in text format (exit 1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      '@ns/pack',
      '--format',
      'text',
    ]);
    expect(r.finalExit).toBe(1);
    expect(r.stderr.trim()).toBe('Invalid pack name: @ns/pack.');
    expect(r.stderr).not.toContain('\u001b[');
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it.each(['qwen-pack', 'my_pack-2', 'Packs01'])('accepts bare pack name %j', async (name) => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const r = await runCommand(build, ['skills', 'pack-install', name, '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ packName: name });
  });
});

// ── §4.2 baseDir resolution ─────────────────────────────────────────────────

describe('skills pack-install — baseDir resolution', () => {
  it('passes an existing writable --dir through as baseDir verbatim with implicit confirm', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const explicitDir = path.join(workDir, 'my-skills');
    mkdirSync(explicitDir, { recursive: true });
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(calls[0]).toMatchObject({ packName: PACK, baseDir: explicitDir });
    expect(typeof calls[0]?.onConfirm).toBe('function');
    expect(promptAgentDirMock).not.toHaveBeenCalled();
  });

  it('announces the explicit directory in table mode only', async () => {
    stubPack(successResult);
    const explicitDir = path.join(workDir, 'my-skills');
    mkdirSync(explicitDir, { recursive: true });
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Using explicit installation directory');
  });

  it('table + no --dir prompts for the agent directory exactly once and uses the selection', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const selectedDir = path.join(workDir, '.agents', 'skills');
    promptAgentDirMock.mockResolvedValue({ path: selectedDir, agent: openCodeAgent });
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(promptAgentDirMock).toHaveBeenCalledTimes(1);
    expect(promptAgentDirMock.mock.calls[0]?.[0]).toBe(process.cwd());
    expect(calls[0]).toMatchObject({ packName: PACK, baseDir: selectedDir });
    expect(existsSync(selectedDir)).toBe(true);
  });

  it('table + no --dir + user cancels the directory prompt → exit 0, no install call', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    promptAgentDirMock.mockResolvedValue(null);
    const r = await runCapturingExitCode(['skills', 'pack-install', PACK, '--format', 'table']);
    expect(r.finalExit).toBe(0);
    expect(r.stderr).toBe('');
    expect(calls).toHaveLength(0);
  });

  it.each(['json', 'text'])(
    '%s + no --dir falls back to cwd with a single-line stderr warning (T-7)',
    async (fmt) => {
      const calls: Array<Record<string, unknown>> = [];
      stubPack(successResult, calls);
      const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', fmt]);
      expect(r.exitCode).toBeUndefined();
      expect(calls[0]).toMatchObject({ baseDir: process.cwd() });
      expect(r.stderr).toContain('The skill pack will be installed into the');
      expect(promptAgentDirMock).not.toHaveBeenCalled();
    },
  );

  it('json stdout stays valid JSON despite the warning (stderr keeps the contract clean)', async () => {
    stubPack(successResult);
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'json']);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout).pack).toBe(PACK);
    expect(JSON.parse(r.stdout).baseDir).toBe('/tmp/skills');
    expect(r.stderr).not.toBe('');
  });

  it('table + no --dir in a recognized agent dir installs into cwd without prompting', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    isRecognizedAgentDirMock.mockReturnValue(true);
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(promptAgentDirMock).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ baseDir: process.cwd() });
  });
});

// ── §4.3 baseDir preflight (terminal, exit 1) ──────────────────────────────

describe('skills pack-install — --dir preflight validation', () => {
  it('--dir does not exist → INSTALL_DIR_NOT_FOUND (json structured, exit 1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const missingDir = path.join(workDir, 'does-not-exist');
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      missingDir,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'INSTALL_DIR_NOT_FOUND',
        message:
          `Installation failed: target directory does not exist: ${missingDir}. ` +
          'Please provide an existing writable directory and rerun the command.',
        exit_code: 1,
      },
    });
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('--dir points at a file → INSTALL_DIR_NOT_FOUND (same handling)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const filePath = path.join(workDir, 'a-file');
    writeFileSync(filePath, 'not a directory');
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      filePath,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe('INSTALL_DIR_NOT_FOUND');
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('--dir exists but is read-only → INSTALL_DIR_NOT_WRITABLE (exit 1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const readonlyDir = path.join(workDir, 'readonly');
    mkdirSync(readonlyDir, { recursive: true });
    chmodSync(readonlyDir, 0o555);
    try {
      const r = await runCommand(build, [
        'skills',
        'pack-install',
        PACK,
        '--dir',
        readonlyDir,
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stderr)).toEqual({
        error: {
          code: 'INSTALL_DIR_NOT_WRITABLE',
          message:
            `Installation failed: no permission to write to the target directory: ${readonlyDir}. ` +
            'Please provide an existing writable directory or update its permissions, then rerun the command.',
          exit_code: 1,
        },
      });
      expect(r.stdout).toBe('');
      expect(calls).toHaveLength(0);
    } finally {
      chmodSync(readonlyDir, 0o755);
    }
  });

  it('--dir is the filesystem root → ROOT_DIR_NOT_ALLOWED (exit 1, exact message)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      path.parse(workDir).root,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'ROOT_DIR_NOT_ALLOWED',
        message:
          'The installation base directory cannot be the filesystem root. Choose a Skills directory.',
        exit_code: 1,
      },
    });
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('--dir symlink pointing to root → ROOT_DIR_NOT_ALLOWED via realpath (exit 1)', async () => {
    const { symlinkSync } = await import('node:fs');
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    const linkPath = path.join(workDir, 'link-to-root');
    symlinkSync(path.parse(workDir).root, linkPath);
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      linkPath,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe('ROOT_DIR_NOT_ALLOWED');
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });
});

// ── §4.4 Tri-format output contract ────────────────────────────────────────

describe('skills pack-install — JSON output contract', () => {
  it('emits the full five-field contract on stdout', async () => {
    stubPack(fourMemberResult);
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({
      pack: PACK,
      overallStatus: 'partial',
      baseDir: '/tmp/skills',
      summary: { installed: 1, changed: 1, skipped: 1, failed: 1 },
      items: [
        {
          slug: '@qianwen-ai/skill-a',
          status: 'installed',
          version: '1.2.0',
          targetDir: '/tmp/skills/skill-a',
        },
        {
          slug: '@qianwen-ai/skill-b',
          status: 'changed',
          version: '1.2.0',
          previousVersion: '1.1.0',
          targetDir: '/tmp/skills/skill-b',
        },
        { slug: '@other-ns/skill-c', status: 'noop', version: '0.9.0' },
        {
          slug: '@qianwen-ai/skill-d',
          status: 'failed',
          error: {
            code: 'DOWNLOAD_FAILED',
            message: 'Skill package download failed. Check your network and try again.',
          },
        },
      ],
    });
  });

  it('keeps stderr empty and exit 0 on the success path', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(successResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.stderr).toBe('');
    expect(r.finalExit ?? 0).toBe(0);
  });

  it('includes previousSlug and previousVersion for override items', async () => {
    const overrideResult: PackInstallResult = {
      pack: PACK,
      displayName: 'Qianwen Official Pack',
      overallStatus: 'success',
      baseDir: '/tmp/skills',
      summary: { installed: 0, changed: 1, skipped: 0, failed: 0 },
      items: [memberOverride],
    };
    stubPack(overrideResult);
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.items[0]).toEqual({
      slug: '@qianwen-ai/skill-b',
      status: 'changed',
      version: '1.2.0',
      overwritten: true,
      previousSlug: '@other-ns/old-skill',
      previousVersion: '0.5.0',
      targetDir: '/tmp/skills/skill-b',
    });
  });
});

describe('skills pack-install — text output contract', () => {
  it('renders ANSI-free per-member rows (B2: row-level co-occurrence, no space locking)', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'text',
    ]);
    expect(r.stdout).not.toContain('\u001b[');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-a')).toContain('\u2713');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-a')).toContain('installed');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-a')).toContain('v1.2.0');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-b')).toContain('~');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-b')).toContain('changed');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-b')).toContain('v1.1.0 \u2192 v1.2.0');
    expect(lineOf(r.stdout, '@other-ns/skill-c')).toContain('=');
    expect(lineOf(r.stdout, '@other-ns/skill-c')).toContain('noop');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-d')).toContain('\u2717');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-d')).toContain('failed');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-d')).toContain('[DOWNLOAD_FAILED]');
    expect(lineOf(r.stdout, '@qianwen-ai/skill-d')).toContain(
      'Skill package download failed. Check your network and try again.',
    );
  });

  it('renders the summary block with pack/mode/location/counters/status fields', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'text',
    ]);
    expect(r.stdout).toContain('Pack');
    expect(r.stdout).toContain(PACK);
    expect(r.stdout).toContain('Mode');
    expect(r.stdout).toContain('Explicit directory (--dir)');
    expect(r.stdout).toContain('Location');
    expect(r.stdout).toContain('/tmp/skills');
    expect(r.stdout).toContain('Installed');
    expect(r.stdout).toContain('Changed');
    expect(r.stdout).toContain('Skipped');
    expect(r.stdout).toContain('Failed');
    expect(r.stdout).toContain('Status');
    expect(r.stdout).toContain('Completed with failures');
  });

  it('noop + failed early-return path does not say "installed" in text output', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(noopPlusFailedResult);
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'text',
    ]);
    expect(r.stdout).toContain('No skills were installed');
    expect(r.stdout).not.toContain('installed with some failures');
    expect(r.stdout).toContain('No skills were installed');
  });

  it('renders override note for overridden members in text output', async () => {
    const overrideResult: PackInstallResult = {
      pack: PACK,
      displayName: 'Qianwen Official Pack',
      overallStatus: 'success',
      baseDir: '/tmp/skills',
      summary: { installed: 0, changed: 1, skipped: 0, failed: 0 },
      items: [memberOverride],
    };
    stubPack(overrideResult);
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'text']);
    expect(r.stdout).toContain('override: Replaced @other-ns/old-skill v0.5.0');
  });
});

describe('skills pack-install — table output contract', () => {
  it('renders the summary through Ink exactly once with title, rows and fields', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    const frame = renderedFrames[0] ?? '';
    expect(frame).toContain('Skill pack installed with some failures');
    // showItems=false in table mode: per-member rows are printed during
    // onProgress, so the Ink summary no longer repeats them.
    expect(frame).not.toContain('@qianwen-ai/skill-a');
    expect(frame).toContain('Pack');
    expect(frame).toContain('Installed');
    expect(frame).toContain('Failed');
    expect(frame).toContain('Status');
    // B5: the signed OSS URL must never leak into any rendered frame.
    expect(frame).not.toContain('oss.test.qianwenai.com');
    expect(frame).not.toContain('Signature=');
  });

  it('failed rows render in the ✗ slug failed [CODE] message shape in the frame (B8)', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    const frame = renderedFrames[0] ?? '';
    const failedLine = frame.split('\n').find((l) => l.includes('@qianwen-ai/skill-d')) ?? '';
    expect(failedLine).toContain('\u2717');
    expect(failedLine).toContain('failed');
    expect(failedLine).toContain('[DOWNLOAD_FAILED]');
  });

  it('all-success result shows ✓ Skill pack installed successfully and exits 0', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(successResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(renderedFrames[0] ?? '').toContain('\u2713 Skill pack installed successfully');
    expect(r.finalExit ?? 0).toBe(0);
  });

  it('all-noop result shows the nothing-to-do title and skips the review page', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(allNoopResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(renderedFrames[0] ?? '').toContain(
      '\u2713 Skill pack already installed \u2014 nothing to do',
    );
    expect(r.finalExit ?? 0).toBe(0);
    expect(renderedFrames.join('\n')).not.toContain('Review planned changes');
  });

  it('partial failure shows the ⚠ title and sets a non-zero exit code', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(renderedFrames[0] ?? '').toContain('\u26a0 Skill pack installed with some failures');
    expect(r.finalExit).toBe(1);
  });

  it('total failure shows the ✗ title and exits 1', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(allFailedResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(renderedFrames[0] ?? '').toContain('\u2717 Skill pack installation failed');
    expect(r.finalExit).toBe(1);
  });

  it('streams per-member progress lines matching the summary row format', async () => {
    holder.services = makeMockServices({
      skillsPackService: {
        installPack: async (opts: Record<string, unknown>) => {
          const onProgress = opts.onProgress as
            | ((item: unknown, index: number, total: number) => void)
            | undefined;
          onProgress?.(memberInstalled, 0, 2);
          onProgress?.(memberFailed, 1, 2);
          return fourMemberResult;
        },
      },
    });
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    // Same icon/slug/outcome/version shape as the final summary rows (colors
    // are TTY-only via chalk and disabled under the test runner).
    expect(r.stdout).toContain('\u2713 @qianwen-ai/skill-a  installed  v1.2.0');
    expect(r.stdout).toContain('\u2717 @qianwen-ai/skill-d  failed  [DOWNLOAD_FAILED]');
  });
});

// ── §4.5 Confirmation injection (table mode) ────────────────────────────────

describe('skills pack-install — confirmation injection', () => {
  it('table + no --dir injects an interactive onConfirm rendering the review page (B10)', async () => {
    holder.services = makeMockServices({
      skillsPackService: {
        installPack: async (opts: Record<string, unknown>) => {
          const confirm = opts.onConfirm as (plan: unknown) => Promise<boolean>;
          await confirm({ install: 2, change: 0, noop: 1, failed: 0 });
          return successResult;
        },
      },
    });
    // cwd counts as a recognized agent dir (default mock) → interactive path.
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    const frame = renderedFrames.find((f) => f.includes('Review planned changes')) ?? '';
    expect(frame).toContain('Review planned changes');
    expect(frame).toContain('Install');
    expect(frame).toContain('Change');
    expect(frame).toContain('No change');
    expect(frame).toContain('Proceed? (Y/n)');
    expect(frame).toContain('2');
    expect(frame).toContain('1');
    // The spinner must be paused before the confirmation page renders and
    // resumed after it closes — order enforced via invocationCallOrder.
    expect(spinnerPauseSpy).toHaveBeenCalledTimes(1);
    expect(spinnerResumeSpy).toHaveBeenCalledTimes(1);
    expect(spinnerPauseSpy.mock.invocationCallOrder[0]).toBeLessThan(
      renderWithInkSpy.mock.invocationCallOrder[0],
    );
    expect(spinnerResumeSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      renderWithInkSpy.mock.invocationCallOrder[0],
    );
  });

  it('review page shows Failed (precheck) row when plan has failed members', async () => {
    holder.services = makeMockServices({
      skillsPackService: {
        installPack: async (opts: Record<string, unknown>) => {
          const confirm = opts.onConfirm as (plan: unknown) => Promise<boolean>;
          await confirm({ install: 1, change: 0, noop: 1, failed: 2 });
          return fourMemberResult;
        },
      },
    });
    await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
    const frame = renderedFrames.find((f) => f.includes('Review planned changes')) ?? '';
    expect(frame).toContain('Failed (precheck)');
    expect(frame).toContain('2');
  });

  it('--dir mode injects onConfirm resolving true without any extra render (T-8)', async () => {
    const confirmResults: boolean[] = [];
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    holder.services = makeMockServices({
      skillsPackService: {
        installPack: async (opts: Record<string, unknown>) => {
          const confirm = opts.onConfirm as (plan: unknown) => Promise<boolean>;
          confirmResults.push(await confirm({ install: 2, change: 0, noop: 1, failed: 0 }));
          return successResult;
        },
      },
    });
    await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(confirmResults).toEqual([true]);
    // Exactly one Ink render — the final summary; the confirm callback must not
    // have opened the interactive review page.
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    expect(renderedFrames.join('\n')).not.toContain('Review planned changes');
  });

  it('json mode never renders Ink and injects the implicit confirm', async () => {
    const confirmResults: boolean[] = [];
    holder.services = makeMockServices({
      skillsPackService: {
        installPack: async (opts: Record<string, unknown>) => {
          const confirm = opts.onConfirm as (plan: unknown) => Promise<boolean>;
          confirmResults.push(await confirm({ install: 1, change: 0, noop: 0, failed: 0 }));
          return successResult;
        },
      },
    });
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(confirmResults).toEqual([true]);
    expect(renderWithInkSpy).not.toHaveBeenCalled();
  });
});

// ── §4.6 Terminal error propagation ────────────────────────────────────────

describe('skills pack-install — terminal error propagation', () => {
  it('PACK_NOT_FOUND → exit 1 with structured JSON on stderr, empty stdout', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPackError(
      new CliError({
        code: 'PACK_NOT_FOUND',
        message: `Skill pack not found: ${PACK}.`,
        exitCode: 1,
      }),
    );
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'PACK_NOT_FOUND',
        message: `Skill pack not found: ${PACK}.`,
        exit_code: 1,
      },
    });
    expect(r.stdout).toBe('');
  });

  it('PACK_EMPTY → exit 1 with the pack-empty message', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPackError(
      new CliError({
        code: 'PACK_EMPTY',
        message: `Skill pack is empty: ${PACK}.`,
        exitCode: 1,
      }),
    );
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).error).toMatchObject({
      code: 'PACK_EMPTY',
      message: `Skill pack is empty: ${PACK}.`,
    });
  });

  it('PACK_NOT_FOUND in text mode → plain stderr, no ANSI', async () => {
    stubPackError(
      new CliError({
        code: 'PACK_NOT_FOUND',
        message: `Skill pack not found: ${PACK}.`,
        exitCode: 1,
      }),
    );
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'text']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`Skill pack not found: ${PACK}.`);
    expect(r.stderr).not.toContain('\u001b[');
  });
});

// ── §4.7 Member failures and exit codes ────────────────────────────────────

describe('skills pack-install — member failures and exit codes', () => {
  it('partial failure sets process.exitCode = 1', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.finalExit).toBe(1);
    expect(JSON.parse(r.stdout).summary.failed).toBe(1);
  });

  it('full success keeps the exit code at the 0 semantics', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(successResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.finalExit ?? 0).toBe(0);
  });

  it('all-noop keeps the exit code at the 0 semantics', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(allNoopResult);
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.finalExit ?? 0).toBe(0);
  });

  it('USER_CANCELLED → exit 0 with a single friendly line, no error structure (T-3/B3)', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPackError(
      new CliError({
        code: 'USER_CANCELLED',
        message: 'Installation cancelled by user.',
        exitCode: 0,
      }),
    );
    const r = await runCapturingExitCode([
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(r.finalExit).toBe(0);
    // B3: stderr carries no error structure — a single 'Cancelled.' line is
    // the accepted friendly form.
    expect(r.stderr.trim()).toBe('Cancelled.');
    expect(r.stderr).not.toContain('"error"');
    expect(r.stdout).toBe('');
  });
});

// ── §4.8 Signed URL non-disclosure (command layer) ──────────────────────────

describe('skills pack-install — signed URL non-disclosure', () => {
  it('json output never mentions the OSS host, OssUrl key or signature', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain('oss.test.qianwenai.com');
    expect(combined).not.toContain('OssUrl');
    expect(combined).not.toContain('Signature=');
  });

  it('text output never mentions the OSS host, OssUrl key or signature', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    stubPack(fourMemberResult);
    const r = await runCommand(build, [
      'skills',
      'pack-install',
      PACK,
      '--dir',
      explicitDir,
      '--format',
      'text',
    ]);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain('oss.test.qianwenai.com');
    expect(combined).not.toContain('OssUrl');
    expect(combined).not.toContain('Signature=');
  });

  it('terminal error output never mentions the OSS host, OssUrl key or signature', async () => {
    stubPackError(
      new CliError({
        code: 'PACK_NOT_FOUND',
        message: `Skill pack not found: ${PACK}.`,
        exitCode: 1,
      }),
    );
    const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'json']);
    expect(r.stderr).not.toContain('oss.test.qianwenai.com');
    expect(r.stderr).not.toContain('OssUrl');
    expect(r.stderr).not.toContain('Signature=');
  });
});

// ── §4.9 stdin non-TTY bypass ────────────────────────────────────────────

describe('skills pack-install — stdin non-TTY bypass', () => {
  it('table mode falls back to cwd with stderr warning when stdin is not a TTY', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const originalIsTTY = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(promptAgentDirMock).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({ packName: PACK, baseDir: process.cwd() });
      expect(r.stderr).toContain('The skill pack will be installed into the');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('table mode with stdout TTY but stdin non-TTY still uses cwd without prompting', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubPack(successResult, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const r = await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(promptAgentDirMock).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({ packName: PACK, baseDir: process.cwd() });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutTTY,
        configurable: true,
      });
    }
  });
});

// ── §4.10 Confirmation page paste input normalization ────────────────

describe('skills pack-install — confirmation page paste normalization', () => {
  it('accepts "y\\r" paste input as confirmation (normalized to "y")', async () => {
    let confirmResult = false;
    holder.services = makeMockServices({
      skillsPackService: {
        installPack: async (opts: Record<string, unknown>) => {
          const confirm = opts.onConfirm as (plan: unknown) => Promise<boolean>;
          confirmResult = await confirm({ install: 2, change: 0, noop: 0, failed: 0 });
          return successResult;
        },
      },
    });
    // Capture the useInput handler registered by PackInstallConfirm
    useInputSpy.mockImplementation(
      (handler: (input: string, key: Record<string, boolean>) => void) => {
        // Simulate paste: "y\r" arrives as a single chunk
        handler('y\r', { return: false, escape: false, ctrl: false });
      },
    );
    await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
    expect(confirmResult).toBe(true);
  });

  it('accepts "Y\\r\\n" paste input as confirmation (normalized to "Y")', async () => {
    let confirmResult = false;
    holder.services = makeMockServices({
      skillsPackService: {
        installPack: async (opts: Record<string, unknown>) => {
          const confirm = opts.onConfirm as (plan: unknown) => Promise<boolean>;
          confirmResult = await confirm({ install: 1, change: 0, noop: 0, failed: 0 });
          return successResult;
        },
      },
    });
    useInputSpy.mockImplementation(
      (handler: (input: string, key: Record<string, boolean>) => void) => {
        handler('Y\r\n', { return: false, escape: false, ctrl: false });
      },
    );
    await runCommand(build, ['skills', 'pack-install', PACK, '--format', 'table']);
    expect(confirmResult).toBe(true);
  });
});
