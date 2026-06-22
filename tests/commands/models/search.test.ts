import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient, makeModel } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';

const holder: { client: ApiClient } = { client: makeMockApiClient() };

vi.mock('../../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({ access_token: 't', expires_at: '2099-01-01T00:00:00Z' }),
}));

// Spy on the interactive (TUI) renderer so we can assert it is NOT entered when
// a JSON-only flag forces the format up to JSON.
const mockRenderInteractive = vi.fn();
vi.mock('../../../src/ui/render.js', () => ({
  renderInteractive: mockRenderInteractive,
  renderWithInk: vi.fn(),
  renderWithInkSync: vi.fn(),
}));

// Spy on the JSON sink with a passthrough so existing stdout-parsing tests keep
// working while promotion tests can assert the JSON path was taken.
const mockPrintJSON = vi.fn((data: unknown) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(data, null, 2));
});
vi.mock('../../../src/output/json.js', () => ({
  printJSON: (data: unknown) => mockPrintJSON(data),
}));

// Keep the spinner inert: under a TTY it would start an animation interval.
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: vi.fn(),
}));

const { modelsSearchAction } = await import('../../../src/commands/models/search.js');

const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  holder.client = makeMockApiClient();
  mockRenderInteractive.mockReset();
  mockPrintJSON.mockReset();
  mockPrintJSON.mockImplementation((data: unknown) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2));
  });
  Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
});

/** Force the interactive (TTY) path so the auto-detected format is `table`. */
function forceTTY() {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
}

function setupCmd(program: any) {
  program
    .command('models')
    .command('search <query>')
    .option('--format <f>')
    .option('--page <n>')
    .option('--per-page <n>')
    .option('--all')
    .action(modelsSearchAction);
}

describe('models search command', () => {
  it('JSON: returns matching models', async () => {
    const models = [
      makeModel({ id: 'qwen-search-a', pricing: { tiers: [] } }),
      makeModel({ id: 'qwen-search-b', pricing: { tiers: [] } }),
    ];
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 2 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'search', 'qwen', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toHaveLength(2);
    expect(payload.total).toBe(2);
    expect(payload.query).toBe('qwen');
  });

  it('JSON: 0 hits returns models=[] total=0 with query', async () => {
    const r = await runCommand(setupCmd, ['models', 'search', 'unknown', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toEqual([]);
    expect(payload.total).toBe(0);
    expect(payload.query).toBe('unknown');
  });

  it('JSON --all: skips pagination and includes all=true', async () => {
    const models = Array.from({ length: 30 }, (_, i) => makeModel({ id: `m-${i}` }));
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 30 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'search', 'm', '--format', 'json', '--all']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.all).toBe(true);
    expect(payload.models).toHaveLength(30);
  });

  it('JSON: page > total_pages returns empty page with warning', async () => {
    const models = [makeModel({ id: 'sole' })];
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, [
      'models',
      'search',
      'x',
      '--format',
      'json',
      '--page',
      '99',
    ]);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toEqual([]);
    expect(payload.page).toBe(99);
    expect(r.stderr).toMatch(/exceeds total pages/i);
  });

  it('JSON pagination: --page=2 --per-page=1 returns 2nd model', async () => {
    const models = [
      makeModel({ id: 'a', pricing: { tiers: [] } }),
      makeModel({ id: 'b', pricing: { tiers: [] } }),
    ];
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 2 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, [
      'models',
      'search',
      'q',
      '--format',
      'json',
      '--page',
      '2',
      '--per-page',
      '1',
    ]);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toHaveLength(1);
    expect(payload.models[0].id).toBe('b');
    expect(payload.page).toBe(2);
  });

  it('non-JSON: 0 hits prints fallback message containing query', async () => {
    const r = await runCommand(setupCmd, ['models', 'search', 'nothing']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout + r.stderr).toMatch(/(No models found|nothing)/i);
  });

  // ── extended branches ───────────────────────────────────────────────
  it('text mode with hits renders model ids', async () => {
    const models = [
      makeModel({ id: 'qwen-search-text-a', pricing: { tiers: [] } as any }),
      makeModel({ id: 'qwen-search-text-b', pricing: { tiers: [] } as any }),
    ];
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 2 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async () => models as any,
    });
    const r = await runCommand(setupCmd, ['models', 'search', 'qwen', '--format=text']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('qwen-search-text-a');
    expect(r.stdout).toContain('qwen-search-text-b');
  });

  it('non-JSON: page > totalPages emits stderr warning (text mode)', async () => {
    const models = [makeModel({ id: 'only', pricing: { tiers: [] } as any })];
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async () => models as any,
    });
    const r = await runCommand(setupCmd, [
      'models',
      'search',
      'q',
      '--format=text',
      '--page',
      '99',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toMatch(/exceeds total pages/i);
  });

  it('API failure on searchModels → exit 1 with error', async () => {
    holder.client = makeMockApiClient({
      searchModels: async () => {
        throw new Error('search-fail');
      },
    });
    const r = await runCommand(setupCmd, ['models', 'search', 'x', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('search-fail');
  });
});

// ── JSON-only flag auto-promotion under TTY ───────────────────────────────
//
// `--all` is a JSON-only flag (search has no --verbose). In a TTY the default
// format is `table`, which historically routed to the interactive renderer and
// silently dropped `--all`. The contract: when `--all` is present and the
// resolved format is not `json`, the command must promote to JSON, emit a stderr
// advisory containing "JSON", and take the JSON path WITHOUT entering the TUI.
//
// The decisive regression guard is `renderInteractive` NOT being called paired
// with `printJSON` being called: an implementation that keeps rendering the
// table would call renderInteractive → red.
describe('models search — JSON-only flag auto-promotion (TTY)', () => {
  it('TTY + --all (no --format) promotes to JSON: printJSON called, renderInteractive NOT called + advisory', async () => {
    forceTTY();
    const models = Array.from({ length: 8 }, (_, i) =>
      makeModel({ id: `s-auto-${i}`, pricing: { tiers: [] } as any }),
    );
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 8 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'search', 'qwen', '--all']);

    expect(r.exitCode).toBeUndefined();
    expect(mockRenderInteractive).not.toHaveBeenCalled();
    expect(mockPrintJSON).toHaveBeenCalledTimes(1);
    const payload = mockPrintJSON.mock.calls[0][0] as { all: boolean; models: unknown[] };
    expect(payload.all).toBe(true);
    expect(payload.models).toHaveLength(8);
    expect(r.stderr).toContain('JSON');
  });

  it('regression guard: TTY without --all enters the TUI (renderInteractive called, no JSON promotion)', async () => {
    forceTTY();
    const models = [
      makeModel({ id: 's-tui-a', pricing: { tiers: [] } as any }),
      makeModel({ id: 's-tui-b', pricing: { tiers: [] } as any }),
    ];
    holder.client = makeMockApiClient({
      searchModels: async () => ({ models, total: 2 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'search', 'qwen']);

    expect(r.exitCode).toBeUndefined();
    expect(mockRenderInteractive).toHaveBeenCalledTimes(1);
    expect(mockPrintJSON).not.toHaveBeenCalled();
  });
});
