/**
 * Command-layer tests for `audio transcribe`.
 *
 * These exercise the real Commander wiring through runCommand, substituting
 * only the service factory boundary. Focus: flag surface, argument forwarding,
 * timeout coercion, exit codes, and JSON envelope emission.
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
vi.mock('../../../src/services/asr-runtime.js', () => ({
  createASRService: () => ({
    generate: (input: unknown) => holder.generate(input),
  }),
}));

const { registerAudioCommands } = await import('../../../src/commands/audio/index.js');

function okOutcome(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { envelope: { meta: {}, data }, completed: true };
}

beforeEach(() => {
  holder.generate = vi.fn().mockResolvedValue(okOutcome({ task_status: 'SUCCEEDED', urls: [] }));
});

describe('audio transcribe — flag surface', () => {
  it('registers every tier 1/2/3 and run-control flag on the transcribe command', () => {
    const program = new Command().name('qianwen');
    registerAudioCommands(program);
    const audio = program.commands.find((c) => c.name() === 'audio')!;
    const transcribe = audio.commands.find((c) => c.name() === 'transcribe')!;
    const flags = transcribe.options.map((o) => o.long);

    for (const flag of [
      '--model',
      '--language',
      '--wait',
      '--no-wait',
      '--timeout',
      '--request',
      '--format',
      '--api-key',
    ]) {
      expect(flags).toContain(flag);
    }
  });
});

describe('audio transcribe — argument forwarding', () => {
  it('forwards the source argument and tier flags into the service input', async () => {
    await runCommand(
      (program) => registerAudioCommands(program),
      [
        'audio',
        'transcribe',
        'meeting.mp3',
        '--model',
        'fun-asr',
        '--language',
        'zh',
        '--format',
        'json',
      ],
    );

    expect(holder.generate).toHaveBeenCalledTimes(1);
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.source).toBe('meeting.mp3');
    expect(input.model).toBe('fun-asr');
    expect(input.language).toBe('zh');
  });

  it('defaults wait to true and forwards --no-wait as wait=false', async () => {
    await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', 'm.mp3', '--no-wait', '--format', 'json'],
    );
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.wait).toBe(false);
  });

  it('coerces --timeout seconds into milliseconds', async () => {
    await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', 'm.mp3', '--timeout', '30', '--format', 'json'],
    );
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.timeoutMs).toBe(30000);
  });
});

describe('audio transcribe — output and exit codes', () => {
  it('prints the success envelope as JSON', async () => {
    holder.generate = vi
      .fn()
      .mockResolvedValue(okOutcome({ task_status: 'SUCCEEDED', urls: ['u'] }));

    const result = await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', 'm.mp3', '--format', 'json'],
    );

    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.task_status).toBe('SUCCEEDED');
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('prints the transcript and a truncation notice when the preview was capped', async () => {
    holder.generate = vi.fn().mockResolvedValue(
      okOutcome({
        task_status: 'SUCCEEDED',
        urls: ['https://mock-api.test.qianwenai.com/r.json'],
        text: '你好世界',
        text_truncated: true,
        text_limit: 200,
      }),
    );

    const result = await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', 'm.mp3', '--format', 'text'],
    );

    expect(result.stdout).toContain('转写完成');
    expect(result.stdout).toContain('你好世界');
    expect(result.stdout).toContain('正文输出已超出 200 字限制');
  });

  it('renders --no-wait as a successful submitted task, not a completed transcription', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      envelope: {
        meta: { model: 'fun-asr' },
        data: { task_status: 'PENDING', task_id: 'at-submit' },
      },
      completed: false,
    });

    const result = await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', 'm.mp3', '--no-wait', '--format', 'text'],
    );

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain('已提交转写任务');
    expect(result.stdout).toContain('task_id at-submit · status PENDING');
    expect(result.stdout).not.toContain('转写完成');
  });

  it('exits 8 when the task did not complete before the timeout', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      envelope: {
        meta: {},
        data: { task_status: 'running', task_id: 'at-x', hint: 'task get at-x' },
      },
      completed: false,
    });

    const result = await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', 'm.mp3', '--format', 'json'],
    );

    expect(result.exitCode).toBe(8);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.task_id).toBe('at-x');
  });

  it('exits 4 for a non-numeric --timeout', async () => {
    const result = await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', 'm.mp3', '--timeout', 'abc', '--format', 'json'],
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
      (program) => registerAudioCommands(program),
      ['audio', 'transcribe', '--format', 'json'],
    );
    expect(result.exitCode).toBe(4);
  });
});

describe('audio transcribe — command group help', () => {
  it('registers the audio command with a transcribe subcommand', () => {
    const program = new Command().name('qianwen');
    registerAudioCommands(program);
    const audio = program.commands.find((c) => c.name() === 'audio')!;
    expect(audio).toBeDefined();
    expect(audio.commands.map((c) => c.name())).toContain('transcribe');
  });
});
