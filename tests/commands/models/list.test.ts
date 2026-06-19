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
// a JSON-only flag forces the format up to JSON. The named variable lets each
// test reset and assert call counts precisely.
const mockRenderInteractive = vi.fn();
vi.mock('../../../src/ui/render.js', () => ({
  renderInteractive: mockRenderInteractive,
  renderWithInk: vi.fn(),
  renderWithInkSync: vi.fn(),
}));

// Spy on the JSON sink. The passthrough implementation preserves the existing
// stdout-parsing tests (they JSON.parse(r.stdout)) while also recording calls
// so the promotion tests can assert the JSON path was taken.
const mockPrintJSON = vi.fn((data: unknown) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(data, null, 2));
});
vi.mock('../../../src/output/json.js', () => ({
  printJSON: (data: unknown) => mockPrintJSON(data),
}));

// Keep the spinner inert: under a TTY it would start an animation interval that
// never resolves in-process. Running the work directly keeps tests deterministic.
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: vi.fn(),
}));

const { modelsListAction } = await import('../../../src/commands/models/list.js');

const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  holder.client = makeMockApiClient();
  mockRenderInteractive.mockReset();
  mockPrintJSON.mockReset();
  mockPrintJSON.mockImplementation((data: unknown) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2));
  });
  // Force non-TTY so InteractiveTable path is skipped
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
  const cmd = program
    .command('models')
    .command('list')
    .option('--input <m>')
    .option('--output <m>')
    .option('--format <f>')
    .option('--page <n>')
    .option('--per-page <n>')
    .option('--all')
    .option('--verbose')
    .action(modelsListAction);
  return cmd;
}

