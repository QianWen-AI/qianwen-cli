import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';
import type { CategorySelection } from '../../../src/ui/CategorySelector.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { renderWithInkSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
}));

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
  renderWithInk: renderWithInkSpy,
  renderWithInkSync: renderWithInkSpy,
  renderInteractive: renderWithInkSpy,
}));

import { supportCreateAction } from '../../../src/commands/support/create.js';

function build(program: import('commander').Command) {
  const support = program.command('support');
  support
    .command('create')
    .option('--format <fmt>')
    .option('--list-categories')
    .option('--category-id <id>')
    .option('--description <text>')
    .action(async function (this: import('commander').Command, opts: Record<string, unknown>) {
      const merged: Record<string, unknown> = { ...opts };
      let cmd: import('commander').Command | null = this;
      while (cmd && merged.format === undefined) {
        const parentOpts = cmd.opts();
        if (parentOpts.format) merged.format = parentOpts.format;
        cmd = cmd.parent;
      }
      await supportCreateAction(merged);
    });
}

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
  // Snapshot stdin.isTTY so each test can flip it deterministically.
  originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
    writable: true,
  });
});

function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('support create command', () => {
  it('rejects non-TTY stdin with INVALID_ARGUMENT in JSON mode', async () => {
    setStdinTTY(false);
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => [],
      },
    });
    const r = await runCommand(build, ['support', 'create', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    // handleError writes structured JSON to stderr (not stdout) in JSON mode.
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(payload.error.message).toContain('interactive terminal');
  });

  it('rejects non-TTY stdin in text mode (writes to stderr + exitCode 1)', async () => {
    setStdinTTY(false);
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => [],
      },
    });
    const r = await runCommand(build, ['support', 'create', '--format', 'text']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('interactive terminal');
  });

  it('errors with NO_CATEGORIES when category tree is empty (TTY)', async () => {
    setStdinTTY(true);
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => [],
      },
    });
    const r = await runCommand(build, ['support', 'create', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('NO_CATEGORIES');
  });

  it('does NOT call category service when stdin is non-TTY (guard runs first)', async () => {
    setStdinTTY(false);
    let called = false;
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => {
          called = true;
          return [];
        },
      },
    });
    await runCommand(build, ['support', 'create', '--format', 'json']);
    expect(called).toBe(false);
  });

  it('outputs redirect message in text format for non-numeric category with helpUrl', async () => {
    setStdinTTY(true);
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => [
          { id: 'miaowu', name: '\u79D2\u609F', helpUrl: 'https://www.miaowu.example.com', children: [] },
        ],
      },
    });
    renderWithInkSpy.mockImplementationOnce(async (el: any) => {
      const props = el.props;
      if (props.onSelect) {
        const sel: CategorySelection = { id: 'miaowu', name: '\u79D2\u609F', path: '\u79D2\u609F', helpUrl: 'https://www.miaowu.example.com' };
        props.onSelect(sel);
      }
    });
    const r = await runCommand(build, ['support', 'create', '--format', 'text']);
    expect(r.stdout).toContain('\u5982\u9700\u670D\u52A1\u652F\u6301');
    expect(r.stdout).toContain('\u79D2\u609F');
    expect(r.stdout).toContain('https://www.miaowu.example.com');
    expect(r.exitCode).toBeUndefined();
  });

  it('outputs redirect JSON for non-numeric category with helpUrl', async () => {
    setStdinTTY(true);
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => [
          { id: 'miaowu', name: '\u79D2\u609F', helpUrl: 'https://www.miaowu.example.com', children: [] },
        ],
      },
    });
    renderWithInkSpy.mockImplementationOnce(async (el: any) => {
      const props = el.props;
      if (props.onSelect) {
        const sel: CategorySelection = { id: 'miaowu', name: '\u79D2\u609F', path: '\u79D2\u609F', helpUrl: 'https://www.miaowu.example.com' };
        props.onSelect(sel);
      }
    });
    const r = await runCommand(build, ['support', 'create', '--format', 'json']);
    const payload = JSON.parse(r.stdout);
    expect(payload.redirect).toBe(true);
    expect(payload.name).toBe('\u79D2\u609F');
    expect(payload.url).toBe('https://www.miaowu.example.com');
    expect(r.exitCode).toBeUndefined();
  });

  it('does NOT redirect for numeric category ID even with helpUrl', async () => {
    setStdinTTY(true);
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => [
          { id: '582262', name: '\u6A21\u578B\u670D\u52A1', helpUrl: 'https://help.example.com', children: [] },
        ],
      },
    });
    renderWithInkSpy.mockImplementationOnce(async (el: any) => {
      const props = el.props;
      if (props.onSelect) {
        const sel: CategorySelection = { id: '582262', name: '\u6A21\u578B\u670D\u52A1', path: '\u6A21\u578B\u670D\u52A1', helpUrl: 'https://help.example.com' };
        props.onSelect(sel);
      }
    });
    const r = await runCommand(build, ['support', 'create', '--format', 'json']);
    // Should NOT contain redirect — would proceed to description input (which returns empty → cancels)
    expect(r.stdout).not.toContain('redirect');
  });
});

