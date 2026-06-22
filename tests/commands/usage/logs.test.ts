/**
 * Command-layer tests for `usage logs`.
 *
 * Coverage targets:
 *   1. `--format json` returns the documented payload shape (totalCount, page,
 *      pageSize, period, items[]).
 *   2. `--format text` renders the human-readable table-like body.
 *   3. `--format table` triggers the Ink renderer with a vm prop.
 *   4. flag forwarding: --from / --to / --period / --model / --status /
 *      --request-id / --page / --page-size flow into the facade call.
 *   5. error path: facade error → exit 1, stderr non-empty.
 *   6. empty result set: JSON has items=[]; text shows the empty hint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

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
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderInteractive: vi.fn(),
  renderWithInkSync: renderWithInkSpy,
}));

const { usageLogsAction, collectRepeatable } = await import(
  '../../../src/commands/usage/logs.js'
);

beforeEach(() => {
  holder.client = makeMockApiClient();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

function buildLogs(program: import('commander').Command) {
  const usage = program.command('usage');
  const logs = usage
    .command('logs')
    .option('--from <date>')
    .option('--to <date>')
    .option('--period <p>')
    .option('--model <id>', '', collectRepeatable, [] as string[])
    .option('--status <type>', '', collectRepeatable, [] as string[])
    .option('--request-id <id>')
    .option('--page <n>', '', (v: string) => parseInt(v, 10))
    .option('--page-size <n>', '', (v: string) => parseInt(v, 10));
  logs.action(usageLogsAction(logs));
}

describe('usage logs command', () => {
  describe('JSON mode', () => {
    it('empty data → returns documented payload structure with items=[], exit 0', async () => {
      const r = await runCommand(buildLogs, ['usage', 'logs', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      const payload = JSON.parse(r.stdout);
      expect(payload).toHaveProperty('totalCount');
      expect(payload).toHaveProperty('page');
      expect(payload).toHaveProperty('pageSize');
      expect(payload).toHaveProperty('period');
      expect(payload).toHaveProperty('items');
      expect(Array.isArray(payload.items)).toBe(true);
    });

    it('with rows → JSON includes documented per-row keys', async () => {
      holder.client = makeMockApiClient({
        getUsageLogs: async () => ({
          totalCount: 1,
          page: 1,
          pageSize: 20,
          period: { from: '2026-05-22T14:00:00.000Z', to: '2026-05-23T14:00:00.000Z' },
          items: [
            {
              requestId: '9f2c6a40-1234-4abc-9def-0000000000a1bd',
              model: 'qwen3.6-plus',
              createdAt: '2026-05-23 14:32:17',
              statusCode: 200,
              durationMs: 1234,
              firstOutputDurationMs: 456,
              errorCode: null,
              usages: [
                { key: 'input', value: 100 },
                { key: 'output', value: 50 },
                { key: 'total', value: 150 },
              ],
            },
          ],
        }),
      });
      const r = await runCommand(buildLogs, ['usage', 'logs', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]).toHaveProperty('requestId');
      expect(payload.items[0]).toHaveProperty('model');
      expect(payload.items[0]).toHaveProperty('statusCode');
      expect(payload.items[0]).toHaveProperty('usages');
    });
  });

  describe('text mode', () => {
    it('with rows → prints the model id and status to stdout, exit 0', async () => {
      holder.client = makeMockApiClient({
        getUsageLogs: async () => ({
          totalCount: 1,
          page: 1,
          pageSize: 20,
          period: { from: '2026-05-22T14:00:00.000Z', to: '2026-05-23T14:00:00.000Z' },
          items: [
            {
              requestId: 'abcd1234',
              model: 'qwen3.6-plus',
              createdAt: '2026-05-23 14:32:17',
              statusCode: 200,
              durationMs: 1234,
              firstOutputDurationMs: 456,
              errorCode: null,
              usages: [
                { key: 'input', value: 100 },
                { key: 'output', value: 50 },
              ],
            },
          ],
        }),
      });
      const r = await runCommand(buildLogs, ['usage', 'logs', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen3.6-plus');
      expect(r.stdout).toContain('200');
    });
  });

  describe('flag forwarding', () => {
    it('forwards --from / --to / --model / --status / --request-id / --page / --page-size', async () => {
      let captured: Record<string, unknown> = {};
      holder.client = makeMockApiClient({
        getUsageLogs: async (opts) => {
          captured = opts as unknown as Record<string, unknown>;
          return {
            totalCount: 0,
            page: opts.page ?? 1,
            pageSize: opts.pageSize ?? 20,
            period: { from: opts.from, to: opts.to },
            items: [],
          };
        },
      });

      const r = await runCommand(buildLogs, [
        'usage', 'logs',
        '--from', '2026-05-22',
        '--to', '2026-05-23',
        '--model', 'qwen3.6-plus',
        '--status', 'CLIENT_ERROR',
        '--status', 'SERVER_ERROR',
        '--request-id', 'abc-123',
        '--page', '3',
        '--page-size', '50',
        '--format', 'json',
      ]);

      expect(r.exitCode).toBeUndefined();
      expect(captured.from).toBe('2026-05-22');
      expect(captured.to).toBe('2026-05-23');
      expect(captured.models).toEqual(['qwen3.6-plus']);
      expect(captured.statusCodeTypes).toEqual(['CLIENT_ERROR', 'SERVER_ERROR']);
      expect(captured.modelRequestId).toBe('abc-123');
      expect(captured.page).toBe(3);
      expect(captured.pageSize).toBe(50);
    });

    it('--period is translated into a from/to range before the facade call', async () => {
      let captured: { from?: string; to?: string } = {};
      holder.client = makeMockApiClient({
        getUsageLogs: async (opts) => {
          captured = { from: opts.from, to: opts.to };
          return {
            totalCount: 0,
            page: 1,
            pageSize: 20,
            period: { from: opts.from, to: opts.to },
            items: [],
          };
        },
      });

      const r = await runCommand(buildLogs, ['usage', 'logs', '--period', '24h', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(typeof captured.from).toBe('string');
      expect(typeof captured.to).toBe('string');
      expect(captured.from).not.toBe('');
      expect(captured.to).not.toBe('');
    });
  });

  describe('Ink rendering (table mode)', () => {
    it('renders a vm prop with rows when --format=table', async () => {
      holder.client = makeMockApiClient({
        getUsageLogs: async () => ({
          totalCount: 2,
          page: 1,
          pageSize: 20,
          period: { from: '2026-05-22T14:00:00.000Z', to: '2026-05-23T14:00:00.000Z' },
          items: [
            {
              requestId: 'abcd1234',
              model: 'qwen3.6-plus',
              createdAt: '2026-05-23 14:32:17',
              statusCode: 200,
              durationMs: 1234,
              firstOutputDurationMs: 456,
              errorCode: null,
              usages: [
                { key: 'input', value: 100 },
                { key: 'output', value: 50 },
              ],
            },
            {
              requestId: 'efgh5678',
              model: 'qwen3.6-plus',
              createdAt: '2026-05-23 14:33:01',
              statusCode: 429,
              durationMs: 80,
              firstOutputDurationMs: 0,
              errorCode: 'Throttling.User',
              usages: [],
            },
          ],
        }),
      });
      const r = await runCommand(buildLogs, ['usage', 'logs', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const el = renderWithInkSpy.mock.calls[0][0];
      expect(el.props.vm.items).toHaveLength(2);
      expect(el.props.vm.totalCount).toBe(2);
    });
  });

  describe('error path', () => {
    it('facade throws → exit 1, error to stderr', async () => {
      holder.client = makeMockApiClient({
        getUsageLogs: async () => {
          throw new Error('upstream timeout');
        },
      });
      const r = await runCommand(buildLogs, ['usage', 'logs', '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('upstream timeout');
    });
  });

  describe('14-day time range limit', () => {
    it('default 7 days → passes validation', async () => {
      const r = await runCommand(buildLogs, ['usage', 'logs', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
    });

    it('--from/--to spanning exactly 14 days → passes validation', async () => {
      const r = await runCommand(buildLogs, [
        'usage', 'logs',
        '--from', '2026-06-01',
        '--to', '2026-06-15',
        '--format', 'json',
      ]);
      expect(r.exitCode).toBeUndefined();
    });

    it('--from/--to spanning more than 14 days → exits with error', async () => {
      const r = await runCommand(buildLogs, [
        'usage', 'logs',
        '--from', '2026-06-01',
        '--to', '2026-06-16',
        '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain('Time range cannot be longer than 14 days.');
    });

    it('--period 14d → passes validation', async () => {
      const r = await runCommand(buildLogs, [
        'usage', 'logs',
        '--period', '14d',
        '--format', 'json',
      ]);
      expect(r.exitCode).toBeUndefined();
    });

    it('--period 15d → exits with error', async () => {
      const r = await runCommand(buildLogs, [
        'usage', 'logs',
        '--period', '15d',
        '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain('Time range cannot be longer than 14 days.');
    });
  });
});
