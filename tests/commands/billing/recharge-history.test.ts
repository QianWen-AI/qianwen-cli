import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../../../src/utils/errors.js';
import { runCommand } from '../../helpers/run-command.js';
import {
  clearRenderedFrames,
  lastRenderedFrame,
  renderInkForTest,
} from '../../helpers/ink-render-mock.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';

interface RechargeHistoryRecord {
  tradeTime: string;
  tradeType: 'CHARGE';
  tradeChannel: string;
  amount: string;
  currency: 'CNY';
  tradeId?: string;
  oppositeTradeId?: string;
}

interface RechargeHistoryOutput {
  startTime: string;
  endTime: string;
  page: number;
  pageSize: number;
  totalCount: number;
  records: RechargeHistoryRecord[];
}

interface RechargeHistoryOptions {
  startTime: number;
  endTime: number;
  page: number;
  pageSize: number;
}

type GetRechargeHistory = (options: RechargeHistoryOptions) => Promise<RechargeHistoryOutput>;

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { ensureAuthenticatedSpy, renderWithInkSpy, rechargePaymentInkSpy, interactiveTableSpy } =
  vi.hoisted(() => ({
    ensureAuthenticatedSpy: vi.fn(() => ({})),
    renderWithInkSpy: vi.fn<(element: ReactElement) => Promise<void>>(),
    rechargePaymentInkSpy: vi.fn(() => null),
    interactiveTableSpy: vi.fn<
      (props: {
        totalItems: number;
        perPage: number;
        initialPage: number;
        initialRows: Record<string, string>[];
        loadPage: (page: number) => Promise<Record<string, string>[]>;
      }) => null
    >(() => null),
  }));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: ensureAuthenticatedSpy,
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => undefined,
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderWithInkSync: renderWithInkSpy,
  renderInteractive: renderWithInkSpy,
}));
vi.mock('../../../src/ui/RechargePayment.js', () => ({
  RechargePaymentInk: rechargePaymentInkSpy,
}));
vi.mock('../../../src/ui/InteractiveTable.js', () => ({
  InteractiveTable: interactiveTableSpy,
}));

const { rechargeHistoryAction } =
  await import('../../../src/commands/billing/balance/recharge-history.js');

function buildRechargeHistory(program: import('commander').Command): void {
  const billing = program.command('billing');
  const balance = billing.command('balance');
  const history = balance
    .command('recharge-history')
    .option('--range <range>')
    .option('--start-time <time>')
    .option('--end-time <time>')
    .option('--page <page>')
    .option('--page-size <page-size>')
    .option('--format <fmt>');
  history.action(rechargeHistoryAction(history));
}

const record: RechargeHistoryRecord = {
  tradeTime: '2026-01-02T04:30:00.000Z',
  tradeType: 'CHARGE',
  tradeChannel: 'ALIPAY',
  amount: '0.10',
  currency: 'CNY',
};

const nonEmptyHistory: RechargeHistoryOutput = {
  startTime: '2026-01-01T16:00:00.000Z',
  endTime: '2026-01-02T15:59:59.999Z',
  page: 2,
  pageSize: 20,
  totalCount: 21,
  records: [record],
};

const emptyHistory: RechargeHistoryOutput = {
  ...nonEmptyHistory,
  page: 1,
  pageSize: 10,
  totalCount: 0,
  records: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-02T04:34:56.000Z'));
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockResolvedValue(undefined);
  ensureAuthenticatedSpy.mockClear();
  rechargePaymentInkSpy.mockReset();
  interactiveTableSpy.mockReset();
  clearRenderedFrames();
  setStdinTTY(true);
});

afterEach(() => {
  vi.useRealTimers();
  restoreStdoutTTY();
  restoreStdinTTY();
});

const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function setStdoutTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

function restoreStdoutTTY(): void {
  if (stdoutIsTTYDescriptor) {
    Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, 'isTTY');
  }
}

function setStdinTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

function restoreStdinTTY(): void {
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
}

function stubHistory(output: RechargeHistoryOutput): ReturnType<typeof vi.fn<GetRechargeHistory>> {
  const getRechargeHistory = vi.fn<GetRechargeHistory>(async () => output);
  holder.services = makeMockServices({ billingService: { getRechargeHistory } });
  return getRechargeHistory;
}

describe('billing balance recharge-history argument contract', () => {
  it('defaults to a 30d Shanghai calendar-day window with page=1 and pageSize=10', async () => {
    const getRechargeHistory = stubHistory(emptyHistory);

    const result = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(getRechargeHistory).toHaveBeenCalledWith({
      startTime: 1764777600000,
      endTime: 1767369599999,
      page: 1,
      pageSize: 10,
    });
  });

  it.each([
    ['1d', 1767283200000, 1767369599999],
    ['3d', 1767110400000, 1767369599999],
    ['7d', 1766764800000, 1767369599999],
    ['30d', 1764777600000, 1767369599999],
  ])(
    '--range %s maps exactly to consecutive Shanghai calendar days',
    async (range, startTime, endTime) => {
      const getRechargeHistory = stubHistory(emptyHistory);

      const result = await runCommand(buildRechargeHistory, [
        'billing',
        'balance',
        'recharge-history',
        '--range',
        range,
        '--format',
        'json',
      ]);

      expect(result.exitCode).toBeUndefined();
      expect(getRechargeHistory).toHaveBeenCalledWith({
        startTime,
        endTime,
        page: 1,
        pageSize: 10,
      });
    },
  );

  it('passes explicit start/end boundaries and pagination parameters to the service', async () => {
    const getRechargeHistory = stubHistory(nonEmptyHistory);

    const result = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      '--start-time',
      '2026-08-19',
      '--end-time',
      '2026-08-20',
      '--page',
      '2',
      '--page-size',
      '20',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(getRechargeHistory).toHaveBeenCalledWith({
      startTime: 1787068800000,
      endTime: 1787241599999,
      page: 2,
      pageSize: 20,
    });
  });

  it('parses start/end values with times precisely in Asia/Shanghai', async () => {
    const getRechargeHistory = stubHistory(nonEmptyHistory);

    const result = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      '--start-time',
      '2026-08-19T10:11:12',
      '--end-time',
      '2026-08-20T03:04:05',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(getRechargeHistory).toHaveBeenCalledWith({
      startTime: 1787105472000,
      endTime: 1787166245000,
      page: 1,
      pageSize: 10,
    });
  });

  it.each([
    ['only start time', ['--start-time', '2026-08-19']],
    ['only end time', ['--end-time', '2026-08-20']],
    [
      'range conflicts with explicit time',
      ['--range', '7d', '--start-time', '2026-08-19', '--end-time', '2026-08-20'],
    ],
    ['invalid range', ['--range', '14d']],
    ['invalid date', ['--start-time', '2026-02-30', '--end-time', '2026-03-01']],
    ['start after end', ['--start-time', '2026-08-21', '--end-time', '2026-08-20']],
    ['zero page', ['--page', '0']],
    ['negative page', ['--page', '-1']],
    ['non-numeric page', ['--page', 'nope']],
    ['fractional page size', ['--page-size', '1.5']],
    ['negative page size', ['--page-size', '-1']],
    ['non-numeric page size', ['--page-size', 'nope']],
  ])('%s is rejected with INVALID_ARGUMENT/exit 1 without querying', async (_name, options) => {
    const getRechargeHistory = stubHistory(emptyHistory);

    const result = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      ...options,
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('INVALID_ARGUMENT');
    expect(ensureAuthenticatedSpy).not.toHaveBeenCalled();
    expect(getRechargeHistory).not.toHaveBeenCalled();
  });
});

