import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import { teamWithSeatDetails } from '../../helpers/tokenplan-status.js';
import { resolveTokenPlanSeatAssignments } from '../../../src/services/tokenplan-seat-details.js';
import { formatSubscriptionStatusJson } from '../../../src/view-models/subscription/shared.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SubscriptionStatusResult } from '../../../src/types/subscription.js';
import type {
  ListTokenPlanSeatsParams,
  TokenPlanSeatsResult,
  TokenPlanStatusResult,
} from '../../../src/types/tokenplan-subscription.js';
import {
  renderInkForTest,
  clearRenderedFrames,
  lastRenderedFrame,
} from '../../helpers/ink-render-mock.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { ensureAuthenticatedSpy, renderWithInkSpy } = vi.hoisted(() => ({
  ensureAuthenticatedSpy: vi.fn(() => ({})),
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
}));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: ensureAuthenticatedSpy,
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

const { subscriptionStatusAction } = await import('../../../src/commands/subscription/status.js');
const { subscriptionTokenPlanStatusAction } =
  await import('../../../src/commands/subscription/tokenplan/status.js');
const { subscriptionTokenPlanSeatsAction } =
  await import('../../../src/commands/subscription/tokenplan/seats.js');

function build(program: import('commander').Command) {
  const sub = program.command('subscription');
  const status = sub.command('status').option('--plan <kind>').option('--format <fmt>');
  status.action(subscriptionStatusAction(status));
}

function buildTokenPlan(program: import('commander').Command) {
  const sub = program.command('subscription');
  const tokenplan = sub.command('tokenplan');
  const status = tokenplan.command('status').option('--format <fmt>');
  status.action(subscriptionTokenPlanStatusAction(status));
  const seats = tokenplan.command('seats');
  seats.action(subscriptionTokenPlanSeatsAction(seats));
}

