/**
 * Unit tests for the `support reply <ticket-id>` command.
 *
 * Validates:
 *   - Content pre-check passes → createMessage is invoked
 *   - Content pre-check network error → createMessage still invoked (best-effort)
 *   - Content flagged + interactive user revises → createMessage invoked
 *   - Content flagged + interactive user cancels → cancelled
 *   - Empty input → cancelled
 *   - Non-TTY → INVALID_ARGUMENT error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

// Drives the multilineInput mock used in interactive mode.
const multilineHolder: { callCount: number; contents: string[] } = {
  callCount: 0,
  contents: ['Please check the logs'],
};



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
vi.mock('../../../src/utils/multiline-input.js', () => ({
  multilineInput: async () => {
    const idx = multilineHolder.callCount++;
    return multilineHolder.contents.length > idx ? multilineHolder.contents[idx] : '';
  },
}));

vi.mock('../../../src/ui/SupportView.js', () => ({
  renderSupportViewInk: vi.fn(async () => undefined),
}));
vi.mock('../../../src/output/text/support.js', () => ({
  renderTextSupportView: vi.fn(),
}));
vi.mock('../../../src/view-models/support/index.js', () => ({
  buildSupportViewViewModel: () => ({}),
}));

import { supportReplyAction } from '../../../src/commands/support/reply.js';

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function setStdinTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

function restoreStdinTTY(): void {
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
  }
}

function build(program: import('commander').Command) {
  const support = program.command('support');
  support
    .command('reply')
    .argument('<ticket-id>', 'Ticket ID to reply to')
    .option('--format <fmt>', 'Output format')
    .action(async function (
      this: import('commander').Command,
      ticketId: string,
      opts: Record<string, unknown>,
    ) {
      await supportReplyAction(ticketId, opts);
    });
}

beforeEach(() => {
  holder.services = makeMockServices();
  multilineHolder.callCount = 0;
  multilineHolder.contents = ['Please check the logs'];
  setStdinTTY(true);
});

afterEach(() => {
  restoreStdinTTY();
});

describe('support reply — happy path', () => {
  it('sends the reply when risk-word check passes', async () => {
    const identifySpy = vi.fn(async () => ({ hasRisk: false }));
    const createMessageSpy = vi.fn(async () => undefined);
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => ({ id: 'TICKET-130000001', title: 'Test', status: 'dealing' }),
        identifyRiskWord: identifySpy,
        createMessage: createMessageSpy,
      },
    });

    const r = await runCommand(build, ['support', 'reply', 'TICKET-130000001', '--format', 'json']);

    expect(r.exitCode).toBeUndefined();
    expect(identifySpy).toHaveBeenCalledTimes(1);
    expect(createMessageSpy).toHaveBeenCalledWith('TICKET-130000001', 'Please check the logs');
    const payload = JSON.parse(r.stdout);
    expect(payload.status).toBe('replied');
  });
});

describe('support reply — content pre-check resilience', () => {
  it('proceeds with createMessage when pre-check throws', async () => {
    const createMessageSpy = vi.fn(async () => undefined);
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => ({ id: 'TICKET-130000001', title: 'Test', status: 'dealing' }),
        identifyRiskWord: async () => {
          throw new Error('upstream timeout');
        },
        createMessage: createMessageSpy,
      },
    });

    const r = await runCommand(build, ['support', 'reply', 'TICKET-130000001', '--format', 'json']);

    expect(r.exitCode).toBeUndefined();
    expect(createMessageSpy).toHaveBeenCalledTimes(1);
  });
});

describe('support reply — content pre-check blocking', () => {
  it('allows user to revise and submit when content is flagged', async () => {
    // First call: initial message; Second call: revised message
    multilineHolder.contents = ['flagged content', 'safe content'];
    let callCount = 0;
    const identifySpy = vi.fn(async () => {
      callCount++;
      return { hasRisk: callCount <= 1 };
    });
    const createMessageSpy = vi.fn(async () => undefined);
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => ({ id: 'TICKET-130000001', title: 'Test', status: 'dealing' }),
        identifyRiskWord: identifySpy,
        createMessage: createMessageSpy,
      },
    });

    const r = await runCommand(build, ['support', 'reply', 'TICKET-130000001', '--format', 'json']);

    expect(r.exitCode).toBeUndefined();
    expect(identifySpy).toHaveBeenCalledTimes(2);
    expect(createMessageSpy).toHaveBeenCalledWith('TICKET-130000001', 'safe content');
  });

  it('cancels when user provides empty revision', async () => {
    // First call: initial message that gets flagged; second call returns empty
    multilineHolder.contents = ['flagged content', ''];
    const identifySpy = vi.fn(async () => ({ hasRisk: true }));
    const createMessageSpy = vi.fn(async () => undefined);
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => ({ id: 'TICKET-130000001', title: 'Test', status: 'dealing' }),
        identifyRiskWord: identifySpy,
        createMessage: createMessageSpy,
      },
    });

    const r = await runCommand(build, ['support', 'reply', 'TICKET-130000001', '--format', 'json']);

    expect(r.exitCode).toBeUndefined();
    expect(createMessageSpy).not.toHaveBeenCalled();
  });
});

describe('support reply — interactive input', () => {
  it('cancels gracefully when initial input is empty', async () => {
    multilineHolder.contents = [''];
    const createMessageSpy = vi.fn(async () => undefined);
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => ({ id: 'TICKET-130000001', title: 'Test', status: 'dealing' }),
        identifyRiskWord: async () => ({ hasRisk: false }),
        createMessage: createMessageSpy,
      },
    });

    const r = await runCommand(build, ['support', 'reply', 'TICKET-130000001', '--format', 'json']);

    expect(r.exitCode).toBeUndefined();
    expect(createMessageSpy).not.toHaveBeenCalled();
  });

  it('rejects with INVALID_ARGUMENT in non-TTY environment', async () => {
    setStdinTTY(false);
    const createMessageSpy = vi.fn(async () => undefined);
    holder.services = makeMockServices({
      supportService: {
        getTicket: async () => ({ id: 'TICKET-130000001', title: 'Test', status: 'dealing' }),
        identifyRiskWord: async () => ({ hasRisk: false }),
        createMessage: createMessageSpy,
      },
    });

    const r = await runCommand(build, ['support', 'reply', 'TICKET-130000001', '--format', 'json']);

    expect(r.exitCode).toBe(1);
    expect(createMessageSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(r.stderr) as { error: { code?: string } };
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
  });
});