describe('billing balance recharge-history tri-state output', () => {
  it('JSON retains records, two-decimal amounts, and pagination metadata without leaking transaction IDs to result queries', async () => {
    stubHistory({
      ...nonEmptyHistory,
      records: [
        {
          ...record,
          tradeId: 'trade_sensitive_9007199254740993',
          oppositeTradeId: 'opposite_sensitive_9007199254740995',
        },
      ],
    });

    const result = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      '--page',
      '2',
      '--page-size',
      '20',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBeUndefined();
    const output = JSON.parse(result.stdout) as RechargeHistoryOutput;
    expect(output.records).toEqual([record]);
    expect(output.totalCount).toBe(21);
    expect(output.page).toBe(2);
    expect(output.pageSize).toBe(20);
    expect(result.stdout).not.toContain('trade_sensitive_');
    expect(result.stdout).not.toContain('opposite_sensitive_');
  });

  it('JSON empty state still emits a single records array', async () => {
    stubHistory(emptyHistory);

    const result = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({ records: [], totalCount: 0 });
    expect(result.stderr).toBe('');
  });

  it('text output has no ANSI or QR code in either non-empty or empty states', async () => {
    stubHistory(nonEmptyHistory);
    const populated = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      '--format',
      'text',
    ]);
    expect(populated.stdout).toContain('0.10');
    expect(populated.stdout).not.toContain(`${String.fromCharCode(27)}[`);

    stubHistory(emptyHistory);
    const empty = await runCommand(buildRechargeHistory, [
      'billing',
      'balance',
      'recharge-history',
      '--format',
      'text',
    ]);
    expect(empty.stdout).toMatch(/no recharge records/i);
    expect(empty.stdout).not.toContain(`${String.fromCharCode(27)}[`);
    expect(renderWithInkSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['non-empty', nonEmptyHistory],
    ['empty', emptyHistory],
  ])(
    'table %s state uses the Ink renderer without creating a payment order',
    async (_name, output) => {
      vi.useRealTimers();
      clearRenderedFrames();
      const getRechargeHistory = stubHistory(output);
      const createRecharge = vi.fn();
      holder.services = makeMockServices({
        billingService: { getRechargeHistory, createRecharge },
      });
      renderWithInkSpy.mockImplementation(renderInkForTest);

      const result = await runCommand(buildRechargeHistory, [
        'billing',
        'balance',
        'recharge-history',
        '--format',
        'table',
      ]);

      expect(result.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const frame = lastRenderedFrame() ?? '';
      expect(frame).not.toBe('');
      if (output.records.length === 0) {
        expect(frame).toContain('No recharge records');
      } else {
        expect(frame).toContain('2026-01-02');
        expect(frame).toContain('CHARGE');
        expect(frame).toContain('ALIPAY');
        expect(frame).toContain('0.10');
      }
      expect(frame).not.toContain('QR:');
      expect(frame).not.toContain('pay.test.qianwenai.com');
      expect(rechargePaymentInkSpy).not.toHaveBeenCalled();
      expect(createRecharge).not.toHaveBeenCalled();
    },
  );
});

describe('billing balance recharge-history error exit contract', () => {
  it.each([
    [
      'authentication',
      new CliError({ code: 'AUTH_REQUIRED', message: 'Not authenticated.', exitCode: 2 }),
      2,
    ],
    [
      'network',
      new CliError({ code: 'NETWORK_ERROR', message: 'Network unavailable.', exitCode: 3 }),
      3,
    ],
    [
      'configuration',
      new CliError({ code: 'CONFIG_ERROR', message: 'Missing configuration.', exitCode: 4 }),
      4,
    ],
    [
      'business',
      new CliError({ code: 'INVALID_RESPONSE', message: 'Malformed fund flow.', exitCode: 1 }),
      1,
    ],
  ])(
    '%s error preserves the exit code and keeps JSON stdout clean',
    async (_name, error, exitCode) => {
      const getRechargeHistory = vi.fn<GetRechargeHistory>(async () => {
        throw error;
      });
      holder.services = makeMockServices({ billingService: { getRechargeHistory } });

      const result = await runCommand(buildRechargeHistory, [
        'billing',
        'balance',
        'recharge-history',
        '--format',
        'json',
      ]);

      expect(result.exitCode).toBe(exitCode);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(error.code);
    },
  );
});