beforeEach(() => {
  holder.services = makeMockServices();
  ensureAuthenticatedSpy.mockClear();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

afterEach(() => vi.unstubAllEnvs());

const sampleResult: SubscriptionStatusResult = {
  data: {
    isGray: true,
    plan: 'token-basic',
    period: { start: '2026-04-01', end: '2026-05-01' },
    quota: { remaining: 500_000, total: 1_000_000, usedPct: 50 },
    autoRenew: true,
    renewable: true,
  },
  diagnostics: [],
};

describe('subscription status command', () => {
  it('JSON returns the SubscriptionStatusResult', async () => {
    const spy = vi.fn(async () => sampleResult);
    holder.services = makeMockServices({
      subscriptionService: { getStatus: spy },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.plan).toBe('token-basic');
    expect(payload.period).toEqual(sampleResult.data!.period);
    expect(payload.diagnostics).toEqual([]);
    expect(spy).toHaveBeenCalledWith({});
  });

  it('passes --plan token through to the service', async () => {
    const spy = vi.fn(async () => sampleResult);
    holder.services = makeMockServices({
      subscriptionService: { getStatus: spy },
    });
    await runCommand(build, ['subscription', 'status', '--plan', 'token', '--format', 'json']);
    expect(spy).toHaveBeenCalledWith({ plan: 'token' });
  });

  it('rejects unknown --plan values before authentication or service calls', async () => {
    const spy = vi.fn(async () => sampleResult);
    holder.services = makeMockServices({
      subscriptionService: { getStatus: spy },
    });
    const r = await runCommand(build, [
      'subscription',
      'status',
      '--plan',
      'enterprise',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 'INVALID_ARGUMENT',
        message: '--plan must be token.',
        exit_code: 1,
      },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(ensureAuthenticatedSpy).not.toHaveBeenCalled();
  });

  it('JSON exits 1 when data is null (no subscription)', async () => {
    holder.services = makeMockServices({
      subscriptionService: {
        getStatus: async () => ({ data: null, diagnostics: [] }),
      },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stdout);
    expect(payload.data).toBeNull();
  });

  it('text mode groups edition status, team usage, and Token Plan orders', async () => {
    const textResult: SubscriptionStatusResult = {
      data: {
        ...sampleResult.data!,
        individual: {
          edition: 'individual',
          commodityCode: 'sfm_tokenplansolo_public_cn',
          status: 'not_subscribed',
          type: null,
          name: null,
          specCode: null,
          period: null,
          remainingDays: null,
          autoRenew: null,
          seatSummary: null,
          completeness: 'complete',
          diagnostics: [],
        },
        team: {
          edition: 'team',
          commodityCode: 'sfm_tokenplanteams_dp_cn',
          status: 'active',
          type: 'token_plan_team',
          name: 'Token Plan Team Edition',
          specCode: null,
          period: {
            start: '2026-07-27T11:00:00.000Z',
            end: '2026-09-27T11:00:00.000Z',
            remainingDays: 12,
          },
          remainingDays: 12,
          autoRenew: { enabled: false, period: null, periodUnit: null },
          seatSummary: null,
          completeness: 'complete',
          diagnostics: [],
        },
        seatTiers: [
          {
            specType: 'standard',
            seats: 2,
            totalCredits: 50_000,
            remainingCredits: 44_982,
            usedPct: 10.036,
            nextCycleFlushTime: null,
          },
        ],
        creditPacks: [],
        recentOrders: [
          {
            orderId: 'order-1',
            orderType: 'purchase',
            orderTime: '2026-07-27T11:00:00.000Z',
            amount: '150.00',
            status: 'PAID',
          },
        ],
      },
      diagnostics: [],
    };
    holder.services = makeMockServices({
      subscriptionService: { getStatus: async () => textResult },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Token Plans');
    expect(r.stdout).toMatch(/Name\s+Token Plan Individual Edition/);
    expect(r.stdout).toContain('Seat Usage');
    expect(r.stdout).toContain('Recent Token Plan Orders (latest 1)');
    expect(r.stdout).not.toContain('Account');
    expect(r.stdout).not.toContain('Expires:');
    expect(r.stdout.match(/Status\s+active/g)).toHaveLength(1);
  });

  it('table mode invokes renderWithInk', async () => {
    holder.services = makeMockServices({
      subscriptionService: { getStatus: async () => sampleResult },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});

describe('subscription tokenplan status command', () => {
  it.each(['UTC', 'Asia/Shanghai', 'America/Los_Angeles'])(
    'both status commands normalize JSON timestamps and individual credits when the host timezone is %s',
    async (timezone) => {
      vi.stubEnv('TZ', timezone);
      const utc = '2026-12-31T16:00:00.123Z';
      const shanghai = '2027-01-01T00:00:00.123+08:00';
      const period = { start: utc, end: shanghai, remainingDays: 1 };
      const team = teamWithSeatDetails();
      team.period = period;
      team.seatSummary!.groups[0].nextCycleFlushTime = utc;
      team.weeklyCredits = { total: null, used: null, remaining: null, resetTime: null };
      const individual = {
        ...team,
        edition: 'individual' as const,
        seatSummary: null,
        seatDetails: undefined,
        monthlyCredits: { total: 1000, used: null, remaining: null, usedPct: 25, resetTime: utc },
        weeklyCredits: {
          total: 1000,
          used: 0,
          remaining: 1000,
          usedPct: 0,
          resetTime: shanghai,
        },
      };
      const dedicatedResult: TokenPlanStatusResult = {
        individual,
        team,
        product: 'Token Plan',
        period,
        autoRenew: null,
        renewable: null,
        seatSummary: team.seatSummary,
        diagnostics: [],
      };
      const generalResult: SubscriptionStatusResult = {
        data: {
          ...sampleResult.data!,
          individual,
          team,
          period,
          seatTiers: [
            {
              specType: 'standard',
              seats: 1,
              totalCredits: 1000,
              remainingCredits: 750,
              usedPct: 25,
              nextCycleFlushTime: utc,
            },
          ],
          creditPacks: [
            { instanceId: 'pack-1', totalCredits: 1000, remainingCredits: 750, expiresAt: utc },
          ],
          recentOrders: [
            { orderId: utc, orderTime: utc, orderType: 'purchase', amount: '1.23', status: 'PAID' },
          ],
        },
        diagnostics: [],
      };
      const before = structuredClone({ dedicatedResult, generalResult });
      holder.services = makeMockServices({
        subscriptionTokenPlanService: { getTokenPlanStatus: async () => dedicatedResult },
        subscriptionService: { getStatus: async () => generalResult },
      });
      for (const dedicated of [true, false]) {
        const output = await runCommand(dedicated ? buildTokenPlan : build, [
          'subscription',
          ...(dedicated ? ['tokenplan'] : []),
          'status',
          '--format',
          'json',
        ]);
        expect(output.exitCode).toBeUndefined();
        expect(output.stderr).toBe('');
        const data = JSON.parse(output.stdout);
        expect(data.period).toEqual({ start: shanghai, end: shanghai, remainingDays: 1 });
        for (const edition of [data.individual, data.team]) {
          expect(edition.period).toEqual(data.period);
        }
        expect(data.individual.monthlyCredits).toEqual({
          total: 1000,
          usedPct: 25,
          resetTime: shanghai,
        });
        expect(data.individual.weeklyCredits).toEqual({
          total: 1000,
          used: 0,
          remaining: 1000,
          usedPct: 0,
          resetTime: shanghai,
        });
        expect(data.team.weeklyCredits).toEqual(team.weeklyCredits);
        expect(Date.parse(data.individual.monthlyCredits.resetTime)).toBe(Date.parse(utc));
        expect(data.team.seatSummary.groups[0].nextCycleFlushTime).toBe(shanghai);
        expect(data.team.seatSummary.groups[1].nextCycleFlushTime).toBeNull();
        expect(data.team.seatDetails).toEqual(team.seatDetails);
        if (dedicated) {
          expect(data.seatSummary).toEqual(data.team.seatSummary);
        } else {
          expect(data.seatTiers[0].nextCycleFlushTime).toBe(shanghai);
          expect(data.creditPacks[0].expiresAt).toBe(shanghai);
          expect(data.recentOrders[0].orderTime).toBe(shanghai);
          expect(data.recentOrders[0].orderId).toBe(utc);
          expect(data.recentOrders[0].amount).toBe('1.23');
        }
      }
      expect({ dedicatedResult, generalResult }).toEqual(before);
    },
  );

  it('omits null individual credit windows and preserves other unknown status fields', async () => {
    expect(
      formatSubscriptionStatusJson({
        individual: {
          edition: 'individual',
          monthlyCredits: null,
          weeklyCredits: null,
          autoRenew: null,
        },
        team: { edition: 'team', monthlyCredits: null, weeklyCredits: null },
      }),
    ).toEqual({
      individual: { edition: 'individual', autoRenew: null },
      team: { edition: 'team', monthlyCredits: null, weeklyCredits: null },
    });
    const team = teamWithSeatDetails();
    team.period = { start: '2026-10-21', end: '2026-10-22T00:00:00', remainingDays: null };
    team.seatSummary!.groups[0].nextCycleFlushTime = 'unconfirmed';
    team.weeklyCredits = { total: null, used: null, remaining: null, resetTime: null };
    const result: TokenPlanStatusResult = {
      team,
      product: 'Token Plan',
      period: null,
      autoRenew: null,
      renewable: null,
      seatSummary: team.seatSummary,
      diagnostics: [],
    };
    holder.services = makeMockServices({
      subscriptionTokenPlanService: { getTokenPlanStatus: async () => result },
    });
    const output = await runCommand(buildTokenPlan, [
      'subscription',
      'tokenplan',
      'status',
      '--format',
      'json',
    ]);
    expect(output.exitCode).toBeUndefined();
    const data = JSON.parse(output.stdout);
    expect(data).not.toHaveProperty('individual');
    expect(data.team).toEqual(team);
    expect(data.period).toBeNull();
  });

  it.each(['json', 'text', 'table'])(
    'both status commands warn about mismatched seat counts in %s without hiding known data',
    async (format) => {
      for (const count of [0, 2]) {
        const team = teamWithSeatDetails();
        team.seatDetails!.items = team.seatDetails!.items.slice(0, count);
        team.seatDetails!.fetchedCount = team.seatDetails!.totalCount = count;
        team.seatDetails = resolveTokenPlanSeatAssignments(team.seatDetails, team);
        const diagnostics = team.seatDetails!.diagnostics;
        holder.services = makeMockServices({
          subscriptionTokenPlanService: {
            getTokenPlanStatus: async () => ({
              team,
              product: 'Token Plan',
              period: null,
              autoRenew: null,
              renewable: null,
              seatSummary: team.seatSummary,
              diagnostics,
            }),
          },
          subscriptionService: {
            getStatus: async () => ({
              data: { ...sampleResult.data!, team },
              diagnostics,
            }),
          },
        });

        for (const dedicated of [true, false]) {
          clearRenderedFrames();
          const result = await runCommand(dedicated ? buildTokenPlan : build, [
            'subscription',
            ...(dedicated ? ['tokenplan'] : []),
            'status',
            '--format',
            format,
          ]);
          expect(result.exitCode).toBeUndefined();
          if (format === 'json') {
            const data = JSON.parse(result.stdout);
            expect(data.team.status).toBe('active');
            expect(data.team.seatSummary).toEqual(team.seatSummary);
            expect(data.team.seatDetails).toMatchObject({
              items: team.seatDetails!.items,
              collectionCompleteness: 'complete',
              completeness: 'partial',
              diagnostics,
            });
            expect(data.diagnostics).toContainEqual(
              expect.objectContaining({ errorCode: 'SeatSummaryMismatch' }),
            );
          } else {
            const output = format === 'text' ? result.stdout : lastRenderedFrame()!;
            expect(output).toContain('3 total · 2 assigned · 1 unassigned');
            const warning = 'Seat details do not match the seat summary. Please try again later.';
            expect(output.split(warning)).toHaveLength(2);
            expect(output).not.toContain('No current seats.');
            if (count > 0) {
              expect(output).toContain('subs-standard-0123456789abcdef');
              expect(output).toContain('20,000 / 25,000');
            }
          }
        }
      }
    },
  );

  it.each(['json', 'text', 'table'])(
    'both status commands expose allocation and seat details in %s',
    async (format) => {
      const team = teamWithSeatDetails();
      team.seatDetails!.historicalCount = 15;
      team.seatDetails!.fetchedCount = team.seatDetails!.totalCount = 18;
      const result: TokenPlanStatusResult = {
        team,
        product: 'Token Plan Team Edition',
        period: null,
        autoRenew: null,
        renewable: null,
        seatSummary: team.seatSummary,
        diagnostics: [],
      };
      holder.services = makeMockServices({
        subscriptionTokenPlanService: { getTokenPlanStatus: async () => result },
        subscriptionService: {
          getStatus: async () => ({ ...sampleResult, data: { ...sampleResult.data!, team } }),
        },
      });
      for (const dedicated of [true, false]) {
        clearRenderedFrames();
        const output = await runCommand(dedicated ? buildTokenPlan : build, [
          'subscription',
          ...(dedicated ? ['tokenplan'] : []),
          'status',
          '--format',
          format,
        ]);
        expect(output.exitCode).toBeUndefined();
        if (format === 'json') {
          const parsed = JSON.parse(output.stdout);
          expect(parsed.team.seatDetails).toEqual(team.seatDetails);
          expect(parsed.team.seatSummary).toEqual(team.seatSummary);
        } else {
          const text = format === 'text' ? output.stdout : lastRenderedFrame()!;
          expect(text).toContain('3 total · 2 assigned · 1 unassigned');
          expect(text).toContain(dedicated ? 'SEAT DETAILS' : 'Seat Details');
          expect(text).toContain('subs-standard-0123456789abcdef');
          expect(text).toContain('20,000 / 25,000');
          expect(text).toContain(dedicated ? 'unassigned' : 'Unassigned');
          if (dedicated) {
            expect(text).toContain('SEAT SUMMARY');
            expect(text).toMatch(/SEAT TYPE\s+QUANTITY/);
            expect(text).toMatch(/Standard Seat\s+2/);
            expect(text).toContain('CREDITS (REMAINING / TOTAL)');
            expect(text.indexOf('15 historical seats hidden.')).toBeGreaterThan(
              text.indexOf('subs-standard-0123456789abcdef'),
            );
          }
          expect(text).toContain('15 historical seats hidden.');
          expect(text).not.toMatch(/Refunded|Incomplete|Try again/);
        }
      }
    },
  );

  it.each([null, '2026-11-01T00:00:00.000Z'])(
    'renders only seat types and quantities with next cycle %s in text output',
    async (nextCycleFlushTime) => {
      const result: TokenPlanStatusResult = {
        product: 'Token Plan Team Edition',
        period: null,
        autoRenew: null,
        renewable: null,
        diagnostics: [],
        seatSummary: {
          groups: [
            {
              specType: 'standard',
              seats: 1,
              assigned: null,
              totalValue: '25000',
              surplusValue: '25000',
              unit: 'Credits',
              nextCycleFlushTime,
            },
          ],
          total: { seats: 1, totalValue: '25000', surplusValue: '25000', unit: 'Credits' },
        },
      };
      holder.services = makeMockServices({
        subscriptionTokenPlanService: { getTokenPlanStatus: async () => result },
      });

      const output = await runCommand(buildTokenPlan, [
        'subscription',
        'tokenplan',
        'status',
        '--format',
        'text',
      ]);

      expect(output.exitCode).toBeUndefined();
      expect(output.stdout).toContain('SEAT SUMMARY\n\n');
      expect(output.stdout).toMatch(/SEAT TYPE\s+QUANTITY/);
      expect(output.stdout).toMatch(/Standard Seat\s+1/);
      expect(output.stdout).not.toMatch(/Total Credits|Remaining Credits|Next Cycle|25,000/);
      const json = await runCommand(buildTokenPlan, [
        'subscription',
        'tokenplan',
        'status',
        '--format',
        'json',
      ]);
      expect(JSON.parse(json.stdout).seatSummary).toEqual({
        ...result.seatSummary,
        groups: result.seatSummary!.groups.map((group) => ({
          ...group,
          nextCycleFlushTime: nextCycleFlushTime === null ? null : '2026-11-01T08:00:00.000+08:00',
        })),
      });
    },
  );
});

describe('subscription tokenplan seats spec filter', () => {
  function mockSeats(items = true) {
    const spy = vi.fn(
      async (params: ListTokenPlanSeatsParams): Promise<TokenPlanSeatsResult> => ({
        page: { current: params.page ?? 1, size: params.pageSize ?? 20, total: items ? 10 : 0 },
        filter: { specType: params.specType ?? null },
        items: items
          ? [
              {
                instanceCode: 'seat-test-1',
                specType: params.specType ?? 'max',
                status: 'NORMAL',
                memberId: '',
                assignable: true,
                assignment: 'unassigned',
                payMode: 'PrePaid',
                productType: 'sfm_tokenplanteams_dp_cn',
                cycle: null,
                config: null,
              },
            ]
          : [],
        diagnostics: [],
      }),
    );
    holder.services = makeMockServices({
      subscriptionTokenPlanService: { listTokenPlanSeats: spy },
    });
    return spy;
  }

  for (const format of ['json', 'text', 'table']) {
    it.each(['standard', 'pro', 'max', 'MAX'])(
      `accepts %s and renders the service result in ${format}`,
      async (input) => {
        const spy = mockSeats();
        const result = await runCommand(buildTokenPlan, [
          'subscription',
          'tokenplan',
          'seats',
          '--spec-type',
          input,
          '--page',
          '2',
          '--page-size',
          '5',
          '--format',
          format,
        ]);
        const specType = input.toLowerCase();
        expect(result.exitCode).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(ensureAuthenticatedSpy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledExactlyOnceWith({ page: 2, pageSize: 5, specType });
        if (format === 'json') {
          expect(JSON.parse(result.stdout)).toMatchObject({
            filter: { specType },
            items: [{ specType }],
          });
        } else {
          const output = format === 'table' ? lastRenderedFrame() : result.stdout;
          expect(output).toContain(specType[0].toUpperCase() + specType.slice(1));
        }
      },
    );
  }

  it('keeps an empty max result successful', async () => {
    mockSeats(false);
    const result = await runCommand(buildTokenPlan, [
      'subscription',
      'tokenplan',
      'seats',
      '--spec-type',
      'max',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({ filter: { specType: 'max' }, items: [] });
  });

  it('keeps an unfiltered request and returned max seats intact', async () => {
    const spy = mockSeats();
    const result = await runCommand(buildTokenPlan, [
      'subscription',
      'tokenplan',
      'seats',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(spy).toHaveBeenCalledExactlyOnceWith({ page: 1, pageSize: 20 });
    expect(JSON.parse(result.stdout)).toMatchObject({
      filter: { specType: null },
      items: [{ specType: 'max' }],
    });
  });

  it.each(['enterprise', 'advanced', 'premium'])(
    'rejects unsupported spec %s before authentication and service calls',
    async (input) => {
      const spy = mockSeats();
      const result = await runCommand(buildTokenPlan, [
        'subscription',
        'tokenplan',
        'seats',
        '--spec-type',
        input,
        '--format',
        'json',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: '--spec-type must be one of: standard, pro, max',
          exit_code: 1,
        },
      });
      expect(ensureAuthenticatedSpy).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('documents all three supported spec types in help', () => {
    const program = new Command();
    buildTokenPlan(program);
    const seats = program.commands[0].commands[0].commands.find((cmd) => cmd.name() === 'seats');
    expect(seats?.helpInformation()).toContain('Filter by seat spec type: standard, pro, max');
  });
});
