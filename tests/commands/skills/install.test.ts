/**
 * Tests for `skills install` — behavior contract coverage: dual-format slug
 * input (full `@provider/slug` two-level branch + bare-slug compatibility
 * branch), slug validation (INVALID_SLUG, exit 1, structured JSON in json /
 * exact wording in text), --dir preflight (existing writable directory,
 * exit 1 on failure) and pass-through, JSON shape { slug, version, outcome,
 * targetDir, sha256 }, tri-state rendering, mode/status summary
 * rows, anonymous usage, and the README exit-code contract (2 = auth,
 * 3 = network/API, 1 = install/conflict failures).
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
import type { SkillsInstallResult } from '../../../src/types/skills.js';
import type { AgentDirSelection } from '../../../src/ui/AgentDirPrompt.js';
import { CliError } from '../../../src/utils/errors.js';
import { getCommandExamples } from '../../../src/utils/commander-helpers.js';
import { getKnownAgents } from '../../../src/utils/agent-dirs.js';
import {
  renderInkForTest,
  clearRenderedFrames,
  lastRenderedFrame,
} from '../../helpers/ink-render-mock.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };
let workDir: string;
let prevCwd: string;

let prevStdinIsTTY: boolean | undefined;

const {
  renderWithInkSpy,
  isRecognizedAgentDirMock,
  promptAgentDirMock,
  promptSkillOverrideConfirmMock,
} = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: ReactElement) => Promise<void>>(),
  isRecognizedAgentDirMock: vi.fn<(resolvedPath: string) => boolean>(),
  promptAgentDirMock:
    vi.fn<
      (defaultPath: string, agents: unknown[], slug: string) => Promise<AgentDirSelection | null>
    >(),
  promptSkillOverrideConfirmMock:
    vi.fn<(info: unknown, slug: string, version: string) => Promise<boolean>>(),
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
vi.mock('../../../src/ui/SkillOverrideConfirm.js', () => ({
  promptSkillOverrideConfirm: promptSkillOverrideConfirmMock,
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
  promptSkillOverrideConfirmMock.mockReset();
  promptSkillOverrideConfirmMock.mockResolvedValue(false);
  // Run every case from a throwaway cwd: invocations without --dir install
  // straight into the current directory and must never touch the repository
  // working tree.
  prevCwd = process.cwd();
  prevStdinIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  workDir = mkdtempSync(path.join(tmpdir(), 'qianwen-install-cmd-'));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  Object.defineProperty(process.stdin, 'isTTY', { value: prevStdinIsTTY, configurable: true });
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
  provider: '',
};

const FULL_SLUG = '@qianwen-ai/pdf-extractor';
const fullSample: SkillsInstallResult = {
  ...sample,
  slug: FULL_SLUG,
  targetDir: '/tmp/skills/pdf-extractor',
};

function stubInstall(result: SkillsInstallResult, calls?: Array<Record<string, unknown>>) {
  holder.services = makeMockServices({
    skillsHubService: {
      getSkillDetail: async () => sampleDetail,
    },
    skillsInstallService: {
      precheckSlugConflict: () => null,
      install: async (opts: Record<string, unknown>) => {
        calls?.push(opts);
        return result;
      },
    },
  });
}

function stubInstallCapture(
  result: SkillsInstallResult,
  installCalls: Array<Record<string, unknown>>,
  detailCalls: Array<{ name: string; provider?: string }>,
) {
  holder.services = makeMockServices({
    skillsHubService: {
      getSkillDetail: async (name: string, provider?: string) => {
        detailCalls.push({ name, provider });
        return sampleDetail;
      },
    },
    skillsInstallService: {
      precheckSlugConflict: () => null,
      install: async (opts: Record<string, unknown>) => {
        installCalls.push(opts);
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
      precheckSlugConflict: () => null,
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

const INVALID_SLUGS = [
  '@ns/abc.def',
  '@ns/abc/def',
  '@/abc',
  '@ns/',
  '',
  'abc.def',
  '../evil',
  'has space',
  'x'.repeat(129),
  '@qianwen-ai/con',
  '@qianwen-ai/prn',
  'nul',
  'aux',
  'com1',
  'lpt1',
];

describe('skills install — slug validation (exit 1)', () => {
  // '-leading' is intentionally absent: commander intercepts it as an
  // unknown option before the action-level slug validation runs.
  it.each(INVALID_SLUGS)(
    'rejects invalid slug %j with structured JSON before any service call',
    async (bad) => {
      const installCalls: Array<Record<string, unknown>> = [];
      const detailCalls: Array<{ name: string; provider?: string }> = [];
      stubInstallCapture(sample, installCalls, detailCalls);
      const r = await runCommand(build, ['skills', 'install', bad, '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stderr)).toEqual({
        error: {
          code: 'INVALID_SLUG',
          message: `Invalid Skill slug: ${bad}. Expected @<provider>/slug.`,
          exit_code: 1,
        },
      });
      expect(r.stdout).toBe('');
      expect(installCalls).toHaveLength(0);
      expect(detailCalls).toHaveLength(0);
    },
  );

  it('keeps the exact plain wording on stderr in text format (exit 1)', async () => {
    const installCalls: Array<Record<string, unknown>> = [];
    const detailCalls: Array<{ name: string; provider?: string }> = [];
    stubInstallCapture(sample, installCalls, detailCalls);
    const r = await runCapturingExitCode(['skills', 'install', '@ns/abc.def', '--format', 'text']);
    expect(r.finalExit).toBe(1);
    expect(r.stderr.trim()).toBe('Invalid Skill slug: @ns/abc.def. Expected @<provider>/slug.');
    expect(r.stderr).not.toContain('\u001b[');
    expect(r.stdout).toBe('');
    expect(installCalls).toHaveLength(0);
    expect(detailCalls).toHaveLength(0);
  });

  it.each(['_leading', 'trailing-', 'a'.repeat(65)])(
    'accepts bare slug %j under the new rule',
    async (slug) => {
      const installCalls: Array<Record<string, unknown>> = [];
      stubInstallCapture(sample, installCalls, []);
      const r = await runCommand(build, ['skills', 'install', slug, '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(installCalls).toHaveLength(1);
    },
  );

  it('accepts a single-character slug', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const r = await runCommand(build, ['skills', 'install', 'a', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('skills install — full slug input (flat path)', () => {
  it('passes the raw full slug and the parsed slug object to the service', async () => {
    const installCalls: Array<Record<string, unknown>> = [];
    stubInstallCapture(sample, installCalls, []);
    await runCommand(build, ['skills', 'install', FULL_SLUG, '--format', 'json']);
    expect(installCalls[0]).toMatchObject({
      slug: FULL_SLUG,
      parsedSlug: {
        provider: '@qianwen-ai',
        skillName: 'pdf-extractor',
        raw: FULL_SLUG,
      },
    });
  });

  it('queries the hub detail by the bare skill name part with provider', async () => {
    const installCalls: Array<Record<string, unknown>> = [];
    const detailCalls: Array<{ name: string; provider?: string }> = [];
    stubInstallCapture(sample, installCalls, detailCalls);
    await runCommand(build, ['skills', 'install', FULL_SLUG, '--format', 'table']);
    expect(detailCalls).toEqual([{ name: 'pdf-extractor', provider: '@qianwen-ai' }]);
  });

  it('echoes the full slug in the JSON output', async () => {
    stubInstall(fullSample);
    const r = await runCommand(build, ['skills', 'install', FULL_SLUG, '--format', 'json']);
    expect(JSON.parse(r.stdout).slug).toBe(FULL_SLUG);
  });

  it('renders the full slug in text mode', async () => {
    stubInstall(fullSample);
    const r = await runCommand(build, ['skills', 'install', FULL_SLUG, '--format', 'text']);
    expect(r.stdout).toContain(FULL_SLUG);
  });

  it('shows the install location in the --dir banner (table only)', async () => {
    stubInstall(fullSample);
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    const r = await runCommand(build, [
      'skills',
      'install',
      FULL_SLUG,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(r.stdout).toContain(`Install location: ${path.join(explicitDir, 'pdf-extractor')}`);
  });

  it('passes the full slug to the agent directory prompt (table mode)', async () => {
    stubInstall(sample);
    isRecognizedAgentDirMock.mockReturnValue(false);
    promptAgentDirMock.mockResolvedValue(null);
    await runCommand(build, ['skills', 'install', FULL_SLUG, '--format', 'table']);
    expect(promptAgentDirMock.mock.calls[0]?.[2]).toBe(FULL_SLUG);
  });
});

describe('skills install — bare slug input (compatibility branch)', () => {
  it('queries the hub detail with the bare slug and installs without parsedSlug', async () => {
    const installCalls: Array<Record<string, unknown>> = [];
    const detailCalls: Array<{ name: string; provider?: string }> = [];
    stubInstallCapture(sample, installCalls, detailCalls);
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(installCalls[0]).toEqual({ slug: 'pdf-extractor', baseDir: process.cwd() });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(detailCalls).toEqual([{ name: 'pdf-extractor', provider: undefined }]);
  });

  it('suggests searching when the server rejects a bare slug query with SKILL_NOT_FOUND', async () => {
    const installCalls: Array<Record<string, unknown>> = [];
    holder.services = makeMockServices({
      skillsHubService: {
        getSkillDetail: async () => {
          throw new CliError({
            code: 'SKILL_NOT_FOUND',
            message: 'Skill not found: pdf-extractor.',
            exitCode: 1,
          });
        },
      },
      skillsInstallService: {
        precheckSlugConflict: () => null,
        install: async (opts: Record<string, unknown>) => {
          installCalls.push(opts);
          return sample;
        },
      },
    });
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Skill not found: pdf-extractor.');
    expect(r.stderr).toContain(
      'Try searching first: skills search <keyword>, ' +
        'then install with the full slug from the results.',
    );
    expect(installCalls).toHaveLength(0);
  });
});

describe('skills install — agent scope context (table summary)', () => {
  it('shows Ready to use globally when the agent selection carries global scope', async () => {
    stubInstall(sample);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const opencode = getKnownAgents().find((a) => a.name === 'opencode')!;
    const selectedDir = path.join(workDir, 'global', 'opencode', 'skills');
    promptAgentDirMock.mockResolvedValue({
      path: selectedDir,
      agent: opencode,
      scope: 'global',
    });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame() ?? '').toContain('Ready to use globally');
  });
});

describe('skills install — command registration examples', () => {
  it('advertises the full slug form in the install examples', () => {
    const program = new Command();
    const skills = program.command('skills');
    const install = registerSkillsInstallCommand(skills);
    const examples = getCommandExamples(install);
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.some((e) => e.includes('@qianwen-ai/qianwen-find-skills'))).toBe(true);
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
  it('emits { slug, version, outcome, targetDir, sha256 } on stdout only', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({
      slug: 'pdf-extractor',
      version: '1.2.0',
      outcome: 'installed',
      targetDir: '/tmp/skills/pdf-extractor',
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
          "The directory '/tmp/x' already exists but is not managed " +
          'by this CLI (.qianwen-skill.json is missing or invalid). ' +
          'Please rename or remove the directory, then run the command again. No changes were made this time.',
        exitCode: 1,
      }),
    );
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('UNMANAGED_CONFLICT');
    expect(payload.error.message).toContain('No changes were made this time.');
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

  it('passes a NOT_FOUND CliError through as exit 1', async () => {
    stubInstallError(
      new CliError({ code: 'NOT_FOUND', message: 'Skill not found: ghost.', exitCode: 1 }),
    );
    const r = await runCommand(build, ['skills', 'install', 'ghost', '--format', 'json']);
    expect(r.exitCode).toBe(1);
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
  it('table mode triggers agent directory prompt for non-agent dir and uses selected directory', async () => {
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

  it('installs to cwd without creating subdirectory when user selects current directory', async () => {
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

  it('json/text mode does not trigger agent directory prompt', async () => {
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

  it('skips agent detection when --dir is explicitly specified', async () => {
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

  it('does not trigger prompt when cwd is a recognized agent directory', async () => {
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

  it('exits gracefully without calling install service when user cancels selection', async () => {
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

  it('rejects a non-existent slug before entering the directory prompt (table mode, exit 1)', async () => {
    const installCalls: Array<Record<string, unknown>> = [];
    holder.services = makeMockServices({
      skillsHubService: {
        getSkillDetail: async () => {
          throw new CliError({
            code: 'NOT_FOUND',
            message: 'Skill not found: ghost.',
            exitCode: 1,
          });
        },
      },
      skillsInstallService: {
        precheckSlugConflict: () => null,
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
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Skill not found: ghost.');
    expect(promptAgentDirMock).not.toHaveBeenCalled();
    expect(installCalls).toHaveLength(0);
  });
});

describe('skills install — --dir preflight validation', () => {
  it('text mode rejects with exit 1 when --dir points to non-existent path (plain text, no ANSI, install service not called)', async () => {
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

  it('json mode outputs structured error with exit 1 when --dir points to non-existent path (install service not called)', async () => {
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

  it('table mode renders cross mark in basic red (with ANSI) when --dir points to non-existent path', async () => {
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

  it('rejects with exit 1 when --dir points to a file (not a directory), treated as non-existent (json structured)', async () => {
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

  // chmod 0o555 does not revoke write access under Windows ACL semantics,
  // so the read-only premise cannot be established there; POSIX-only scenario.
  it.skipIf(process.platform === 'win32')(
    'rejects with exit 1 when --dir exists but is not writable (json structured, install service not called)',
    async () => {
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
    },
  );

  it.skipIf(process.platform === 'win32')(
    'text mode outputs plain-text error when --dir exists but is not writable (exit 1)',
    async () => {
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
    },
  );

  it('rejects with ROOT_DIR_NOT_ALLOWED when --dir is filesystem root (json, exit 1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const r = await runCommand(build, [
      'skills',
      'install',
      'pdf-extractor',
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
});

describe('skills install — CWD root guard', () => {
  it('rejects with ROOT_DIR_NOT_ALLOWED when CWD is filesystem root (text, exit 1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    // Temporarily override cwd to return the filesystem root
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path.parse(workDir).root);
    try {
      const r = await runCapturingExitCode([
        'skills',
        'install',
        'pdf-extractor',
        '--format',
        'text',
      ]);
      expect(r.finalExit).toBe(1);
      expect(r.stderr).toContain(
        'The installation base directory cannot be the filesystem root. Choose a Skills directory.',
      );
      expect(r.stderr).not.toContain('\u001b[');
      expect(r.stdout).toBe('');
      expect(calls).toHaveLength(0);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('rejects with ROOT_DIR_NOT_ALLOWED when CWD is filesystem root (json, exit 1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path.parse(workDir).root);
    try {
      const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
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
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('does not reject when CWD is a normal directory', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    // workDir is the current cwd set in beforeEach — a normal temp directory
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ baseDir: process.cwd() });
  });
});

describe('skills install — --dir pre-install banner (table only)', () => {
  it('table mode outputs explicit directory info banner before install', async () => {
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

  it('json/text mode does not output the directory info banner', async () => {
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
  it('current directory mode: table summary starts with check Skill installed successfully, rows are Skill/Mode/Location/Status (no Version/Security/SHA256)', async () => {
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

  it('updated outcome: table summary starts with check Skill updated successfully', async () => {
    stubInstall({ ...sample, outcome: 'updated' });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame() ?? '').toContain('\u2713 Skill updated successfully');
  });

  it('noop outcome: table summary shows existing copy with unified check prefix', async () => {
    stubInstall({ ...sample, outcome: 'noop' });
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame() ?? '').toContain('\u2713 Already installed \u2014 nothing to do');
  });

  it('agent selection mode: table summary contains agent displayName and Ready to use in this project', async () => {
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

  it('--dir mode: table summary contains Explicit directory (--dir) and Status: Installed', async () => {
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

  it('current directory mode: text output starts with result banner and contains skill/mode/location/status rows', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'text']);
    expect(r.stdout).toContain('\u2713 Skill installed successfully');
    expect(r.stdout).not.toContain('\u001b[');
    const idx = (s: string) => r.stdout.indexOf(s);
    expect(idx('skill: pdf-extractor')).toBeLessThan(idx('mode: Current directory'));
    expect(idx('mode: Current directory')).toBeLessThan(idx('location: '));
    expect(idx('location: ')).toBeLessThan(idx('status: Installed'));
    expect(r.stdout).toContain('version: ');
    expect(r.stdout).toContain('sha256: ');
    expect(r.stdout).not.toContain('security: ');
  });

  it('--dir mode: text output includes explicit directory mode line', async () => {
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

describe('skills install — stdin non-TTY bypass', () => {
  it('table mode falls back to cwd without prompting when stdin is not a TTY', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const originalIsTTY = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const r = await runCommand(build, [
        'skills',
        'install',
        'pdf-extractor',
        '--format',
        'table',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(promptAgentDirMock).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({ slug: 'pdf-extractor', baseDir: process.cwd() });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('table mode with stdout TTY but stdin non-TTY still uses cwd without prompting', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubInstall(sample, calls);
    isRecognizedAgentDirMock.mockReturnValue(false);
    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const r = await runCommand(build, [
        'skills',
        'install',
        'pdf-extractor',
        '--format',
        'table',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(promptAgentDirMock).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({ slug: 'pdf-extractor', baseDir: process.cwd() });
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

describe('skills install — requiresApiKey notice rendering', () => {
  const apiKeySample: SkillsInstallResult = { ...sample, requiresApiKey: true };

  it('json output includes requiresApiKey: true', async () => {
    stubInstall(apiKeySample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(JSON.parse(r.stdout).requiresApiKey).toBe(true);
  });

  it('json output omits requiresApiKey when not set', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'json']);
    expect(JSON.parse(r.stdout)).not.toHaveProperty('requiresApiKey');
  });

  it('text output includes notice line', async () => {
    stubInstall(apiKeySample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'text']);
    expect(r.stdout).toContain('notice: This skill requires an API Key to use.');
  });

  it('text output omits notice when requiresApiKey is not set', async () => {
    stubInstall(sample);
    const r = await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'text']);
    expect(r.stdout).not.toContain('notice:');
  });

  it('table output includes notice line', async () => {
    stubInstall(apiKeySample);
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame() ?? '').toContain('notice: This skill requires an API Key to use.');
  });

  it('table output omits notice when requiresApiKey is not set', async () => {
    stubInstall(sample);
    await runCommand(build, ['skills', 'install', 'pdf-extractor', '--format', 'table']);
    expect(lastRenderedFrame() ?? '').not.toContain('notice:');
  });
});

describe('skills install - slug conflict override confirmation', () => {
  const conflictInfo = {
    existingSlug: '@other-ns/pdf-extractor',
    existingVersion: '0.5.0',
    targetDir: '/tmp/skills/pdf-extractor',
  };

  function stubInstallWithConflict(
    result: SkillsInstallResult,
    conflictReturn: unknown = conflictInfo,
  ) {
    holder.services = makeMockServices({
      skillsHubService: {
        getSkillDetail: async () => sampleDetail,
      },
      skillsInstallService: {
        precheckSlugConflict: () => conflictReturn,
        install: async () => result,
      },
    });
  }

  it('renders SkillOverrideConfirm when table + TTY + conflict + no --dir', async () => {
    stubInstallWithConflict(sample);
    promptSkillOverrideConfirmMock.mockResolvedValue(true);
    await runCommand(build, ['skills', 'install', FULL_SLUG, '--format', 'table']);
    expect(promptSkillOverrideConfirmMock).toHaveBeenCalledTimes(1);
  });

  it('exits 0 with cancellation message when user declines override', async () => {
    stubInstallWithConflict(sample);
    promptSkillOverrideConfirmMock.mockResolvedValue(false);
    const r = await runCapturingExitCode(['skills', 'install', FULL_SLUG, '--format', 'table']);
    expect(r.finalExit).toBe(0);
    expect(r.stderr).toContain('Installation cancelled by user.');
  });

  it('auto-overrides with banner when --dir is specified with conflict', async () => {
    const overriddenResult: SkillsInstallResult = {
      ...sample,
      slug: FULL_SLUG,
      overwritten: true,
      previousSlug: '@other-ns/pdf-extractor',
      previousVersion: '0.5.0',
    };
    stubInstallWithConflict(overriddenResult);
    const explicitDir = path.join(workDir, 'target');
    mkdirSync(explicitDir, { recursive: true });
    const r = await runCapturingExitCode([
      'skills',
      'install',
      FULL_SLUG,
      '--dir',
      explicitDir,
      '--format',
      'table',
    ]);
    expect(r.stderr).toContain('override: Replaced');
    expect(promptSkillOverrideConfirmMock).not.toHaveBeenCalled();
  });

  it('exits 1 when non-TTY without --dir encounters conflict', async () => {
    stubInstallWithConflict(sample);
    const originalIsTTY = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const r = await runCapturingExitCode(['skills', 'install', FULL_SLUG, '--format', 'table']);
      expect(r.finalExit).toBe(1);
      expect(r.stderr).toContain('Target directory is occupied by a different skill');
      expect(promptSkillOverrideConfirmMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });
});