// ─── Test data ────────────────────────────────────────────────────────────────

const SAMPLE_TREE = [
  {
    id: '__group_0',
    name: '\u6A21\u578B',
    children: [
      { id: '582262', name: '\u8D26\u5355\u8BA1\u8D39', children: [] },
      { id: '582263', name: '\u53D1\u7968\u54A8\u8BE2', children: [] },
    ],
  },
  {
    id: '__group_1',
    name: '\u5E94\u7528',
    children: [
      { id: 'miaowu', name: '\u79D2\u609F', helpUrl: 'https://meoo.com', children: [] },
      { id: 'wanxiang', name: '\u4E07\u76F8', helpUrl: 'https://tongyi.aliyun.com/wan', children: [] },
    ],
  },
];

// ─── --list-categories ────────────────────────────────────────────────────────

describe('--list-categories', () => {
  it('JSON \u683C\u5F0F\u8F93\u51FA\u53F6\u5B50\u8282\u70B9\u6570\u7EC4', async () => {
    holder.services = makeMockServices({
      supportService: { getCategoryTree: async () => SAMPLE_TREE },
    });
    const r = await runCommand(build, ['support', 'create', '--list-categories', '--format', 'json']);
    const payload = JSON.parse(r.stdout);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(4);
    expect(payload[0]).toEqual({ id: '582262', category: '\u6A21\u578B > \u8D26\u5355\u8BA1\u8D39' });
    expect(payload[2]).toEqual({ id: 'miaowu', category: '应用 > 秒悟' });
    expect(r.exitCode).toBeUndefined();
  });

  it('Text \u683C\u5F0F\u8F93\u51FA\u8868\u683C', async () => {
    holder.services = makeMockServices({
      supportService: { getCategoryTree: async () => SAMPLE_TREE },
    });
    const r = await runCommand(build, ['support', 'create', '--list-categories', '--format', 'text']);
    expect(r.stdout).toContain('ID');
    expect(r.stdout).toContain('Category');
    expect(r.stdout).toContain('582262');
    expect(r.stdout).toContain('\u8D26\u5355\u8BA1\u8D39');
    expect(r.exitCode).toBeUndefined();
  });

  it('\u975E TTY \u73AF\u5883\u6B63\u5E38\u5DE5\u4F5C\uFF08\u4E0D\u629B\u51FA TTY \u9519\u8BEF\uFF09', async () => {
    setStdinTTY(false);
    holder.services = makeMockServices({
      supportService: { getCategoryTree: async () => SAMPLE_TREE },
    });
    const r = await runCommand(build, ['support', 'create', '--list-categories', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveLength(4);
  });

  it('\u4F18\u5148\u7EA7\u9AD8\u4E8E\u975E\u4EA4\u4E92\u53C2\u6570\uFF08\u540C\u65F6\u6307\u5B9A --category-id \u65F6\u4EC5\u5217\u8868\uFF09', async () => {
    holder.services = makeMockServices({
      supportService: { getCategoryTree: async () => SAMPLE_TREE },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--list-categories',
      '--category-id', '582262',
      '--description', 'some text',
      '--format', 'json',
    ]);
    const payload = JSON.parse(r.stdout);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(4);
    expect(r.exitCode).toBeUndefined();
  });
});

// ─── \u975E\u4EA4\u4E92\u521B\u5EFA (--category-id + --description) ──────────────────────────────

describe('\u975E\u4EA4\u4E92\u521B\u5EFA (--category-id + --description)', () => {
  it('\u6210\u529F\u521B\u5EFA\uFF1A\u63D0\u4F9B\u6709\u6548\u6570\u5B57 ID \u548C\u63CF\u8FF0 \u2192 \u8FD4\u56DE ticket ID', async () => {
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => SAMPLE_TREE,
        createTicket: async () => ({ vid: 'TICKET-20001' }),
      },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--category-id', '582262',
      '--description', '\u6A21\u578B\u8C03\u7528\u8D85\u65F6',
      '--format', 'text',
    ]);
    expect(r.stdout).toContain('TICKET-20001');
    expect(r.exitCode).toBeUndefined();
  });

  it('JSON \u683C\u5F0F\u8F93\u51FA { id, status, categoryId }', async () => {
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => SAMPLE_TREE,
        createTicket: async () => ({ vid: 'TICKET-30001' }),
      },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--category-id', '582263',
      '--description', '\u53D1\u7968\u95EE\u9898',
      '--format', 'json',
    ]);
    const payload = JSON.parse(r.stdout);
    expect(payload).toEqual({ id: 'TICKET-30001', status: 'created', categoryId: '582263' });
    expect(r.exitCode).toBeUndefined();
  });

  it('\u63CF\u8FF0\u8D85\u957F\u622A\u65AD\uFF08>2000\u5B57\u7B26\uFF09\u2192 stderr \u8F93\u51FA\u8B66\u544A + \u4ECD\u7136\u521B\u5EFA\u6210\u529F', async () => {
    const longDesc = 'x'.repeat(2500);
    let captured: { categoryId: string; description: string } | undefined;
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => SAMPLE_TREE,
        createTicket: async (params: { categoryId: string; description: string }) => {
          captured = params;
          return { vid: 'TICKET-40001' };
        },
      },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--category-id', '582262',
      '--description', longDesc,
      '--format', 'text',
    ]);
    expect(r.stderr).toContain('truncated');
    expect(r.stdout).toContain('TICKET-40001');
    expect(captured!.description).toHaveLength(2000);
    expect(r.exitCode).toBeUndefined();
  });

  it('\u4EC5\u63D0\u4F9B --category-id \u800C\u65E0 --description \u2192 \u62A5\u9519', async () => {
    holder.services = makeMockServices({
      supportService: { getCategoryTree: async () => SAMPLE_TREE },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--category-id', '582262',
      '--format', 'json',
    ]);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(payload.error.message).toContain('--description');
  });

  it('\u4EC5\u63D0\u4F9B --description \u800C\u65E0 --category-id \u2192 \u62A5\u9519', async () => {
    holder.services = makeMockServices({
      supportService: { getCategoryTree: async () => SAMPLE_TREE },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--description', '\u67D0\u4E2A\u95EE\u9898',
      '--format', 'json',
    ]);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(payload.error.message).toContain('--category-id');
  });

  it('\u65E0\u6548 category-id \u2192 \u62A5\u9519\uFF08\u63D0\u793A\u4F7F\u7528 --list-categories\uFF09', async () => {
    holder.services = makeMockServices({
      supportService: { getCategoryTree: async () => SAMPLE_TREE },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--category-id', '999999',
      '--description', '\u67D0\u4E2A\u95EE\u9898',
      '--format', 'json',
    ]);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(payload.error.message).toContain('--list-categories');
  });

  it('\u975E\u6570\u5B57 category-id \u4E14\u6709 helpUrl \u2192 \u8F93\u51FA\u91CD\u5B9A\u5411\u5F15\u5BFC\uFF08\u4E0D\u521B\u5EFA\u5DE5\u5355\uFF09', async () => {
    let ticketCreated = false;
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => SAMPLE_TREE,
        createTicket: async () => {
          ticketCreated = true;
          return { vid: 'SHOULD-NOT-APPEAR' };
        },
      },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--category-id', 'miaowu',
      '--description', '\u67D0\u4E2A\u95EE\u9898',
      '--format', 'json',
    ]);
    const payload = JSON.parse(r.stdout);
    expect(payload).toEqual({ redirect: true, name: '\u79D2\u609F', url: 'https://meoo.com' });
    expect(ticketCreated).toBe(false);
    expect(r.exitCode).toBeUndefined();
  });

  it('\u975E TTY \u73AF\u5883\u6B63\u5E38\u5DE5\u4F5C\uFF08\u4E0D\u629B\u51FA TTY \u9519\u8BEF\uFF09', async () => {
    setStdinTTY(false);
    holder.services = makeMockServices({
      supportService: {
        getCategoryTree: async () => SAMPLE_TREE,
        createTicket: async () => ({ vid: 'TICKET-50001' }),
      },
    });
    const r = await runCommand(build, [
      'support', 'create',
      '--category-id', '582262',
      '--description', '\u6A21\u578B\u8C03\u7528\u8D85\u65F6',
      '--format', 'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.id).toBe('TICKET-50001');
    expect(payload.status).toBe('created');
  });
});
