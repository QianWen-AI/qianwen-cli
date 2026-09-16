/**
 * Command-layer tests for `yunqi list` argument validation.
 *
 * These exercise the real Commander wiring through runCommand, substituting
 * only the service factory boundary, so the assertions cover what a user's
 * argv actually turns into at the service call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const calls: {
  listForums: unknown[];
  listExhibitors: unknown[];
  listMyForumSubscriptions: number;
  listForumSummaries: unknown[];
} = {
  listForums: [],
  listExhibitors: [],
  listMyForumSubscriptions: 0,
  listForumSummaries: [],
};

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: vi.fn(() => ({})),
}));
vi.mock('../../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({}),
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: vi.fn(async () => {}),
  renderWithInkSync: vi.fn(),
  renderInteractive: vi.fn(async () => {}),
}));

const { registerYunqiCommands } = await import('../../../src/commands/yunqi/index.js');

function build(program: import('commander').Command) {
  registerYunqiCommands(program);
}

beforeEach(() => {
  calls.listForums = [];
  calls.listExhibitors = [];
  calls.listMyForumSubscriptions = 0;
  calls.listForumSummaries = [];
  holder.services = makeMockServices({
    yunqiService: {
      listForums: async (opts: unknown) => {
        calls.listForums.push(opts);
        return { forums: [], page: 1, pageSize: 20, total: 0 };
      },
      listExhibitors: async (opts: unknown) => {
        calls.listExhibitors.push(opts);
        return { exhibitors: [], page: 1, pageSize: 20, total: 0 };
      },
      listMyForumSubscriptions: async () => {
        calls.listMyForumSubscriptions += 1;
        return {
          subscriptions: [],
          notStartedCount: 0,
          inProgressCount: 0,
          summaryPreparingCount: 0,
          summaryReadyCount: 0,
          unviewedCount: 0,
        };
      },
      listForumSummaries: async (forumId: unknown) => {
        calls.listForumSummaries.push(forumId);
        return [];
      },
    },
  });
});

function errorCode(stderr: string): string {
  return JSON.parse(stderr).error.code as string;
}

describe('yunqi list — pagination argument validation', () => {
  it.each(['abc', '', '0', '-1'])(
    '--page %s is rejected and never reaches the service layer',
    async (page) => {
      const r = await runCommand(build, [
        'yunqi',
        'list',
        'forums',
        '--page',
        page,
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBe(1);
      expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
      expect(calls.listForums).toHaveLength(0);
    },
  );

  it('--page-size is rejected the same way when malformed', async () => {
    const r = await runCommand(build, [
      'yunqi',
      'list',
      'forums',
      '--page-size',
      'xyz',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
    expect(calls.listForums).toHaveLength(0);
  });

  it('valid pagination arguments reach the service layer unchanged', async () => {
    const r = await runCommand(build, [
      'yunqi',
      'list',
      'forums',
      '--page',
      '3',
      '--page-size',
      '50',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(calls.listForums[0]).toMatchObject({ page: 3, pageSize: 50 });
  });
});

describe('yunqi list — --enabled validation', () => {
  it.each(['yes', '1', 'treu', 'true-ish'])(
    '--enabled %s is rejected and never reaches the service layer',
    async (value) => {
      const r = await runCommand(build, [
        'yunqi',
        'list',
        'exhibitors',
        '--enabled',
        value,
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBe(1);
      expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
      expect(calls.listExhibitors).toHaveLength(0);
    },
  );

  it.each(['true', 'TRUE', 'True'])('--enabled %s is normalized to boolean true', async (value) => {
    await runCommand(build, [
      'yunqi',
      'list',
      'exhibitors',
      '--enabled',
      value,
      '--format',
      'json',
    ]);
    expect(calls.listExhibitors[0]).toMatchObject({ enabled: true });
  });

  it('--enabled false is normalized to boolean false instead of being dropped', async () => {
    await runCommand(build, [
      'yunqi',
      'list',
      'exhibitors',
      '--enabled',
      'false',
      '--format',
      'json',
    ]);
    expect(calls.listExhibitors[0]).toMatchObject({ enabled: false });
  });

  it('the field stays undefined when --enabled is omitted', async () => {
    await runCommand(build, ['yunqi', 'list', 'exhibitors', '--format', 'json']);
    expect((calls.listExhibitors[0] as { enabled?: unknown }).enabled).toBeUndefined();
  });
});

describe('yunqi list — resource and flag compatibility validation', () => {
  it('an unknown resource name is rejected and reaches no service method', async () => {
    const r = await runCommand(build, ['yunqi', 'list', 'typo', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
    expect(r.stderr).toContain("Unknown resource 'typo'");
    expect(calls.listForums).toHaveLength(0);
    expect(calls.listExhibitors).toHaveLength(0);
  });

  it('omitting the resource name defaults to forums', async () => {
    const r = await runCommand(build, ['yunqi', 'list', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls.listForums).toHaveLength(1);
  });

  it.each(['--enabled', '--hall-name'])('forums rejects the exhibitor-only %s', async (flag) => {
    const r = await runCommand(build, [
      'yunqi',
      'list',
      'forums',
      flag,
      'true',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
    expect(r.stderr).toContain("cannot be used with 'yunqi list forums'");
    expect(calls.listForums).toHaveLength(0);
  });

  it.each(['--theme-name', '--forum-id', '--guest-name'])(
    'exhibitors rejects the forum-only %s',
    async (flag) => {
      const r = await runCommand(build, [
        'yunqi',
        'list',
        'exhibitors',
        flag,
        'x',
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBe(1);
      expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
      expect(r.stderr).toContain("cannot be used with 'yunqi list exhibitors'");
      expect(calls.listExhibitors).toHaveLength(0);
    },
  );

  it.each(['--page', '--page-size', '--keyword', '--enabled'])(
    'subscriptions rejects the business parameter %s',
    async (flag) => {
      const r = await runCommand(build, [
        'yunqi',
        'list',
        'subscriptions',
        flag,
        '2',
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBe(1);
      expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
      expect(calls.listMyForumSubscriptions).toBe(0);
    },
  );

  it.each(['--page', '--keyword', '--enabled'])(
    'summaries accepts only --forum-id and rejects %s',
    async (flag) => {
      const r = await runCommand(build, [
        'yunqi',
        'list',
        'summaries',
        flag,
        '2',
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBe(1);
      expect(errorCode(r.stderr)).toBe('INVALID_ARGUMENT');
      expect(calls.listForumSummaries).toHaveLength(0);
    },
  );

  it('summaries accepts --forum-id and passes it through', async () => {
    const r = await runCommand(build, [
      'yunqi',
      'list',
      'summaries',
      '--forum-id',
      'F-9',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(calls.listForumSummaries).toEqual(['F-9']);
  });

  it('subscriptions runs normally when no business parameter is given', async () => {
    const r = await runCommand(build, ['yunqi', 'list', 'subscriptions', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls.listMyForumSubscriptions).toBe(1);
  });

  it.each(['forums', 'exhibitors'])(
    '--keyword, shared by both resources, is accepted on %s',
    async (res) => {
      const r = await runCommand(build, [
        'yunqi',
        'list',
        res,
        '--keyword',
        'AI',
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBeUndefined();
      const recorded = res === 'forums' ? calls.listForums : calls.listExhibitors;
      expect(recorded[0]).toMatchObject({ keyword: 'AI' });
    },
  );

  it('--format is accepted for every resource', async () => {
    for (const res of ['forums', 'exhibitors', 'subscriptions', 'summaries']) {
      const r = await runCommand(build, ['yunqi', 'list', res, '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
    }
  });

  it('inapplicable flags and malformed flags go through the same error channel', async () => {
    // N3: --enabled yes used to be silently coerced to false, and a well-formed
    // --enabled true on forums was silently ignored. Both now surface as errors.
    const malformed = await runCommand(build, [
      'yunqi',
      'list',
      'exhibitors',
      '--enabled',
      'yes',
      '--format',
      'json',
    ]);
    const inapplicable = await runCommand(build, [
      'yunqi',
      'list',
      'forums',
      '--enabled',
      'true',
      '--format',
      'json',
    ]);
    expect(errorCode(malformed.stderr)).toBe('INVALID_ARGUMENT');
    expect(errorCode(inapplicable.stderr)).toBe('INVALID_ARGUMENT');
    expect(malformed.exitCode).toBe(inapplicable.exitCode);
  });
});

describe('yunqi list exhibitors — JSON contract', () => {
  it('原样透出嵌套 exhibits，不含表格派生字段，且长文案不被截断', async () => {
    const longDescription = 'D'.repeat(200);
    holder.services = makeMockServices({
      yunqiService: {
        listExhibitors: async () => ({
          exhibitors: [
            {
              exhibits: [
                {
                  exhibitId: 'X-1',
                  exhibitCode: 'C-1',
                  name: '通义千问',
                  description: longDescription,
                  hall: { code: 'H1', name: '1号馆' },
                  zone: { code: 'Z1', name: '云智能展区' },
                  booth: { code: 'B12', name: 'A12' },
                },
                { exhibitId: 'X-2' },
              ],
              extJson: '{"k":"v"}',
            },
          ],
          page: 1,
          pageSize: 20,
          total: 634,
        }),
      },
    });

    const r = await runCommand(build, ['yunqi', 'list', 'exhibitors', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const json = JSON.parse(r.stdout);

    // An item is only a container: no identity fields, and none of the
    // view-model's joined hall/zone/booth strings may leak in (C-022).
    expect(Object.keys(json.exhibitors[0]).sort()).toEqual(['exhibits', 'extJson']);
    expect(json.exhibitors[0].exhibits).toHaveLength(2);
    expect(json.exhibitors[0].exhibits[0].hall).toEqual({ code: 'H1', name: '1号馆' });
    expect(json.exhibitors[0].exhibits[0].booth).toEqual({ code: 'B12', name: 'A12' });
    // JSON bypasses the view-model, so the description survives untruncated (C-017).
    expect(json.exhibitors[0].exhibits[0].description).toBe(longDescription);
    expect(json).toMatchObject({ page: 1, pageSize: 20, total: 634 });
  });
});
