import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { RechargeResultOutput } from '../../../src/types/recharge.js';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';

interface RechargeResultOptions {
  rechargeOrderId: string;
  signal: AbortSignal;
}

interface InkRenderOptions {
  waitUntil?: Promise<unknown>;
}

type GetRechargeResult = (options: RechargeResultOptions) => Promise<RechargeResultOutput>;
type WaitForRechargeResult = (options: RechargeResultOptions) => Promise<RechargeResultOutput>;

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { ensureAuthenticatedSpy, renderWithInkSpy } = vi.hoisted(() => ({
  ensureAuthenticatedSpy: vi.fn(() => ({})),
  renderWithInkSpy:
    vi.fn<
      (element: ReactElement<Record<string, unknown>>, options?: InkRenderOptions) => Promise<void>
    >(),
}));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: ensureAuthenticatedSpy,
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  clearSpinnerLine: () => undefined,
}));

const { RechargeOrderNotFoundError } = await import('../../../src/services/billing-service.js');
const { rechargeResultAction } =
  await import('../../../src/commands/billing/balance/recharge-result.js');
const { interruptActiveCommand } = await import('../../../src/utils/command-interrupt.js');

function buildRechargeResult(program: import('commander').Command): void {
  const billing = program.command('billing');
  const balance = billing.command('balance');
  const recharge = balance.command('recharge');
  const result = recharge
    .command('result')
    .requiredOption('--recharge-order-id <id>')
    .option('--wait')
    .option('--format <fmt>');
  result.action(rechargeResultAction(result));
}

const orderId = 'order_result_command_test_1';
const doneResult: RechargeResultOutput = {
  type: 'recharge',
  rechargeOrderId: orderId,
  RechargeStatus: 'DONE',
};

beforeEach(() => {
  holder.services = makeMockServices();
  ensureAuthenticatedSpy.mockClear();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(async (_element, options) => {
    await options?.waitUntil;
  });
});

describe('billing balance recharge result query selection', () => {
  it('queries exactly once by default and emits JSON without polling or creating an order', async () => {
    const getRechargeResult = vi.fn<GetRechargeResult>(async () => doneResult);
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>();
    const createRecharge = vi.fn();
    holder.services = makeMockServices({
      billingService: { getRechargeResult, waitForRechargeResult, createRecharge },
    });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      orderId,
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({
      type: 'recharge',
      rechargeOrderId: orderId,
      status: 'DONE',
    });
    expect(getRechargeResult).toHaveBeenCalledOnce();
    expect(getRechargeResult).toHaveBeenCalledWith({
      rechargeOrderId: orderId,
      signal: expect.any(AbortSignal),
    });
    expect(waitForRechargeResult).not.toHaveBeenCalled();
    expect(createRecharge).not.toHaveBeenCalled();
    expect(renderWithInkSpy).not.toHaveBeenCalled();
  });

  it('--wait delegates to polling and never performs the one-time query', async () => {
    const getRechargeResult = vi.fn<GetRechargeResult>();
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>(async () => doneResult);
    const createRecharge = vi.fn();
    holder.services = makeMockServices({
      billingService: { getRechargeResult, waitForRechargeResult, createRecharge },
    });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      orderId,
      '--wait',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({ rechargeOrderId: orderId, status: 'DONE' });
    expect(waitForRechargeResult).toHaveBeenCalledOnce();
    expect(getRechargeResult).not.toHaveBeenCalled();
    expect(createRecharge).not.toHaveBeenCalled();
  });
});

