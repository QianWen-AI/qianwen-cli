import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../../../src/services/index.js';
import type { TokenPlanPaymentResult } from '../../../../src/types/tokenplan-payment.js';
import { runCommand } from '../../../helpers/run-command.js';
import { makeMockServices } from '../../../helpers/service-container-mock.js';

type GetPaymentResult = (orderId: string, signal?: AbortSignal) => Promise<TokenPlanPaymentResult>;

const holder: { services: ServiceContainer } = { services: makeMockServices() };

vi.mock('../../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: vi.fn(() => ({})),
}));

const { subscriptionTokenPlanPaymentResultAction } =
  await import('../../../../src/commands/subscription/tokenplan/payment-result.js');
const { interruptActiveCommand } = await import('../../../../src/utils/command-interrupt.js');

function buildPaymentResult(program: import('commander').Command): void {
  const subscription = program.command('subscription');
  const tokenplan = subscription.command('tokenplan');
  const paymentResult = tokenplan
    .command('payment-result <order-id>')
    .option('--wait')
    .option('--format <fmt>');
  paymentResult.action(subscriptionTokenPlanPaymentResultAction(paymentResult));
}

beforeEach(() => {
  holder.services = makeMockServices();
});

describe('subscription tokenplan payment-result terminal precedence', () => {
  it.each([
    ['succeeded', undefined],
    ['failed', 1],
    ['cancelled', 1],
  ] as const)('keeps %s authoritative after a late interrupt', async (status, exitCode) => {
    const getPaymentResult = vi.fn<GetPaymentResult>(async (orderId, signal) => {
      expect(interruptActiveCommand()).toBe(true);
      expect(signal?.aborted).toBe(true);
      return { orderId, status };
    });
    holder.services = makeMockServices({
      tokenPlanPaymentService: {
        getPaymentResult,
        recoverPaymentResultFromOrders: vi.fn().mockResolvedValue(null),
      },
    });

    const outcome = await runCommand(buildPaymentResult, [
      'subscription',
      'tokenplan',
      'payment-result',
      '1234567890',
      '--format',
      'json',
    ]);

    expect(outcome.exitCode).toBe(exitCode);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ status });
    expect(interruptActiveCommand()).toBe(false);
  });

  it('keeps an interrupted non-terminal result at exit 130', async () => {
    const getPaymentResult = vi.fn<GetPaymentResult>(async (orderId) => {
      expect(interruptActiveCommand()).toBe(true);
      return { orderId, status: 'pending' };
    });
    holder.services = makeMockServices({
      tokenPlanPaymentService: {
        getPaymentResult,
        recoverPaymentResultFromOrders: vi.fn().mockResolvedValue(null),
      },
    });

    const outcome = await runCommand(buildPaymentResult, [
      'subscription',
      'tokenplan',
      'payment-result',
      '1234567890',
      '--format',
      'json',
    ]);

    expect(outcome.exitCode).toBe(130);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      status: 'unknown',
      reason: 'interrupted',
    });
    expect(interruptActiveCommand()).toBe(false);
  });

  it('uses the one-shot order recovery result after an interrupted non-terminal query', async () => {
    const getPaymentResult = vi.fn<GetPaymentResult>(async (orderId) => {
      expect(interruptActiveCommand()).toBe(true);
      return { orderId, status: 'pending' };
    });
    const recoverPaymentResultFromOrders = vi.fn().mockResolvedValue({
      orderId: '1234567890',
      status: 'cancelled',
      reason: 'order_cancelled',
    });
    holder.services = makeMockServices({
      tokenPlanPaymentService: { getPaymentResult, recoverPaymentResultFromOrders },
    });

    const outcome = await runCommand(buildPaymentResult, [
      'subscription',
      'tokenplan',
      'payment-result',
      '1234567890',
      '--format',
      'json',
    ]);

    expect(outcome.exitCode).toBe(1);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      status: 'cancelled',
      reason: 'order_cancelled',
    });
    expect(recoverPaymentResultFromOrders).toHaveBeenCalledOnce();
    expect(interruptActiveCommand()).toBe(false);
  });
});
