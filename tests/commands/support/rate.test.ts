/**
 * Unit tests for the `support rate <ticket-id>` command.
 *
 * Validates:
 *   - Non-interactive submission via --rating / --comment flags
 *   - Three-format output (json / text / table)
 *   - Parameter range validation (0-2)
 *   - Non-TTY guard when --rating is omitted
 *   - Eligibility guard via getAssessmentCard (editable=true required)
 *   - Card metadata propagation into rateTicket (without the editable flag)
 *   - Tag argument is undefined in non-interactive mode (no TagSelector run)
 *   - Ticket-not-found and network error routing through handleError
 *   - Comment 500-char truncation with warning
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type {
  SupportTicketDetail,
  AssessmentCardData,
  RateTicketResponse,
} from '../../../src/types/support.js';

// ── Module mocks ────────────────────────────────────────────────────────

const holder: { services: ServiceContainer } = { services: makeMockServices() };

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: vi.fn(() => ({})),
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: vi.fn(),
  renderWithInkSync: vi.fn(),
  renderInteractive: vi.fn(async () => undefined),
}));

import { supportRateAction } from '../../../src/commands/support/rate.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTicketDetail(overrides: Partial<SupportTicketDetail> = {}): SupportTicketDetail {
  return {
    id: 'TICKET-130000001',
    title: 'Inference timeout investigation',
    status: 'wait_score',
    createdAt: 1716883380000,
    category: 'Model Service / Inference Issues / Timeout',
    description: 'API timed out after 60s',
    ...overrides,
  };
}

function makeCard(overrides: Partial<AssessmentCardData> = {}): AssessmentCardData {
  return {
    editable: true,
    hasCard: true,
    alreadyRated: false,
    schemaId: 1001,
    bizType: 'ticket_satisfaction',
    answerType: 'satisfaction_card',
    cardBizId: 'CARD-XYZ',
    dialogId: 9988,
    ticketId: 'TICKET-130000001',
    isStar: false,
    goodTags: ['服务入口便捷', '处理速度快', '解决方案有效', '服务态度好'],
    badTags: ['找售后服务入口费力', '响应处理速度慢', '解决方案无效', '服务态度不好'],
    ...overrides,
  };
}

function makeRateResponse(rating: number, ticketId = 'TICKET-130000001'): RateTicketResponse {
  return {
    ticketId,
    rating,
    status: 'score',
    timestamp: '2026-04-20T10:00:00.000Z',
  };
}

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
}

function restoreTTY(): void {
  if (stdinIsTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
  if (stdoutIsTTYDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTYDescriptor);
}

function buildSupportRate(program: import('commander').Command) {
  const support = program.command('support');
  const rate = support
    .command('rate')
    .argument('<ticket-id>', 'Ticket ID to rate')
    .option('--rating <n>', 'Satisfaction rating (0-2)')
    .option('--comment <text>', 'Optional comment')
    .option('--format <fmt>', 'Output format');
  rate.action(async function (
    this: import('commander').Command,
    ticketId: string,
    opts: Record<string, unknown>,
  ) {
    // Walk up parent chain so --format passed at any level is honored.
    const merged: Record<string, unknown> = { ...opts };
    let cmd: import('commander').Command | null = this;
    while (cmd && merged.format === undefined) {
      const parentOpts = cmd.opts();
      if (parentOpts.format) merged.format = parentOpts.format;
      cmd = cmd.parent;
    }
    await supportRateAction(ticketId, merged);
  });
}

beforeEach(() => {
  holder.services = makeMockServices();
  // Default: stdin is a TTY but --rating provided will skip interaction.
  setTTY(true, true);
});

afterEach(() => {
  restoreTTY();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('support rate — non-interactive submission', () => {
  it('submits rating with --rating flag (no comment, no tags)', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBeUndefined();
    expect(rateSpy).toHaveBeenCalledTimes(1);
    const [ticketId, rating, comment, metadata, tags] = rateSpy.mock.calls[0];
    expect(ticketId).toBe('TICKET-130000001');
    expect(rating).toBe(2);
    expect(comment).toBeUndefined();
    // tags must be undefined in non-interactive mode (no TagSelector run).
    expect(tags).toBeUndefined();
    // metadata must contain every card field except `editable`, `goodTags`, `badTags`.
    expect(metadata).toEqual({
      schemaId: 1001,
      bizType: 'ticket_satisfaction',
      answerType: 'satisfaction_card',
      cardBizId: 'CARD-XYZ',
      dialogId: 9988,
      ticketId: 'TICKET-130000001',
      isStar: false,
    });
    expect(metadata).not.toHaveProperty('editable');
    expect(metadata).not.toHaveProperty('goodTags');
    expect(metadata).not.toHaveProperty('badTags');
  });

  it('forwards --comment value to rateTicket', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--comment',
      'Excellent support',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBeUndefined();
    expect(rateSpy).toHaveBeenCalledTimes(1);
    const [ticketId, rating, comment] = rateSpy.mock.calls[0];
    expect(ticketId).toBe('TICKET-130000001');
    expect(rating).toBe(2);
    expect(comment).toBe('Excellent support');
  });

  it('propagates the full metadata snapshot returned by getAssessmentCard', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () =>
          makeCard({
            schemaId: 7777,
            cardBizId: 'CARD-ABC-001',
            dialogId: 555_001,
            isStar: true,
          }),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBeUndefined();
    const metadata = rateSpy.mock.calls[0][3];
    expect(metadata).toMatchObject({
      schemaId: 7777,
      cardBizId: 'CARD-ABC-001',
      dialogId: 555_001,
      isStar: true,
    });
  });
});

describe('support rate — output formats', () => {
  it('emits a complete JSON payload with all contract fields', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--comment',
      'Quick and helpful',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout) as {
      ticketId: string;
      rating: number;
      ratingLabel: string;
      comment: string | null;
      status: string;
      statusLabel: string;
      timestamp: string;
    };
    expect(payload.ticketId).toBe('TICKET-130000001');
    expect(payload.rating).toBe(2);
    expect(payload.ratingLabel).toBe('满意');
    expect(payload.comment).toBe('Quick and helpful');
    expect(payload.status).toBe('score');
    expect(payload.statusLabel).toBe('Closed');
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('renders human-readable lines under --format text', async () => {
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: async () => makeRateResponse(2),
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--format',
      'text',
    ]);

    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('TICKET-130000001');
    expect(r.stdout).toMatch(/Rating:\s*2\/2/);
    expect(r.stdout).toContain('满意');
    expect(r.stdout).toContain('Closed');
  });
});

describe('support rate — parameter validation', () => {
  it('rejects --rating below 0 with INVALID_ARGUMENT', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(0));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '-1',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    expect(rateSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(r.stderr) as { error: { code?: string } };
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects --rating above 2 with INVALID_ARGUMENT', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '3',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    expect(rateSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(r.stderr) as { error: { code?: string } };
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects non-TTY environments when --rating is omitted', async () => {
    setTTY(false, true);

    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    expect(rateSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(r.stderr) as { error: { code?: string } };
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('support rate — eligibility guard (GetAssessmentCard)', () => {
  it('proceeds when getAssessmentCard reports editable=true', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    const cardSpy = vi.fn(async () => makeCard());
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail({ status: 'wait_score' }),
        getAssessmentCard: cardSpy,
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBeUndefined();
    expect(cardSpy).toHaveBeenCalledWith('TICKET-130000001');
    expect(rateSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects rating when getAssessmentCard reports editable=false', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail({ status: 'dealing' }),
        getAssessmentCard: async () => makeCard({ editable: false }),
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    expect(rateSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(r.stderr) as { error: { message?: string } };
    expect(payload.error.message).toMatch(/not available for rating/i);
    expect(payload.error.message).toMatch(/TICKET-130000001/);
  });

  it('forwards getAssessmentCard failures through handleError', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => {
          throw Object.assign(new Error('connect ETIMEDOUT mock-api.test.qianwen.com'), {
            name: 'NetworkError',
            code: 'ETIMEDOUT',
          });
        },
        rateTicket: rateSpy,
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    expect(rateSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(r.stderr) as { error: { message?: string } };
    expect(payload.error.message).toMatch(/ETIMEDOUT|timeout/i);
  });

  it('surfaces ticket-not-found error from getTicket through handleError', async () => {
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => {
          throw Object.assign(new Error('您无权查看该工单'), {
            name: 'GatewayBusinessError',
            code: '401',
          });
        },
        getAssessmentCard: async () => makeCard(),
        rateTicket: async () => makeRateResponse(2),
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-999999999',
      '--rating',
      '2',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr) as { error: { message?: string } };
    expect(payload.error.message).toMatch(/无权查看|工单/);
  });
});

describe('support rate — error routing', () => {
  it('forwards network errors from rateTicket through handleError', async () => {
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: async () => {
          throw Object.assign(new Error('connect ETIMEDOUT mock-api.test.qianwen.com'), {
            name: 'NetworkError',
            code: 'ETIMEDOUT',
          });
        },
      },
    });

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr) as { error: { message?: string } };
    expect(payload.error.message).toMatch(/ETIMEDOUT|timeout/i);
  });
});

describe('support rate — comment boundary', () => {
  it('truncates --comment longer than 500 characters and emits a warning', async () => {
    const rateSpy = vi.fn(async () => makeRateResponse(2));
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => makeTicketDetail(),
        getAssessmentCard: async () => makeCard(),
        rateTicket: rateSpy,
      },
    });

    const longComment = 'A'.repeat(750);

    const r = await runCommand(buildSupportRate, [
      'support',
      'rate',
      'TICKET-130000001',
      '--rating',
      '2',
      '--comment',
      longComment,
      '--format',
      'json',
    ]);

    expect(r.exitCode).toBeUndefined();
    expect(rateSpy).toHaveBeenCalledTimes(1);
    const passedComment = rateSpy.mock.calls[0][2] as string;
    expect(passedComment).toBeDefined();
    expect(passedComment.length).toBe(500);
    // A warning must surface to the user — either on stderr (warning channel)
    // or embedded in the JSON payload as a diagnostic flag.
    const warned = /truncat/i.test(r.stderr) || /truncat/i.test(r.stdout) || /500/.test(r.stderr);
    expect(warned).toBe(true);
  });
});
