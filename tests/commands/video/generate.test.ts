/**
 * Command-layer tests for `video generate`.
 *
 * These exercise the real Commander wiring through runCommand, substituting
 * only the service factory boundary. Focus: flag surface, argument validation
 * exit codes, flag forwarding, timeout exit code, and JSON envelope emission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { runCommand } from '../../helpers/run-command.js';

const holder: { generate: ReturnType<typeof vi.fn> } = {
  generate: vi.fn(),
};

vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({}),
}));
vi.mock('../../../src/services/video-runtime.js', () => ({
  createVideoService: () => ({
    generate: (input: unknown) => holder.generate(input),
  }),
}));

const { registerVideoCommands } = await import('../../../src/commands/video/index.js');

function okOutcome(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { envelope: { meta: {}, data }, completed: true };
}

beforeEach(() => {
  holder.generate = vi.fn().mockResolvedValue(okOutcome({ task_status: 'SUCCEEDED', urls: [] }));
});

describe('video generate — flag surface', () => {
  it('registers every tier 1/2/3 and run-control flag on the generate command', () => {
    const program = new Command().name('qianwen');
    registerVideoCommands(program);
    const video = program.commands.find((c) => c.name() === 'video')!;
    const generate = video.commands.find((c) => c.name() === 'generate')!;
    const flags = generate.options.map((o) => o.long);

    for (const flag of [
      '--model',
      '--image',
      '--wait',
      '--no-wait',
      '--timeout',
      '--out',
      '--request',
      '--format',
      '--api-key',
    ]) {
      expect(flags).toContain(flag);
    }
  });
});

describe('video generate — flag forwarding', () => {
  it('forwards prompt and tier flags into the service input', async () => {
    await runCommand(
      (program) => registerVideoCommands(program),
      [
        'video',
        'generate',
        'a running cat',
        '--model',
        'wan2.7-i2v',
        '--image',
        'cat.png',
        '--out',
        'cat.mp4',
        '--format',
        'json',
      ],
    );

    expect(holder.generate).toHaveBeenCalledTimes(1);
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.prompt).toBe('a running cat');
    expect(input.model).toBe('wan2.7-i2v');
    expect(input.image).toBe('cat.png');
    expect(input.out).toBe('cat.mp4');
  });

  it('defaults wait to true and forwards --no-wait as wait=false', async () => {
    await runCommand(
      (program) => registerVideoCommands(program),
      ['video', 'generate', 'p', '--no-wait', '--format', 'json'],
    );
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.wait).toBe(false);
  });

  it('coerces --timeout into milliseconds on the service input', async () => {
    await runCommand(
      (program) => registerVideoCommands(program),
      ['video', 'generate', 'p', '--timeout', '60', '--format', 'json'],
    );
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.timeoutMs).toBe(60000);
  });
});

describe('video generate — output and exit codes', () => {
  it('prints the success envelope as JSON', async () => {
    holder.generate = vi
      .fn()
      .mockResolvedValue(okOutcome({ task_status: 'SUCCEEDED', urls: ['u'] }));

    const result = await runCommand(
      (program) => registerVideoCommands(program),
      ['video', 'generate', 'p', '--format', 'json'],
    );

    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.task_status).toBe('SUCCEEDED');
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('renders --no-wait as a successful submitted task, not a completed video', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      envelope: {
        meta: { model: 'wan2.7-t2v' },
        data: { task_status: 'PENDING', task_id: 'vt-submit' },
      },
      completed: false,
    });

    const result = await runCommand(
      (program) => registerVideoCommands(program),
      ['video', 'generate', 'p', '--no-wait', '--format', 'text'],
    );

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain('已提交视频生成任务');
    expect(result.stdout).toContain('task_id vt-submit · status PENDING');
    expect(result.stdout).toContain('qianwen task get vt-submit');
    expect(result.stdout).not.toContain('视频生成完成');
  });

  it('exits 8 when the task did not complete before the timeout', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      envelope: {
        meta: {},
        data: { task_status: 'running', task_id: 'vt-x', hint: 'task get vt-x' },
      },
      completed: false,
    });

    const result = await runCommand(
      (program) => registerVideoCommands(program),
      ['video', 'generate', 'p', '--format', 'json'],
    );

    expect(result.exitCode).toBe(8);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.task_id).toBe('vt-x');
  });

  it('exits 4 for a non-numeric --timeout', async () => {
    const result = await runCommand(
      (program) => registerVideoCommands(program),
      ['video', 'generate', 'p', '--timeout', 'abc', '--format', 'json'],
    );
    expect(result.exitCode).toBe(4);
  });

  it('exits 4 when the service rejects an invalid argument combination', async () => {
    holder.generate = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('bad'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerVideoCommands(program),
      ['video', 'generate', 'p', '--image', 'x.png', '--model', 'wan2.7-t2v', '--format', 'json'],
    );
    expect(result.exitCode).toBe(4);
  });
});

describe('video generate — command group help', () => {
  it('registers the video command with a generate subcommand', () => {
    const program = new Command().name('qianwen');
    registerVideoCommands(program);
    const video = program.commands.find((c) => c.name() === 'video')!;
    expect(video).toBeDefined();
    expect(video.commands.map((c) => c.name())).toContain('generate');
  });
});
