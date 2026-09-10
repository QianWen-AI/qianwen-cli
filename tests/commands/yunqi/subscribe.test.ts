/**
 * Command-layer tests for `yunqi subscribe` / `yunqi unsubscribe`.
 *
 * Guards two contracts of the rendered result. Wording: both commands share one
 * view-model builder, which previously reported "subscribed" even for an
 * unsubscribe. Exit code: a `Data: false` reply means the write did not happen,
 * which previously still exited 0 and so was invisible to callers that chain on
 * `&&` or check `$?`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const state: { subscribeResult: boolean; unsubscribeResult: boolean; forumIds: string[] } = {
  subscribeResult: true,
  unsubscribeResult: true,
  forumIds: [],
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
  state.subscribeResult = true;
  state.unsubscribeResult = true;
  state.forumIds = [];
  holder.services = makeMockServices({
    yunqiService: {
      subscribeForum: async (forumId: string) => {
        state.forumIds.push(forumId);
        return state.subscribeResult;
      },
      unsubscribeForum: async (forumId: string) => {
        state.forumIds.push(forumId);
        return state.unsubscribeResult;
      },
    },
  });
});

describe('yunqi unsubscribe — 结果文案', () => {
  it('成功时输出退订文案，不出现 subscribed', async () => {
    const r = await runCommand(build, [
      'yunqi',
      'unsubscribe',
      'forum',
      '--forum-id',
      'F-1',
      '--format',
      'text',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toBe('Successfully unsubscribed from forum.');
    expect(state.forumIds).toEqual(['F-1']);
  });

  it('失败时输出退订失败文案并以 exit 1 结束', async () => {
    state.unsubscribeResult = false;
    const r = await runCommand(build, [
      'yunqi',
      'unsubscribe',
      'forum',
      '--forum-id',
      'F-1',
      '--format',
      'text',
    ]);
    expect(r.stdout).toBe('Failed to unsubscribe from forum.');
    expect(r.exitCode).toBe(1);
    // HandledError must reach the entry point unclassified — a second pass
    // through handleError would print its empty message here.
    expect(r.stderr).toBe('');
  });
});

describe('yunqi subscribe — 结果文案', () => {
  it('成功时输出订阅文案', async () => {
    const r = await runCommand(build, [
      'yunqi',
      'subscribe',
      'forum',
      '--forum-id',
      'F-2',
      '--format',
      'text',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toBe('Successfully subscribed to forum.');
    expect(state.forumIds).toEqual(['F-2']);
  });

  it('失败时输出订阅失败文案并以 exit 1 结束', async () => {
    state.subscribeResult = false;
    const r = await runCommand(build, [
      'yunqi',
      'subscribe',
      'forum',
      '--forum-id',
      'F-2',
      '--format',
      'text',
    ]);
    expect(r.stdout).toBe('Failed to subscribe to forum.');
    expect(r.exitCode).toBe(1);
  });
});

describe('yunqi subscribe/unsubscribe — JSON 输出', () => {
  it.each([
    ['subscribe', true],
    ['subscribe', false],
    ['unsubscribe', true],
    ['unsubscribe', false],
  ] as const)('%s 输出 { success: %s } 信封并按结果设置退出码', async (command, success) => {
    state.subscribeResult = success;
    state.unsubscribeResult = success;
    const r = await runCommand(build, [
      'yunqi',
      command,
      'forum',
      '--forum-id',
      'F-3',
      '--format',
      'json',
    ]);
    // C-022: the structured result stays on stdout; only the exit code moves.
    expect(JSON.parse(r.stdout)).toEqual({ success });
    expect(r.exitCode).toBe(success ? undefined : 1);
    expect(r.stderr).toBe('');
  });
});

describe('yunqi subscribe/unsubscribe — resource 位置参数校验', () => {
  it.each(['subscribe', 'unsubscribe'])('%s 接受文档化的 forum', async (command) => {
    const r = await runCommand(build, [
      'yunqi',
      command,
      'forum',
      '--forum-id',
      'F-1',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(state.forumIds).toEqual(['F-1']);
  });

  it.each(['subscribe', 'unsubscribe'])('%s 省略资源名时同样可用', async (command) => {
    const r = await runCommand(build, ['yunqi', command, '--forum-id', 'F-1', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(state.forumIds).toEqual(['F-1']);
  });

  it.each(['subscribe', 'unsubscribe'])('%s 拒绝拼错的资源名且不触达服务层', async (command) => {
    const r = await runCommand(build, [
      'yunqi',
      command,
      'forums',
      '--forum-id',
      'F-1',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe('INVALID_ARGUMENT');
    expect(r.stderr).toContain("Unknown resource 'forums'");
    expect(state.forumIds).toEqual([]);
  });
});