describe('billing balance recharge-history table pagination', () => {
  const args = ['billing', 'balance', 'recharge-history', '--format', 'table'];

  it('uses a pageable table in a TTY when records span multiple pages and initializes it with the current page', async () => {
    vi.useRealTimers();
    setStdoutTTY(true);
    stubHistory(nonEmptyHistory);
    renderWithInkSpy.mockImplementation(renderInkForTest);

    const result = await runCommand(buildRechargeHistory, [
      ...args,
      '--page',
      '2',
      '--page-size',
      '20',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(interactiveTableSpy).toHaveBeenCalledTimes(1);
    // The static panel prints its own heading, so its absence proves the
    // paginated table replaced it rather than rendering alongside it.
    expect(lastRenderedFrame() ?? '').not.toContain('Recharge History');
    expect(interactiveTableSpy.mock.calls[0]?.[0]).toMatchObject({
      totalItems: 21,
      perPage: 20,
      initialPage: 2,
    });
  });

  it('requeries the target page with the same time window to avoid duplicate records from a sliding window', async () => {
    vi.useRealTimers();
    setStdoutTTY(true);
    const getRechargeHistory = stubHistory(nonEmptyHistory);
    renderWithInkSpy.mockImplementation(renderInkForTest);

    await runCommand(buildRechargeHistory, [...args, '--page', '2', '--page-size', '20']);

    const first = getRechargeHistory.mock.calls[0]?.[0];
    const loadPage = interactiveTableSpy.mock.calls[0]?.[0].loadPage;
    // The already-loaded page is served from the initial response, so paging
    // back and forth does not re-issue the same query.
    expect(await loadPage?.(2)).toHaveLength(1);
    expect(getRechargeHistory).toHaveBeenCalledTimes(1);

    await loadPage?.(1);

    expect(getRechargeHistory).toHaveBeenCalledTimes(2);
    expect(getRechargeHistory.mock.calls[1]?.[0]).toEqual({
      startTime: first?.startTime,
      endTime: first?.endTime,
      page: 1,
      pageSize: 20,
    });
  });

  it('uses a static panel when records fit on one page instead of entering keyboard pagination mode', async () => {
    vi.useRealTimers();
    setStdoutTTY(true);
    stubHistory({ ...nonEmptyHistory, page: 1, totalCount: 1 });
    renderWithInkSpy.mockImplementation(renderInkForTest);

    await runCommand(buildRechargeHistory, args);

    expect(interactiveTableSpy).not.toHaveBeenCalled();
    expect(lastRenderedFrame() ?? '').toContain('Recharge History');
  });

  it('uses a static panel outside a TTY because keyboard pagination is unavailable', async () => {
    vi.useRealTimers();
    setStdoutTTY(false);
    stubHistory(nonEmptyHistory);
    renderWithInkSpy.mockImplementation(renderInkForTest);

    await runCommand(buildRechargeHistory, args);

    expect(interactiveTableSpy).not.toHaveBeenCalled();
    expect(lastRenderedFrame() ?? '').toContain('Recharge History');
  });

  it('still uses a static panel when stdout is a TTY but stdin is redirected', async () => {
    vi.useRealTimers();
    setStdoutTTY(true);
    setStdinTTY(false);
    stubHistory(nonEmptyHistory);
    renderWithInkSpy.mockImplementation(renderInkForTest);

    await runCommand(buildRechargeHistory, args);

    expect(interactiveTableSpy).not.toHaveBeenCalled();
    expect(lastRenderedFrame() ?? '').toContain('Recharge History');
  });
});
