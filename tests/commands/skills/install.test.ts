/**
 * Tests for `skills install` — behavior contract coverage:
 * slug validation (exit 1, structured JSON in json / exact wording in text),
 * --dir preflight (existing writable directory, exit 1 on failure) and
 * pass-through, JSON shape { slug, version, outcome, targetDir, security,
 * sha256 }, tri-state rendering, mode/status summary rows, anonymous usage,
 * and the README exit-code contract (2 = auth, 3 = network/API,
 * 1 = install/conflict failures).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SkillsInstallResult } from '../../../src/types/skills.js';
import type { AgentDirSelection } from '../../../src/ui/AgentDirPrompt.js';
import { CliError } from '../../../src/utils/errors.js';
import {
  renderInkForTest,
  clearRenderedFrames,
  lastRenderedFrame,
} from '../../helpers/ink-render-mock.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };
let workDir: string;
let prevCwd: string;

const { renderWithInkSpy, isRecognizedAgentDirMock, promptAgentDirMock } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
  isRecognizedAgentDirMock: vi.fn<(resolvedPath: string) => boolean>(),
  promptAgentDirMock:
    vi.fn<
      (defaultPath: string, agents: unknown[], slug: string) => Promise<AgentDirSelection | null>
    >(),
}));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
// Hard no-credentials environment: install must work while logged out
// (anonymous download contract) — any auth gate on the path throws loudly.
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

import { registerSkillsInstallCommand } from '../../../src/commands/skills/install.js';

function build(program: import('commander').Command) {
  const skills = program.command('skills');
  registerSkillsInstallCommand(skills);
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
  // Default: the target counts as a recognized Agent dir so pre-existing
  // cases keep their original prompt-free flow; detection cases override it.
  isRecognizedAgentDirMock.mockReset();
  isRecognizedAgentDirMock.mockReturnValue(true);
  promptAgentDirMock.mockReset();
  promptAgentDirMock.mockResolvedValue(null);
  // Run every case from a throwaway cwd: invocations without --dir install
  // straight into the current directory and must never touch the repository
  // working tree.
  prevCwd = process.cwd();
  workDir = mkdtempSync(path.join(tmpdir(), 'qianwen-install-cmd-'));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(workDir, { recursive: true, force: true });
});

const sample: SkillsInstallResult = {
  slug: 'pdf-extractor',
  version: '1.2.0',
  outcome: 'installed',
  targetDir: '/tmp/skills/pdf-extractor',
  securityStatus: 'safe',
  securityLabel: 'safe',
  sha256: 'a'.repeat(64),
};

// Minimal registry entry mirroring src/utils/agent-dirs.ts for agent-pick mocks.
const openCodeAgent = {
  name: 'opencode',
  displayName: 'OpenCode',
  projectDir: '.agents/skills',
  globalDir: '.config/opencode/skills',
};

const sampleDetail = {
  slug: 'pdf-extractor',
  displayName: 'PDF Extractor',
  description: 'Extracts text from PDFs',
  securityStatus: 'safe',
  auditStatus: 'PASSED',
  auditTime: '2026-01-01T00:00:00Z',
  latestVersion: '1.2.0',
  versions: [],
};

function stubInstall(result: SkillsInstallResult, calls?: Array<Record<string, unknown>>) {
  holder.services = makeMockServices({
    skillsHubService: {
      getSkillDetail: async () => sampleDetail,
    },
    skillsInstallService: {
      install: async (opts: Record<string, unknown>) => {
        calls?.push(opts);
        return result;
      },
    },
  });
}

function stubInstallError(error: unknown) {
  holder.services = makeMockServices({
    skillsHubService: {
      getSkillDetail: async () => sampleDetail,
    },
    skillsInstallService: {
      install: async () => {
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

// ANSI CSI stripper built via the constructor so no control character
// appears in a regex literal (no-control-regex).
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_PATTERN, '');

describe('skills install — slug validation (exit 1)', () => {
  // '-leading' is intentionally absent: commander intercepts it as an
  // unknown option before the action-level slug validation runs.
  it.each(['../evil', 'has space', '_leading', 'trailing-', 'dot.name', 'a'.repeat(65)])(
    'rejects invalid slug %s with structured JSON before any service call',
    async (bad) => {
      const calls: Array<Record<string, unknown>> = [];
      stubInstall(sample, calls);
      const r = await runCommand(build, ['skills', 'install', bad, '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stderr)).toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message:
            'Invalid skill name: must be 1-64 characters of letters, digits, ' +
            'hyphens or underscores, starting and ending with a letter or digit.',
          exit_code: 1,
        },
      });
      expect(r.stdout).toBe('');
      expect(calls).toHaveLength(0);
    },
  );

  it('keeps the exact plain wording on stderr in text format (exit 1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const r = await runCapturingExitCode(['skills', 'install', '../evil', '--format', 'text']);
    expect(r.finalExit).toBe(1);
    expect(r.stderr.trim()).toBe(
      'Invalid skill name: must be 1-64 characters of letters, digits, ' +
        'hyphens or underscores, starting and ending with a letter or digit.',
    );
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('accepts a single-character slug', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const r = await runCommand(build, ['skills', 'install', 'a', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('skills install — service call contract', () => {
  it('defaults baseDir to the current working directory without creating anything', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(calls[0]).toEqual({ slug: 'pdf-extractor', baseDir: process.cwd() });
    expect(existsSync(path.join(process.cwd(), 'skills'))).toBe(false);
  });

  it('passes an existing writable --dir through as baseDir verbatim', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const explicitDir = path.join(workDir, 'my-skills');
    mkdirSync(explicitDir, { recursive: true });
    await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      explicitDir,
      '--format',
      'json',
    ]);
    expect(calls[0]).toEqual({ slug: 'pdf-extractor', baseDir: explicitDir });
  });
});

describe('skills install — JSON output contract', () => {
  it('emits { slug, version, outcome, targetDir, security, sha256 } on stdout only', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({
      slug: 'pdf-extractor',
      version: '1.2.0',
      outcome: 'installed',
      targetDir: '/tmp/skills/pdf-extractor',
      security: 'safe',
      sha256: 'a'.repeat(64),
    });
  });

  it('reports a noop outcome verbatim', async () => {
    stubInstall({ ...sample, outcome: 'noop' });
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(JSON.parse(r.stdout).outcome).toBe('noop');
  });

  it('includes the structured downgrade field when the service reports one', async () => {
    stubInstall({
      ...sample,
      outcome: 'updated',
      version: '0.0.1',
      downgrade: { from: '0.0.2', to: '0.0.1' },
    });
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({
      slug: 'pdf-extractor',
      version: '0.0.1',
      outcome: 'updated',
      targetDir: '/tmp/skills/pdf-extractor',
      security: 'safe',
      sha256: 'a'.repeat(64),
      downgrade: { from: '0.0.2', to: '0.0.1' },
    });
  });
});

describe('skills install — rendering modes', () => {
  it('text mode renders without invoking Ink', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).not.toHaveBeenCalled();
    expect(r.stdout).toContain('pdf-extractor');
    expect(r.stdout).toContain('status: Installed');
  });

  it('table mode renders through Ink once', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});

describe('skills install — downgrade warning rendering', () => {
  const downgraded: SkillsInstallResult = {
    ...sample,
    outcome: 'updated',
    version: '0.0.1',
    downgrade: { from: '0.0.2', to: '0.0.1' },
  };
  const warningLine =
    'warning: downgraded from 0.0.2 to 0.0.1 (local version was newer than the hub release)';

  it('text mode appends a single warning line', async () => {
    stubInstall(downgraded);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain(`  ${warningLine}`);
  });

  it('text mode prints no warning line without a downgrade', async () => {
    stubInstall({ ...sample, outcome: 'updated' });
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'text']);
    expect(r.stdout).not.toContain('warning:');
  });

  it('table mode surfaces the warning in the Ink frame', async () => {
    stubInstall(downgraded);
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame()).toContain(warningLine);
  });

  it('table mode omits the warning without a downgrade', async () => {
    stubInstall({ ...sample, outcome: 'updated' });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame()).not.toContain('warning:');
  });
});

describe('skills install — anonymous usage', () => {
  it('succeeds in a fully credential-less environment — no auth gate', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).not.toContain('Not authenticated');
    expect(JSON.parse(r.stdout).slug).toBe('pdf-extractor');
  });
});

describe('skills install — exit codes', () => {
  it('keeps an unmanaged-directory conflict at exit 1 with the exact code', async () => {
    stubInstallError(
      new CliError({
        code: 'UNMANAGED_CONFLICT',
        message:
          "A directory named 'pdf-extractor' already exists at '/tmp/x' but is not managed " +
          'by this CLI (missing or invalid .qianwen-skill.json). No changes were made.',
        exitCode: 1,
      }),
    );
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('UNMANAGED_CONFLICT');
    expect(payload.error.message).toContain('No changes were made.');
    expect(r.stdout).toBe('');
  });

  it('keeps a download failure at exit 1', async () => {
    stubInstallError(
      new CliError({
        code: 'DOWNLOAD_FAILED',
        message: 'Skill package download failed (HTTP 500).',
        exitCode: 1,
      }),
    );
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe('DOWNLOAD_FAILED');
  });

  it('remaps a NOT_FOUND CliError to exit 3', async () => {
    stubInstallError(
      new CliError({ code: 'NOT_FOUND', message: 'Skill not found: ghost.', exitCode: 7 }),
    );
    const r = await runCommand(build, ['skills', 'install', 'ghost', '--format', 'json']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stderr).error.code).toBe('NOT_FOUND');
  });

  it('maps server-side auth rejection (HTTP 401) to exit 2', async () => {
    stubInstallError(new Error('HTTP 401: Unauthorized'));
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe('AUTH_REQUIRED');
  });

  it('maps network failures to exit 3', async () => {
    stubInstallError(new Error('fetch failed: ECONNREFUSED 127.0.0.1'));
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stderr).error.code).toBe('NETWORK_ERROR');
  });
});

describe('agent directory detection', () => {
  it('table 模式检测非 Agent 目录时触发 agent 选择提示并使用所选目录', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const selectedDir = path.join(workDir, '.agents', 'skills');
    isRecognizedAgentDirMock.mockReturnValue(false);
    promptAgentDirMock.mockResolvedValue({ path: selectedDir, agent: openCodeAgent });
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    const defaultDir = process.cwd();
    expect(isRecognizedAgentDirMock).toHaveBeenCalledWith(defaultDir);
    expect(promptAgentDirMock).toHaveBeenCalledTimes(1);
    expect(promptAgentDirMock.mock.calls[0]?.[0]).toBe(defaultDir);
    expect(Array.isArray(promptAgentDirMock.mock.calls[0]?.[1])).toBe(true);
    expect(promptAgentDirMock.mock.calls[0]?.[2]).toBe('pdf-extractor');
    expect(calls[0]).toMatchObject({ slug: 'pdf-extractor', baseDir: selectedDir });
    expect(calls[0]).toHaveProperty('preloadedDetail');
    expect(existsSync(selectedDir)).toBe(true);
  });

  it('用户选择继续当前目录时安装到 cwd 且不创建子目录', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    promptAgentDirMock.mockResolvedValue({ path: process.cwd() });
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(calls[0]).toMatchObject({ slug: 'pdf-extractor', baseDir: process.cwd() });
    expect(calls[0]).toHaveProperty('preloadedDetail');
    expect(existsSync(path.join(process.cwd(), 'skills'))).toBe(false);
  });

  it('json/text 模式不触发 agent 选择提示', async () => {
    isRecognizedAgentDirMock.mockReturnValue(false);
    for (const fmt of ['json', 'text']) {
      const calls: Array<Record<string, unknown>> = [];
      stubInstall(sample, calls);
      const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', fmt]);
      expect(r.exitCode).toBeUndefined();
      expect(calls[0]).toEqual({
        slug: 'pdf-extractor',
        baseDir: process.cwd(),
      });
    }
    expect(promptAgentDirMock).not.toHaveBeenCalled();
  });

  it('--dir 显式指定时跳过 agent 检测', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const explicitDir = path.join(workDir, 'my-skills');
    mkdirSync(explicitDir, { recursive: true });
    const r = await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(isRecognizedAgentDirMock).not.toHaveBeenCalled();
    expect(promptAgentDirMock).not.toHaveBeenCalled();
    expect(calls[0]).toEqual({ slug: 'pdf-extractor', baseDir: explicitDir });
  });

  it('当前目录已是已知 Agent 目录时不触发提示', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    isRecognizedAgentDirMock.mockReturnValue(true);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(isRecognizedAgentDirMock).toHaveBeenCalledWith(process.cwd());
    expect(promptAgentDirMock).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ slug: 'pdf-extractor', baseDir: process.cwd() });
    expect(calls[0]).toHaveProperty('preloadedDetail');
  });

  it('用户取消选择时正常退出且不调用安装服务', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    promptAgentDirMock.mockResolvedValue(null);
    const r = await runCapturingExitCode([
      'skills',
      'install',
      'pdf-extractor',
      '--format',
      'table',
    ]);
    expect(r.finalExit).toBe(0);
    expect(r.stderr).toBe('');
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(process.cwd(), 'skills'))).toBe(false);
  });

  it('rejects a non-existent slug before entering the directory prompt (table mode, exit 3)', async () => {
    const installCalls: Array<Record<string, unknown>> = [];
    holder.services = makeMockServices({
      skillsHubService: {
        getSkillDetail: async () => {
          throw new CliError({
            code: 'NOT_FOUND',
            message: 'Skill not found: ghost.',
            exitCode: 3,
          });
        },
      },
      skillsInstallService: {
        install: async (opts: Record<string, unknown>) => {
          installCalls.push(opts);
          return sample;
        },
      },
    });
    isRecognizedAgentDirMock.mockReturnValue(false);
    promptAgentDirMock.mockResolvedValue(null);
    const r = await runCommand(build, ['skills', 'install', 'ghost', '--format', 'table']);
    // Must fail before the prompt is shown and before install is called.
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('Skill not found: ghost.');
    expect(promptAgentDirMock).not.toHaveBeenCalled();
    expect(installCalls).toHaveLength(0);
  });
});

describe('skills install — --dir preflight validation', () => {
  it('--dir 指向不存在路径时 text 格式以 exit 1 拒绝（纯文本无 ANSI，安装服务不被调用）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const missingDir = path.join(workDir, 'does-not-exist');
    const r = await runCapturingExitCode([
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      missingDir,
      '--format',
      'text',
    ]);
    expect(r.finalExit).toBe(1);
    expect(r.stderr).toBe(
      `\u2717 Installation failed: target directory does not exist: ${missingDir}.\n\n` +
        'Please provide an existing writable directory and rerun the command.\n',
    );
    expect(r.stderr).not.toContain('\u001b[');
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('--dir 指向不存在路径时 json 格式输出结构化错误（exit 1，安装服务不被调用）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const missingDir = path.join(workDir, 'does-not-exist');
    const r = await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
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

  it('--dir 指向不存在路径时 table 格式 \u2717 以基础红色标红（含 ANSI，文案不变）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const missingDir = path.join(workDir, 'does-not-exist');
    const r = await runCapturingExitCode([
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      missingDir,
      '--format',
      'table',
    ]);
    expect(r.finalExit).toBe(1);
    expect(r.stderr).toContain('\u2717');
    // Basic 16-color red (\x1b[31m): truecolor 38;2 sequences are misparsed
    // as SGR dim by terminals without 24-bit support (e.g. Terminal.app).
    expect(r.stderr).toContain('\u001b[31m\u2717\u001b[39m');
    expect(r.stderr).not.toContain('\u001b[38;2;');
    expect(stripAnsi(r.stderr)).toBe(
      `\u2717 Installation failed: target directory does not exist: ${missingDir}.\n\n` +
        'Please provide an existing writable directory and rerun the command.\n',
    );
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('--dir 指向文件（非目录）时以 exit 1 拒绝并按不存在文案处理（json 结构化）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const filePath = path.join(workDir, 'a-file');
    writeFileSync(filePath, 'not a directory');
    const r = await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      filePath,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'INSTALL_DIR_NOT_FOUND',
        message:
          `Installation failed: target directory does not exist: ${filePath}. ` +
          'Please provide an existing writable directory and rerun the command.',
        exit_code: 1,
      },
    });
    expect(r.stdout).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('--dir 目录存在但无写权限时以 exit 1 拒绝（json 结构化，安装服务不被调用）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const readonlyDir = path.join(workDir, 'readonly');
    mkdirSync(readonlyDir, { recursive: true });
    chmodSync(readonlyDir, 0o555);
    try {
      const r = await runCommand(build, [
        'skills',
        'install',
        'pdf-extractor',
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
      // Restore write permission so afterEach can clean up the temp tree.
      chmodSync(readonlyDir, 0o755);
    }
  });

  it('--dir 目录存在但无写权限时 text 格式保持既有纯文本文案（exit 1）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const readonlyDir = path.join(workDir, 'readonly');
    mkdirSync(readonlyDir, { recursive: true });
    chmodSync(readonlyDir, 0o555);
    try {
      const r = await runCapturingExitCode([
        'skills',
        'install',
        'pdf-extractor',
        '--dir',
        readonlyDir,
        '--format',
        'text',
      ]);
      expect(r.finalExit).toBe(1);
      expect(r.stderr).toBe(
        `\u2717 Installation failed: no permission to write to the target directory: ${readonlyDir}.\n\n` +
          'Please provide an existing writable directory or update its permissions, then rerun the command.\n',
      );
      expect(r.stderr).not.toContain('\u001b[');
      expect(r.stdout).toBe('');
      expect(calls).toHaveLength(0);
    } finally {
      // Restore write permission so afterEach can clean up the temp tree.
      chmodSync(readonlyDir, 0o755);
    }
  });
});

describe('skills install — --dir pre-install banner (table only)', () => {
  it('table 模式在安装前输出显式目录信息块', async () => {
    stubInstall(sample);
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    const r = await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Using explicit installation directory');
    expect(r.stdout).toContain(`Install location: ${path.join(explicitDir, 'pdf-extractor')}`);
  });

  it('json/text 模式不输出该信息块', async () => {
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    for (const fmt of ['json', 'text']) {
      stubInstall(sample);
      const r = await runCommand(build, [
        'skills',
        'install',
        'pdf-extractor',
        '--dir',
        explicitDir,
        '--format',
        fmt,
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).not.toContain('Using explicit installation directory');
    }
  });
});

describe('skills install — summary mode rows (three install modes)', () => {
  it('默认当前目录模式：table 摘要首行为 ✓ Skill installed successfully 且行序为 Skill/Mode/Location/Status（无 Version/Security/SHA256）', async () => {
    stubInstall(sample);
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    const frame = lastRenderedFrame() ?? '';
    expect(frame).toContain('\u2713 Skill installed successfully');
    expect(frame).toContain('Mode');
    expect(frame).toContain('Current directory');
    expect(frame).toContain('Status');
    expect(frame).toContain('Installed');
    // Product-spec V2: exactly four summary rows, detail rows removed.
    expect(frame).not.toContain('Version');
    expect(frame).not.toContain('Security');
    expect(frame).not.toContain('SHA256');
    const idx = (s: string) => frame.indexOf(s);
    expect(idx('\u2713 Skill installed successfully')).toBeLessThan(idx('pdf-extractor'));
    expect(idx('pdf-extractor')).toBeLessThan(idx('Mode'));
    expect(idx('Mode')).toBeLessThan(idx('Location'));
    expect(idx('Location')).toBeLessThan(idx('Status'));
  });

  it('updated 结果：table 摘要首行为 ✓ Skill updated successfully', async () => {
    stubInstall({ ...sample, outcome: 'updated' });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame() ?? '').toContain('\u2713 Skill updated successfully');
  });

  it('noop 结果：table 摘要首行沿用现行文案并统一 ✓ 前缀格式', async () => {
    stubInstall({ ...sample, outcome: 'noop' });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame() ?? '').toContain('\u2713 Already installed \u2014 nothing to do');
  });

  it('选择 Agent 模式：table 摘要含 Agent displayName 与 Ready to use in this project', async () => {
    stubInstall(sample);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const selectedDir = path.join(workDir, '.agents', 'skills');
    promptAgentDirMock.mockResolvedValue({ path: selectedDir, agent: openCodeAgent });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    const frame = lastRenderedFrame() ?? '';
    expect(frame).toContain('\u2713 Skill installed successfully');
    expect(frame).toContain('Agent');
    expect(frame).toContain('OpenCode');
    expect(frame).toContain('Ready to use in this project');
  });

  it('--dir 模式：table 摘要含 Explicit directory (--dir) 与 Status: Installed', async () => {
    stubInstall(sample);
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    const frame = lastRenderedFrame() ?? '';
    expect(frame).toContain('\u2713 Skill installed successfully');
    expect(frame).toContain('Explicit directory (--dir)');
    expect(frame).toContain('Status');
    expect(frame).toContain('Installed');
  });

  it('默认当前目录模式：text 输出首行结果横幅且仅含 skill/mode/location/status 四行明细', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'text']);
    expect(r.stdout).toContain('\u2713 Skill installed successfully');
    expect(r.stdout).not.toContain('\u001b[');
    const idx = (s: string) => r.stdout.indexOf(s);
    expect(idx('skill: pdf-extractor')).toBeLessThan(idx('mode: Current directory'));
    expect(idx('mode: Current directory')).toBeLessThan(idx('location: '));
    expect(idx('location: ')).toBeLessThan(idx('status: Installed'));
    expect(r.stdout).not.toContain('version: ');
    expect(r.stdout).not.toContain('security: ');
    expect(r.stdout).not.toContain('sha256: ');
  });

  it('--dir 模式：text 输出含 explicit directory mode 行', async () => {
    stubInstall(sample);
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    const r = await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
      '--dir',
      explicitDir,
      '--format',
      'text',
    ]);
    expect(r.stdout).toContain('\u2713 Skill installed successfully');
    expect(r.stdout).toContain('mode: Explicit directory (--dir)');
    expect(r.stdout).toContain('status: Installed');
  });
});
