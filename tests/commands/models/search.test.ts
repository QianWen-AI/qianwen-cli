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

const { modelsSearchAction } = await import('../../../src/commands/models/search.js');

const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  holder.client = makeMockApiClient();
  Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
});

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

    const r = await runCommand(setupCmd, [
      'models',
      'search',
      'm',
      '--format',
      'json',
      '--all',
    ]);
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
      'models', 'search', 'q', '--format=text', '--page', '99',
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
