import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient, makeModel } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';
import type { ModelDetail } from '../../../src/types/model.js';

const holder: { client: ApiClient } = { client: makeMockApiClient() };

vi.mock('../../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({}),
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
}));

const { modelsInfoAction } = await import('../../../src/commands/models/info.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
});

/** Walk the command's ancestor chain looking for a --format flag. Mirrors
 *  the production wiring in src/commands/models/index.ts (resolveFormatOpt). */
function resolveFormatFromAncestors(cmd: import('commander').Command): string | undefined {
  let p: import('commander').Command | null = cmd.parent ?? null;
  while (p) {
    const f = p.opts().format as string | undefined;
    if (f) return f;
    p = p.parent ?? null;
  }
  return undefined;
}

function buildInfo(program: import('commander').Command) {
  const models = program.command('models');
  const info = models.command('info')
    .argument('<id>')
    .option('--format <fmt>');
  info.action(async function (this: import('commander').Command, id: string, opts: { format?: string }) {
    opts.format = opts.format ?? resolveFormatFromAncestors(this);
    await modelsInfoAction(id, opts);
  });
}

function fullDetail(id: string): ModelDetail {
  return {
    id,
    description: `Description of ${id}`,
    tags: ['flagship'],
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: { mode: 'standard', quota: { remaining: 0, total: 1_000_000, unit: 'tokens', used_pct: 100 } },
    pricing: { tiers: [{ label: 'default', input: 0.5, output: 3, unit: 'USD/1M tokens' }] },
    features: ['function-calling'],
    rate_limits: { rpm: 1000 },
    metadata: { version_tag: 'STABLE', open_source: false, updated: '2026-04-01' },
  } as ModelDetail;
}

describe('models info command (one-shot)', () => {
  describe('JSON mode', () => {
    it('typo model → MODEL_NOT_FOUND with did-you-mean on stderr, exit 1', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({
          models: [makeModel({ id: 'qwen3-max' })],
          total: 1,
        }),
        // getModel throws by default ('not found')
      });

      const r = await runCommand(buildInfo,
        ['models', 'info', 'qwen3-ma', '--format', 'json']);

      expect(r.exitCode).toBe(1);
      // Errors must go to stderr so Agent pipelines (`cmd | jq`) don't see
      // them mixed into the data stream.
      expect(r.stdout).toBe('');
      const payload = JSON.parse(r.stderr);
      expect(payload.error.code).toBe('MODEL_NOT_FOUND');
      expect(payload.error.message).toContain("Did you mean 'qwen3-max'");
    });

    it('valid model → ModelDetail on stdout, exit 0', async () => {
      const detail = fullDetail('qwen3.6-plus');
      holder.client = makeMockApiClient({
        getModel: async () => detail,
      });

      const r = await runCommand(buildInfo,
        ['models', 'info', 'qwen3.6-plus', '--format', 'json']);

      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      const payload = JSON.parse(r.stdout);
      expect(payload.id).toBe('qwen3.6-plus');
      expect(payload.features).toContain('function-calling');
    });

    it('typo model with no close match → MODEL_NOT_FOUND without suggestion', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({
          models: [makeModel({ id: 'qwen3.6-plus' })],
          total: 1,
        }),
      });

      const r = await runCommand(buildInfo,
        ['models', 'info', 'totally-different-name-zzz', '--format', 'json']);

      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      const payload = JSON.parse(r.stderr);
      expect(payload.error.code).toBe('MODEL_NOT_FOUND');
      expect(payload.error.message).not.toContain('Did you mean');
    });
  });

  describe('text mode', () => {
    it('typo model → "Error: ..." on stderr with did-you-mean, exit 1', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({
          models: [makeModel({ id: 'qwen3-max' })],
          total: 1,
        }),
      });

      const r = await runCommand(buildInfo,
        ['models', 'info', 'qwen3-ma', '--format', 'text']);

      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/Error: Model 'qwen3-ma' not found\. Did you mean 'qwen3-max'\?/);
    });

    it('valid model → renders detail to stdout', async () => {
      holder.client = makeMockApiClient({
        getModel: async () => fullDetail('qwen3.6-plus'),
      });

      const r = await runCommand(buildInfo,
        ['models', 'info', 'qwen3.6-plus', '--format', 'text']);

      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen3.6-plus');
    });
  });
});
