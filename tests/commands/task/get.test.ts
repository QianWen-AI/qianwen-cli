/**
 * Command-layer tests for `task get`.
 *
 * These exercise the real Commander wiring through runCommand, substituting
 * only the service factory boundary. Focus: flag surface, missing-argument
 * handling, service error exit-code propagation, and JSON envelope emission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { runCommand } from '../../helpers/run-command.js';

const holder: { get: ReturnType<typeof vi.fn> } = {
  get: vi.fn(),
};

vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({}),
}));
vi.mock('../../../src/services/task-runtime.js', () => ({
  createTaskService: () => ({
    get: (taskId: string, out?: string) => holder.get(taskId, out),
  }),
}));

const { registerTaskCommands } = await import('../../../src/commands/task/index.js');

beforeEach(() => {
  holder.get = vi.fn().mockResolvedValue({ meta: {}, data: { task_status: 'SUCCEEDED' } });
});

describe('task get — flag surface', () => {
  it('exposes the format flag and the api-key flag, but no invocation tier flags', () => {
    const program = new Command().name('qianwen');
    registerTaskCommands(program);
    const task = program.commands.find((c) => c.name() === 'task')!;
    const get = task.commands.find((c) => c.name() === 'get')!;
    const flags = get.options.map((o) => o.long);

    expect(flags).toContain('--format');
    expect(flags).toContain('--api-key');
    expect(flags).toContain('--out');
    expect(flags).not.toContain('--model');
    expect(flags).not.toContain('--request');
    expect(flags).not.toContain('--wait');
  });
});

describe('task get — argument handling', () => {
  it('forwards the task id to the service', async () => {
    await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'abc-123', '--format', 'json'],
    );

    expect(holder.get.mock.calls[0]![0]).toBe('abc-123');
  });

  it('propagates a service-level validation error exit code', async () => {
    holder.get = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('empty id'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', '   ', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });
});

describe('task get — output', () => {
  it('prints the success envelope as JSON', async () => {
    holder.get = vi.fn().mockResolvedValue({
      meta: { request_id: 'q-1' },
      data: {
        task_id: 'abc',
        task_status: 'SUCCEEDED',
        urls: ['https://mock-api.test.qianwenai.com/out.mp4'],
      },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'abc', '--format', 'json'],
    );

    const payload = JSON.parse(result.stdout) as {
      meta: { request_id: string };
      data: { task_status: string; urls: string[] };
    };
    expect(payload.meta.request_id).toBe('q-1');
    expect(payload.data.task_status).toBe('SUCCEEDED');
    expect(payload.data.urls).toHaveLength(1);
    expect(result.exitCode).toBeUndefined();
  });

  it('prints task status in uppercase for human-readable output', async () => {
    holder.get = vi.fn().mockResolvedValue({
      meta: { request_id: 'q-2' },
      data: {
        task_id: 'abc',
        task_status: 'succeeded',
        type: 'video',
        urls: ['https://mock-api.test.qianwenai.com/out.mp4'],
      },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'abc', '--format', 'text'],
    );

    expect(result.stdout).toContain('task_id abc · status SUCCEEDED · type video');
    expect(result.stdout).not.toContain('status succeeded');
  });

  it('prints the Fun-ASR result file for a completed transcription task', async () => {
    const transcriptionUrl = 'https://mock-api.test.qianwenai.com/transcription.json';
    holder.get = vi.fn().mockResolvedValue({
      meta: { request_id: 'q-asr' },
      data: {
        task_id: 'asr-1',
        task_status: 'SUCCEEDED',
        type: 'transcription',
        transcription_url: transcriptionUrl,
      },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'asr-1', '--format', 'text'],
    );

    expect(result.stdout).toContain('type transcription');
    expect(result.stdout).toContain(`transcription_url  ${transcriptionUrl}`);
  });

  it('forwards --out to the service', async () => {
    await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'm-1', '--out', 'out/dir', '--format', 'json'],
    );

    expect(holder.get.mock.calls[0]![1]).toBe('out/dir');
  });

  it('leads with saved local files for a completed model3d task', async () => {
    holder.get = vi.fn().mockResolvedValue({
      meta: { request_id: 'q-3d' },
      data: {
        task_id: 'm-1',
        task_status: 'SUCCEEDED',
        type: 'model3d',
        files: [
          {
            type: 'model',
            url: 'https://mock-api.test.qianwenai.com/model.glb',
            path: 'out/model.glb',
          },
          {
            type: 'preview',
            url: 'https://mock-api.test.qianwenai.com/preview.webp',
            path: 'out/preview.webp',
          },
        ],
      },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'm-1', '--format', 'text'],
    );

    expect(result.stdout).toContain('out/model.glb');
    expect(result.stdout).toContain('out/preview.webp');
    expect(result.stdout).not.toContain('model https://');
  });

  it('leads with saved local files for a completed image task', async () => {
    holder.get = vi.fn().mockResolvedValue({
      meta: { request_id: 'q-img' },
      data: {
        task_id: 'i-1',
        task_status: 'SUCCEEDED',
        type: 'image',
        image_url: 'https://mock-api.test.qianwenai.com/a.png',
        path: 'a.png',
      },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'i-1', '--format', 'text'],
    );

    expect(result.stdout).toContain('已保存 a.png');
    expect(result.stdout).toContain('已保存到本地，原始 URL 24h 后失效');
    expect(result.stdout).not.toContain('image_url https://');
  });

  it('prints the transcript preview and a truncation notice when it was capped', async () => {
    const transcriptionUrl = 'https://mock-api.test.qianwenai.com/transcription.json';
    holder.get = vi.fn().mockResolvedValue({
      meta: {},
      data: {
        task_id: 'asr-1',
        task_status: 'SUCCEEDED',
        type: 'transcription',
        transcription_url: transcriptionUrl,
        text: '你好世界',
        text_truncated: true,
        text_limit: 200,
      },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'asr-1', '--format', 'text'],
    );

    expect(result.stdout).toContain('你好世界');
    expect(result.stdout).toContain('正文输出已超出 200 字限制');
    expect(result.stdout).toContain(`transcription_url  ${transcriptionUrl}`);
  });

  it('does not claim a non-standard status is still running', async () => {
    holder.get = vi.fn().mockResolvedValue({
      meta: { request_id: 'q-x' },
      data: { task_id: 'abc', task_status: 'UNKNOWN' },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'abc', '--format', 'text'],
    );

    expect(result.stdout).toContain('status UNKNOWN');
    expect(result.stdout).not.toContain('任务尚未完成');
    expect(result.stdout).toContain('--output json');
  });

  it('still reports pending tasks as not-yet-complete', async () => {
    holder.get = vi.fn().mockResolvedValue({
      meta: {},
      data: { task_id: 'abc', task_status: 'PENDING' },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'abc', '--format', 'text'],
    );

    expect(result.stdout).toContain('任务尚未完成');
  });

  it('shows the failure reason lifted onto data for a FAILED task', async () => {
    holder.get = vi.fn().mockResolvedValue({
      meta: { request_id: 'q-f' },
      data: {
        task_id: 'abc',
        task_status: 'FAILED',
        code: 'InvalidParameter',
        message: 'ratio not supported',
      },
    });

    const result = await runCommand(
      (program) => registerTaskCommands(program),
      ['task', 'get', 'abc', '--format', 'text'],
    );

    expect(result.stdout).toContain('status FAILED');
    expect(result.stdout).toContain('code InvalidParameter');
    expect(result.stdout).toContain('message ratio not supported');
    expect(result.exitCode).toBe(1);
  });
});