describe('billing balance recharge result output modes', () => {
  it('renders DONE as plain text without ANSI', async () => {
    const getRechargeResult = vi.fn<GetRechargeResult>(async () => doneResult);
    holder.services = makeMockServices({ billingService: { getRechargeResult } });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      orderId,
      '--format',
      'text',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('Recharge completed.');
    expect(result.stdout).not.toContain(orderId);
    expect(result.stdout).toMatch(/STATUS\s+succeeded/u);
    expect(result.stdout).not.toContain('DONE');
    expect(result.stdout).not.toContain(`${String.fromCharCode(27)}[`);
    expect(renderWithInkSpy).not.toHaveBeenCalled();
  });

  it('renders a default one-time table result as a static panel', async () => {
    const getRechargeResult = vi.fn<GetRechargeResult>(async () => doneResult);
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>();
    holder.services = makeMockServices({
      billingService: { getRechargeResult, waitForRechargeResult },
    });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      orderId,
      '--format',
      'table',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledOnce();
    expect(renderWithInkSpy.mock.calls[0]?.[0].props).toMatchObject({
      vm: { type: 'recharge', rechargeOrderId: orderId, status: 'DONE' },
    });
    expect(renderWithInkSpy.mock.calls[0]?.[1]).toBeUndefined();
    expect(getRechargeResult).toHaveBeenCalledOnce();
    expect(waitForRechargeResult).not.toHaveBeenCalled();
  });

  it('renders --wait table output with the polling promise', async () => {
    const getRechargeResult = vi.fn<GetRechargeResult>();
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>(async () => doneResult);
    holder.services = makeMockServices({
      billingService: { getRechargeResult, waitForRechargeResult },
    });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      orderId,
      '--wait',
      '--format',
      'table',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledOnce();
    expect(renderWithInkSpy.mock.calls[0]?.[0].props).toMatchObject({ rechargeOrderId: orderId });
    expect(renderWithInkSpy.mock.calls[0]?.[1]?.waitUntil).toBeInstanceOf(Promise);
    expect(waitForRechargeResult).toHaveBeenCalledOnce();
    expect(getRechargeResult).not.toHaveBeenCalled();
  });
});

describe('billing balance recharge result failures and cleanup', () => {
  it('rejects a blank order ID before authentication and service calls', async () => {
    const getRechargeResult = vi.fn<GetRechargeResult>();
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>();
    holder.services = makeMockServices({
      billingService: { getRechargeResult, waitForRechargeResult },
    });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      '   ',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('INVALID_ARGUMENT');
    expect(ensureAuthenticatedSpy).not.toHaveBeenCalled();
    expect(getRechargeResult).not.toHaveBeenCalled();
    expect(waitForRechargeResult).not.toHaveBeenCalled();
  });

  it('maps a missing recharge order to NOT_FOUND/exit 7', async () => {
    const upstream = new Error('The request processing has failed due to some unknown error.');
    upstream.name = 'GatewayEnvelopeError';
    const getRechargeResult = vi.fn<GetRechargeResult>(async () => {
      throw new RechargeOrderNotFoundError(upstream);
    });
    holder.services = makeMockServices({ billingService: { getRechargeResult } });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      'missing_order',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'NOT_FOUND', exit_code: 7 },
    });
    expect(getRechargeResult).toHaveBeenCalledOnce();
  });

  it('maps an active command interruption to exit 130 and removes all installed handlers', async () => {
    const listenersBefore = process.listenerCount('SIGINT');
    const getRechargeResult = vi.fn<GetRechargeResult>(async ({ rechargeOrderId, signal }) => {
      expect(interruptActiveCommand()).toBe(true);
      expect(signal.aborted).toBe(true);
      return {
        type: 'recharge',
        rechargeOrderId,
        RechargeStatus: 'UNKNOWN',
        reason: 'interrupted',
      };
    });
    holder.services = makeMockServices({ billingService: { getRechargeResult } });

    const result = await runCommand(buildRechargeResult, [
      'billing',
      'balance',
      'recharge',
      'result',
      '--recharge-order-id',
      orderId,
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(130);
    expect(JSON.parse(result.stdout)).toEqual({
      type: 'recharge',
      rechargeOrderId: orderId,
      status: 'UNKNOWN',
      reason: 'interrupted',
    });
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    expect(interruptActiveCommand()).toBe(false);
  });
});