describe('models list command', () => {
  it('JSON: returns paginated models with pricing & quota', async () => {
    const models = [
      makeModel({ id: 'qwen-a', pricing: { tiers: [] } }),
      makeModel({ id: 'qwen-b', pricing: { tiers: [] } }),
    ];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: models.length }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toHaveLength(2);
    expect(payload.total).toBe(2);
    expect(payload.page).toBe(1);
    expect(payload.total_pages).toBe(1);
  });

  it('JSON: empty result returns models=[] total=0', async () => {
    const r = await runCommand(setupCmd, ['models', 'list', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toEqual([]);
    expect(payload.total).toBe(0);
  });

  it('JSON --all: skips pagination, includes all=true flag', async () => {
    const models = Array.from({ length: 25 }, (_, i) =>
      makeModel({ id: `m-${i}`, pricing: { tiers: [] } }),
    );
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 25 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--format', 'json', '--all']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.all).toBe(true);
    expect(payload.models).toHaveLength(25);
    expect(payload.total).toBe(25);
  });

  it('JSON: page > total_pages returns empty page with warning', async () => {
    const models = [makeModel({ id: 'only-one' })];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--format', 'json', '--page', '5']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toEqual([]);
    expect(payload.page).toBe(5);
    expect(r.stderr).toMatch(/exceeds total pages/i);
  });

  it('JSON pagination: --page 2 --per-page 1 returns second model', async () => {
    const models = [
      makeModel({ id: 'a', pricing: { tiers: [] } }),
      makeModel({ id: 'b', pricing: { tiers: [] } }),
      makeModel({ id: 'c', pricing: { tiers: [] } }),
    ];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 3 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, [
      'models',
      'list',
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
    expect(payload.total_pages).toBe(3);
  });

  it('empty result is reported (json or text path)', async () => {
    const r = await runCommand(setupCmd, ['models', 'list', '--format=text']);
    expect(r.exitCode).toBeUndefined();
    // Accept either text fallback message or empty JSON payload
    expect(r.stdout + r.stderr).toMatch(/(No models found|"total":\s*0)/i);
  });

  it('text mode: renders text table when models present', async () => {
    const models = [makeModel({ id: 'qwen3-plus', pricing: { tiers: [] } })];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async () => models as any,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--format=text']);
    expect(r.exitCode).toBeUndefined();
    // Either JSON or text path is acceptable here — what matters is the model id appears
    expect(r.stdout).toContain('qwen3-plus');
  });

  it('rejects invalid --input modality flag', async () => {
    const r = await runCommand(setupCmd, [
      'models',
      'list',
      '--format',
      'json',
      '--input',
      'invalid-modality',
    ]);
    expect(r.exitCode).toBeGreaterThanOrEqual(1);
  });

  // ── extended branches ───────────────────────────────────────────────
  it('--input/--output modality filters are forwarded to API client', async () => {
    let captured: { input?: string; output?: string } = {};
    holder.client = makeMockApiClient({
      listModels: async (opts) => {
        captured = { input: opts?.input, output: opts?.output };
        return { models: [], total: 0 };
      },
    });
    const r = await runCommand(setupCmd, [
      'models',
      'list',
      '--format',
      'json',
      '--input',
      'text',
      '--output',
      'image',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(captured.input).toBe('text');
    expect(captured.output).toBe('image');
  });

  it('JSON --verbose: enriches each model via getModels detail call', async () => {
    let getModelsCalled = false;
    const models = [makeModel({ id: 'qwen-v', pricing: { tiers: [] } as any })];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async (ids) => {
        getModelsCalled = true;
        return ids.map(
          (id) =>
            ({
              ...makeModel({ id, pricing: { tiers: [] } as any }),
              description: 'verbose-desc',
              tags: ['t1'],
              features: ['f1'],
              rate_limits: { rpm: 100 },
              metadata: { version_tag: 'v1', open_source: false, updated: '2026-01-01' },
            }) as any,
        );
      },
    });
    const r = await runCommand(setupCmd, ['models', 'list', '--format', 'json', '--verbose']);
    expect(r.exitCode).toBeUndefined();
    expect(getModelsCalled).toBe(true);
    const payload = JSON.parse(r.stdout);
    expect(payload.models).toHaveLength(1);
    expect(payload.models[0].description).toBe('verbose-desc');
  });

  it('JSON --all --verbose: enriches all models in one shot', async () => {
    const models = Array.from({ length: 3 }, (_, i) =>
      makeModel({ id: `m-${i}`, pricing: { tiers: [] } as any }),
    );
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 3 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async (ids) =>
        ids.map(
          (id) =>
            ({
              ...makeModel({ id, pricing: { tiers: [] } as any }),
              description: `desc-${id}`,
              tags: [],
              features: [],
              rate_limits: { rpm: 100 },
              metadata: { version_tag: 'v', open_source: false, updated: '2026-01-01' },
            }) as any,
        ),
    });
    const r = await runCommand(setupCmd, [
      'models',
      'list',
      '--format',
      'json',
      '--all',
      '--verbose',
    ]);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.all).toBe(true);
    expect(payload.models).toHaveLength(3);
    expect(payload.models.every((m: any) => m.description?.startsWith('desc-'))).toBe(true);
  });

  it('text mode with multiple models renders all ids', async () => {
    const models = [
      makeModel({ id: 'qwen-text-a', pricing: { tiers: [] } as any }),
      makeModel({ id: 'qwen-text-b', pricing: { tiers: [] } as any }),
    ];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 2 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async () => models as any,
    });
    const r = await runCommand(setupCmd, ['models', 'list', '--format=text']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('qwen-text-a');
    expect(r.stdout).toContain('qwen-text-b');
  });

  it('non-JSON: page > totalPages emits stderr warning', async () => {
    const models = [makeModel({ id: 'only-one', pricing: { tiers: [] } as any })];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async () => models as any,
    });
    const r = await runCommand(setupCmd, ['models', 'list', '--format=text', '--page', '99']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toMatch(/exceeds total pages/i);
  });

  it('API failure → exit 1 with error on stderr', async () => {
    holder.client = makeMockApiClient({
      listModels: async () => {
        throw new Error('list-fail');
      },
    });
    const r = await runCommand(setupCmd, ['models', 'list', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('list-fail');
  });
});

