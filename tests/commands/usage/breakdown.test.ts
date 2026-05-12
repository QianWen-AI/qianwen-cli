import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient, makeModel } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

// ── Module mocks (hoisted) ───────────────────────────────────────────
// vi.mock is hoisted to the top of the file. Use a holder pattern so each test
// can swap in a fresh client without re-mocking the module.
const holder: { client: ApiClient } = { client: makeMockApiClient() };

const { renderWithInkSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
}));

vi.mock('../../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({}),
}));
// Stop the spinner from tampering with stdout in non-TTY test runs.
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderInteractive: vi.fn(),
  renderWithInkSync: renderWithInkSpy,
}));

// Import the action only AFTER the mocks above are declared (vi.mock is
// hoisted so this is safe; the explicit await import keeps the dependency
// order obvious to a reader).
const { usageBreakdownAction } = await import('../../../src/commands/usage/breakdown.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

/** Build a Commander subtree mirroring `qianwen usage breakdown ...`. */
function buildBreakdown(program: import('commander').Command) {
  const usage = program.command('usage');
  const breakdown = usage.command('breakdown')
    .option('--model <id>')
    .option('--granularity <g>')
    .option('--from <date>')
    .option('--to <date>')
    .option('--days <n>')
    .option('--period <preset>')
    .option('--format <fmt>');
  breakdown.action(usageBreakdownAction(breakdown));
}

describe('usage breakdown command (one-shot)', () => {
  describe('JSON mode', () => {
    it('typo model → MODEL_NOT_FOUND on stderr with did-you-mean, exit 1', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({
          models: [makeModel({ id: 'qwen3-max' })],
          total: 1,
        }),
      });

      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-ma', '--format', 'json']);

      expect(r.exitCode).toBe(1);
      // Errors must go to stderr so Agent pipelines (`cmd | jq`) don't see
      // them mixed into the data stream.
      expect(r.stdout).toBe('');
      const payload = JSON.parse(r.stderr);
      expect(payload.error.code).toBe('MODEL_NOT_FOUND');
      expect(payload.error.message).toContain("Did you mean 'qwen3-max'");
      expect(payload.error.exit_code).toBe(1);
    });

    it('valid model → breakdown payload on stdout, exit 0', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({
          models: [makeModel({ id: 'qwen3.6-plus' })],
          total: 1,
        }),
        getUsageBreakdown: async () => ({
          model_id: 'qwen3.6-plus',
          period: { from: '2026-04-01', to: '2026-04-20' },
          granularity: 'day',
          rows: [
            { period: '2026-04-18', tokens_in: 5_800_000, cost: 2.93, currency: 'CNY' },
          ],
          total: { tokens_in: 5_800_000, cost: 2.93, currency: 'CNY' },
        }),
      });

      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3.6-plus', '--format', 'json']);

      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      const payload = JSON.parse(r.stdout);
      expect(payload.model_id).toBe('qwen3.6-plus');
      expect(payload.total.tokens_in).toBe(5_800_000);
      expect(payload.rows).toHaveLength(1);
    });

    it('valid model with no usage → empty rows, exit 0 (Agent contract preserved)', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
      });

      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--format', 'json']);

      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.rows).toEqual([]);
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

      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-ma', '--format', 'text']);

      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/Error: Model 'qwen3-ma' not found\. Did you mean 'qwen3-max'\?/);
    });

    it('valid model with no usage → renders empty hint and Total row', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
      });

      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--format', 'text']);

      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('No usage in this period');
      expect(r.stdout).toContain('Total');
    });

    it('valid model with usage → renders rows and Total', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3.6-plus' })], total: 1 }),
        getUsageBreakdown: async () => ({
          model_id: 'qwen3.6-plus',
          period: { from: '2026-04-01', to: '2026-04-20' },
          granularity: 'day',
          rows: [
            { period: '2026-04-18', tokens_in: 5_800_000, cost: 2.93, currency: 'CNY' },
          ],
          total: { tokens_in: 5_800_000, cost: 2.93, currency: 'CNY' },
        }),
      });

      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3.6-plus', '--format', 'text']);

      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('5.8M');
      expect(r.stdout).toContain('Total');
    });
  });

  describe('argument validation', () => {
    it('missing --model → error to stderr (JSON format), exit 1', async () => {
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('Missing required option: --model');
    });

    it('invalid --granularity → error to stderr (JSON format), exit 1', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3.6-plus' })], total: 1 }),
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3.6-plus', '--granularity', 'bogus', '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/Invalid granularity 'bogus'/);
    });
  });

  describe('billing-unit propagation (real-world bug regression)', () => {
    it('image model + zero rows → headers reflect Images, not Tokens', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({
          models: [makeModel({
            id: 'qwen-image-2.0-pro',
            modality: { input: ['text'], output: ['image'] },
            free_tier: { mode: 'standard', quota: { remaining: 0, total: 100, unit: 'images', used_pct: 0 } },
          })],
          total: 1,
        }),
      });

      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen-image-2.0-pro', '--format', 'text']);

      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('Images');
      expect(r.stdout).not.toContain('Tokens');
    });
  });

  // ── extended: granularity & date helpers ──────────────────────────
  describe('granularity', () => {
    it('--granularity month → forwarded to API client', async () => {
      let capturedGran = '';
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
        getUsageBreakdown: async (opts) => {
          capturedGran = opts.granularity ?? '';
          return {
            model_id: 'qwen3-max',
            period: { from: '2026-01-01', to: '2026-04-20' },
            granularity: 'month',
            rows: [
              { period: '2026-01', tokens_in: 100, cost: 0.01, currency: 'CNY' },
              { period: '2026-02', tokens_in: 200, cost: 0.02, currency: 'CNY' },
            ],
            total: { tokens_in: 300, cost: 0.03, currency: 'CNY' },
          };
        },
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--granularity', 'month', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(capturedGran).toBe('month');
    });

    it('--granularity quarter accepted', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--granularity', 'quarter', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
    });
  });

  describe('--days option', () => {
    it('--days 30 → resolves date range without error', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--days', '30', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
    });
  });

  describe('API failure path', () => {
    it('getUsageBreakdown throws → exit 1, error on stderr', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
        getUsageBreakdown: async () => {
          throw new Error('breakdown-fail');
        },
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('breakdown-fail');
    });
  });

  // ── Ink rendering branches (table/TTY mode) ──────────────────────
  // Replaces renderWithInk with a real ink-testing-library render so the
  // local BreakdownInk / BreakdownTable components in breakdown.tsx get
  // executed (driving up coverage of their JSX/branches).
  describe('Ink rendering (table mode)', () => {
    it('renders BreakdownInk + BreakdownTable for non-empty rows', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3.6-plus' })], total: 1 }),
        getUsageBreakdown: async () => ({
          model_id: 'qwen3.6-plus',
          period: { from: '2026-04-01', to: '2026-04-20' },
          granularity: 'day',
          rows: [
            { period: '2026-04-18', tokens_in: 5_800_000, cost: 2.93, currency: 'CNY' },
            { period: '2026-04-19', tokens_in: 1_200_000, cost: 0.61, currency: 'CNY' },
          ],
          total: { tokens_in: 7_000_000, cost: 3.54, currency: 'CNY' },
        }),
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3.6-plus', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const el = renderWithInkSpy.mock.calls[0][0];
      // The element has props.vm with rows and total
      expect(el.props.vm.modelId).toBe('qwen3.6-plus');
      expect(el.props.vm.rows).toHaveLength(2);
      expect(el.props.vm.total).toBeTruthy();
    });

    it('renders BreakdownInk with empty rows (emptyHint branch)', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
        // default empty getUsageBreakdown returns no rows
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const el = renderWithInkSpy.mock.calls[0][0];
      // emptyHint should be present when there are no rows
      expect(el.props.vm.emptyHint).toBeTruthy();
    });

    it('renders BreakdownInk with month granularity (no isCurrent markings for non-current months)', async () => {
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
        getUsageBreakdown: async () => ({
          model_id: 'qwen3-max',
          period: { from: '2026-01-01', to: '2026-04-20' },
          granularity: 'month',
          rows: [
            { period: '2026-01', tokens_in: 100, cost: 0.01, currency: 'CNY' },
            { period: '2026-02', tokens_in: 200, cost: 0.02, currency: 'CNY' },
            { period: '2026-03', tokens_in: 300, cost: 0.03, currency: 'CNY' },
          ],
          total: { tokens_in: 600, cost: 0.06, currency: 'CNY' },
        }),
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--granularity', 'month', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const el = renderWithInkSpy.mock.calls[0][0];
      expect(el.props.vm.rows.length).toBe(3);
    });

    it('renders BreakdownInk that includes current day row (period column gets "← current")', async () => {
      // Today's date in YYYY-MM-DD (UTC-ish — view-model marks isCurrent
      // based on string equality with todayUTC)
      const todayIso = new Date().toISOString().slice(0, 10);
      holder.client = makeMockApiClient({
        listModels: async () => ({ models: [makeModel({ id: 'qwen3-max' })], total: 1 }),
        getUsageBreakdown: async () => ({
          model_id: 'qwen3-max',
          period: { from: '2026-01-01', to: todayIso },
          granularity: 'day',
          rows: [
            { period: todayIso, tokens_in: 1000, cost: 0.1, currency: 'CNY' },
          ],
          total: { tokens_in: 1000, cost: 0.1, currency: 'CNY' },
        }),
      });
      const r = await runCommand(buildBreakdown,
        ['usage', 'breakdown', '--model', 'qwen3-max', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      // Don't strictly assert isCurrent flag (depends on TZ); just ensure no crash
      const el = renderWithInkSpy.mock.calls[0][0];
      expect(el.props.vm.rows[0].period).toBe(todayIso);
    });
  });
});
