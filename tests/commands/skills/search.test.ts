/**
 * Tests for `skills search` — behavior contract coverage:
 * --limit validation (exit 1, exact wording in text/table, structured JSON
 * in json), JSON shape { query, results }, empty query pass-through, empty
 * results exit 0, full-slug display adaptation (Name=DisplayName,
 * Slug=@provider/name, publisher=ProviderName across the three formats),
 * tri-state rendering and the README exit-code contract
 * (2 = auth, 3 = network/API).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SkillsSearchResult } from '../../../src/types/skills.js';
import { GatewayBusinessError } from '../../../src/api/request-adapter.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { renderWithInkSpy, renderInteractiveSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
  renderInteractiveSpy: vi.fn<(el: any) => Promise<void>>(),
}));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
// Hard no-credentials environment: if the skills chain ever routes through an
// auth gate (ensureAuthenticated / required authMode), these throw and the
// anonymous-usage tests below fail loudly (C-018: search works logged out).
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
  renderInteractive: renderInteractiveSpy,
}));

import { registerSkillsSearchCommand } from '../../../src/commands/skills/search.js';

function build(program: import('commander').Command) {
  const skills = program.command('skills');
  registerSkillsSearchCommand(skills);
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  // InteractiveTable mounts useInput, which ink-testing-library's stdin stub
  // cannot host (no ref()); assert on the element props instead of a frame.
  renderInteractiveSpy.mockReset();
  renderInteractiveSpy.mockResolvedValue(undefined);
  clearRenderedFrames();
});

const sample: SkillsSearchResult = {
  query: 'pdf',
  totalCount: 2,
  results: [
    {
      slug: '@qianwen-ai/pdf-extractor',
      name: 'PDF Extractor',
      description: 'Extract text from PDFs',
      publisher: '千问 AI 平台',
      currentVersion: '1.2.0',
      verified: true,
    },
    {
      slug: '@qianwen-ai-test/pdf-merge',
      name: 'PDF Merge',
      description: 'Merge PDF files',
      publisher: '千问 AI 测试',
      verified: false,
    },
  ],
};

const emptyResult: SkillsSearchResult = { query: 'nothing', totalCount: 0, results: [] };

function stubSearch(result: SkillsSearchResult, calls?: Array<Record<string, unknown>>) {
  holder.services = makeMockServices({
    skillsHubService: {
      searchSkills: async (opts: Record<string, unknown>) => {
        calls?.push(opts);
        return result;
      },
    },
  });
}

function stubSearchError(error: unknown) {
  holder.services = makeMockServices({
    skillsHubService: {
      searchSkills: async () => {
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

describe('skills search — JSON output contract', () => {
  it('emits parseable { query, results } on stdout only', async () => {
    stubSearch(sample);
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe('');
    const payload = JSON.parse(r.stdout);
    expect(payload).toEqual({ query: 'pdf', results: sample.results });
  });

  it('keeps currentVersion omitted (not null) in JSON when absent', async () => {
    stubSearch(sample);
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    const payload = JSON.parse(r.stdout);
    expect('currentVersion' in payload.results[1]).toBe(false);
  });

  it('outputs { query, results: [] } with exit 0 when there are no results', async () => {
    stubSearch(emptyResult);
    const r = await runCapturingExitCode(['skills', 'search', 'nothing', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(r.finalExit).toBeUndefined();
    expect(JSON.parse(r.stdout)).toEqual({ query: 'nothing', results: [] });
  });
});

describe('skills search — --limit validation (exit 1)', () => {
  it('defaults limit to 5', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubSearch(sample, calls);
    await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(calls[0]).toMatchObject({ query: 'pdf', limit: 5 });
  });

  it('passes a valid --limit through to the service', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubSearch(sample, calls);
    await runCommand(build, ['skills', 'search', 'pdf', '--limit', '50', '--format', 'json']);
    expect(calls[0]).toMatchObject({ limit: 50 });
  });

  it.each(['0', '51'])('rejects out-of-range --limit %s with structured JSON', async (bad) => {
    stubSearch(sample);
    const r = await runCommand(build, [
      'skills',
      'search',
      'pdf',
      '--limit',
      bad,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'INVALID_ARGUMENT',
        message: '--limit must be between 1 and 50.',
        exit_code: 1,
      },
    });
    expect(r.stdout).toBe('');
  });

  it.each(['abc', '1.5'])('rejects non-integer --limit %s with structured JSON', async (bad) => {
    stubSearch(sample);
    const r = await runCommand(build, [
      'skills',
      'search',
      'pdf',
      '--limit',
      bad,
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'INVALID_ARGUMENT',
        message: '--limit must be an integer.',
        exit_code: 1,
      },
    });
    expect(r.stdout).toBe('');
  });

  it.each(['text', 'table'])(
    'keeps the exact plain wording on stderr in %s format (exit 1)',
    async (fmt) => {
      stubSearch(sample);
      const r = await runCapturingExitCode([
        'skills',
        'search',
        'pdf',
        '--limit',
        '0',
        '--format',
        fmt,
      ]);
      expect(r.finalExit).toBe(1);
      expect(r.stderr.trim()).toBe('--limit must be between 1 and 50.');
      expect(r.stdout).toBe('');
    },
  );
});

describe('skills search — query handling', () => {
  it('accepts an empty query and passes it through verbatim', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubSearch(emptyResult, calls);
    const r = await runCommand(build, ['skills', 'search', '', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls[0]).toMatchObject({ query: '' });
  });

  it('treats a missing query argument as empty', async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubSearch(emptyResult, calls);
    const r = await runCommand(build, ['skills', 'search', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls[0]).toMatchObject({ query: '' });
  });
});

describe('skills search — rendering modes', () => {
  it('text mode renders without invoking Ink', async () => {
    stubSearch(sample);
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).not.toHaveBeenCalled();
    expect(renderInteractiveSpy).not.toHaveBeenCalled();
    expect(r.stdout).toContain('@qianwen-ai/pdf-extractor');
  });

  it('table mode mounts the interactive table with the full result set', async () => {
    stubSearch(sample);
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderInteractiveSpy).toHaveBeenCalledTimes(1);
    expect(renderWithInkSpy).not.toHaveBeenCalled();
    const element = renderInteractiveSpy.mock.calls[0]![0];
    // Single page carries all rows (perPage === totalItems), so the
    // InteractiveTable status bar hides its prev/next pagination hints.
    expect(element.props.totalItems).toBe(2);
    expect(element.props.perPage).toBe(2);
    expect(element.props.initialRows).toHaveLength(2);
    expect(element.props.initialRows[0].slug).toBe('@qianwen-ai/pdf-extractor');
    expect(element.props.initialRows[1].slug).toBe('@qianwen-ai-test/pdf-merge');
    expect(element.props.title).toBe('Skills Search \u00b7 "pdf"');
    expect(element.props.subtitle).toContain('2 skills');
    expect(element.props.subtitle).toContain('skills install <slug>');
  });

  it('table mode short-circuits empty results without Ink', async () => {
    stubSearch(emptyResult);
    const r = await runCommand(build, ['skills', 'search', 'nothing', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).not.toHaveBeenCalled();
    expect(renderInteractiveSpy).not.toHaveBeenCalled();
    expect(r.stdout).toContain('No skills found.');
  });
});

describe('skills search — full slug display adaptation', () => {
  it('carries the full slug verbatim in JSON output', async () => {
    stubSearch(sample);
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    const payload = JSON.parse(r.stdout);
    expect(payload.results[0].slug).toBe('@qianwen-ai/pdf-extractor');
    expect(payload.results[1].slug).toBe('@qianwen-ai-test/pdf-merge');
  });

  it('renders the display name and the full slug on the same line in text mode', async () => {
    stubSearch(sample);
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'text']);
    const line = r.stdout.split('\n').find((l) => l.includes('PDF Extractor'));
    expect(line).toBeDefined();
    expect(line).toContain('@qianwen-ai/pdf-extractor');
  });

  it('passes provider names through in all three formats', async () => {
    stubSearch(sample);
    const json = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(JSON.parse(json.stdout).results[0].publisher).toBe('千问 AI 平台');
    const text = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'text']);
    expect(text.stdout).toContain('千问 AI 平台');
  });

  it('table rows carry full slugs, display names and provider names', async () => {
    stubSearch(sample);
    await runCommand(build, ['skills', 'search', 'pdf', '--format', 'table']);
    const element = renderInteractiveSpy.mock.calls[0]![0];
    expect(element.props.initialRows[0]).toMatchObject({
      slug: '@qianwen-ai/pdf-extractor',
      name: 'PDF Extractor',
      publisher: '千问 AI 平台',
    });
  });
});

describe('skills search — README exit codes (2 = auth, 3 = network/API)', () => {
  it('succeeds in a fully credential-less environment — no auth gate, no exit 2', async () => {
    stubSearch(sample);
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).not.toContain('Not authenticated');
    expect(JSON.parse(r.stdout).results).toHaveLength(2);
  });

  it('maps server-side auth rejection (HTTP 401) to exit 2', async () => {
    stubSearchError(new Error('HTTP 401: Unauthorized'));
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe('AUTH_REQUIRED');
    expect(r.stdout).toBe('');
  });

  it('maps expired token (HTTP 403) to exit 2', async () => {
    stubSearchError(new Error('HTTP 403: Forbidden'));
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe('TOKEN_EXPIRED');
  });

  it('maps network failures to exit 3', async () => {
    stubSearchError(new Error('fetch failed: ECONNREFUSED 127.0.0.1'));
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stderr).error.code).toBe('NETWORK_ERROR');
  });

  it('maps gateway business failures (API errors) to exit 3', async () => {
    stubSearchError(new GatewayBusinessError('403', 'blocked by policy'));
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(r.exitCode).toBe(3);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('API_ERROR');
    expect(payload.error.message).toBe('blocked by policy');
  });

  it('maps HTTP 5xx server errors to exit 3', async () => {
    stubSearchError(new Error('HTTP 502: Bad Gateway'));
    const r = await runCommand(build, ['skills', 'search', 'pdf', '--format', 'json']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stderr).error.code).toBe('SERVER_ERROR');
  });
});