// ── JSON-only flag auto-promotion under TTY ───────────────────────────────
//
// `--all` / `--verbose` are JSON-only flags. In a TTY the default format is
// `table`, which historically routed to the interactive renderer and SILENTLY
// dropped these flags. The contract: when such a flag is present and the
// resolved format is not `json`, the command must promote to JSON, emit a
// stderr advisory containing "JSON", and take the JSON path (printJSON) WITHOUT
// entering the TUI (renderInteractive).
//
// The decisive signal is `renderInteractive` NOT being called: an implementation
// that ignores the flag and keeps rendering the table would call it → red. A
// terminal-content assertion alone cannot distinguish "promoted" from "rendered
// table that happens to contain the same ids", so the call-vs-not-call pair on
// the two renderers is the regression guard.
describe('models list — JSON-only flag auto-promotion (TTY)', () => {
  it('TTY + --all (no --format) promotes to JSON: printJSON called, renderInteractive NOT called', async () => {
    forceTTY();
    const models = Array.from({ length: 12 }, (_, i) =>
      makeModel({ id: `auto-${i}`, pricing: { tiers: [] } as any }),
    );
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 12 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--all']);

    expect(r.exitCode).toBeUndefined();
    expect(mockRenderInteractive).not.toHaveBeenCalled();
    expect(mockPrintJSON).toHaveBeenCalledTimes(1);
    const payload = mockPrintJSON.mock.calls[0][0] as { all: boolean; models: unknown[] };
    expect(payload.all).toBe(true);
    expect(payload.models).toHaveLength(12);
  });

  it('TTY + --all writes a stderr advisory containing "JSON"', async () => {
    forceTTY();
    const models = [makeModel({ id: 'adv', pricing: { tiers: [] } as any })];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--all']);

    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toContain('JSON');
  });

  it('TTY + --verbose (no --format) promotes to JSON and enriches via getModels', async () => {
    forceTTY();
    let getModelsCalled = false;
    const models = [makeModel({ id: 'verbose-auto', pricing: { tiers: [] } as any })];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async (ids) => {
        getModelsCalled = true;
        return ids.map((id) => ({
          ...makeModel({ id, pricing: { tiers: [] } as any }),
          description: 'verbose-auto-desc',
          tags: [],
          features: [],
          rate_limits: { rpm: 100 },
          metadata: { version_tag: 'v', open_source: false, updated: '2026-01-01' },
        })) as any;
      },
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--verbose']);

    expect(r.exitCode).toBeUndefined();
    expect(mockRenderInteractive).not.toHaveBeenCalled();
    expect(mockPrintJSON).toHaveBeenCalledTimes(1);
    expect(getModelsCalled).toBe(true);
    const payload = mockPrintJSON.mock.calls[0][0] as {
      models: Array<{ description?: string; rate_limits?: { rpm: number } }>;
    };
    expect(payload.models).toHaveLength(1);
    expect(payload.models[0].description).toBe('verbose-auto-desc');
    expect(payload.models[0].rate_limits?.rpm).toBe(100);
  });

  it('TTY + --verbose writes a stderr advisory containing "JSON"', async () => {
    forceTTY();
    const models = [makeModel({ id: 'vadv', pricing: { tiers: [] } as any })];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 1 }),
      fetchQuotasForModels: async (ms) => ms,
      getModels: async (ids) =>
        ids.map((id) => ({
          ...makeModel({ id, pricing: { tiers: [] } as any }),
          description: 'd',
          tags: [],
          features: [],
          rate_limits: { rpm: 1 },
          metadata: { version_tag: 'v', open_source: false, updated: '2026-01-01' },
        })) as any,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--verbose']);

    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toContain('JSON');
  });

  it('explicit --format table + --all still promotes to JSON (printJSON, no TUI) + advisory', async () => {
    forceTTY();
    const models = Array.from({ length: 5 }, (_, i) =>
      makeModel({ id: `tbl-all-${i}`, pricing: { tiers: [] } as any }),
    );
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 5 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'list', '--format', 'table', '--all']);

    expect(r.exitCode).toBeUndefined();
    expect(mockRenderInteractive).not.toHaveBeenCalled();
    expect(mockPrintJSON).toHaveBeenCalledTimes(1);
    const payload = mockPrintJSON.mock.calls[0][0] as { all: boolean; models: unknown[] };
    expect(payload.all).toBe(true);
    expect(payload.models).toHaveLength(5);
    expect(r.stderr).toContain('JSON');
  });

  it('regression guard: TTY without --all/--verbose enters the TUI (renderInteractive called, no JSON promotion)', async () => {
    forceTTY();
    const models = [
      makeModel({ id: 'tui-a', pricing: { tiers: [] } as any }),
      makeModel({ id: 'tui-b', pricing: { tiers: [] } as any }),
    ];
    holder.client = makeMockApiClient({
      listModels: async () => ({ models, total: 2 }),
      fetchQuotasForModels: async (ms) => ms,
    });

    const r = await runCommand(setupCmd, ['models', 'list']);

    expect(r.exitCode).toBeUndefined();
    expect(mockRenderInteractive).toHaveBeenCalledTimes(1);
    expect(mockPrintJSON).not.toHaveBeenCalled();
  });
});
