/**
 * Command-layer tests for `audio speech`.
 *
 * These exercise the real Commander wiring through runCommand, substituting
 * only the service factory boundary. Focus: flag surface, argument forwarding,
 * exit codes, and JSON envelope emission.
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
vi.mock('../../../src/services/tts-runtime.js', () => ({
  createTTSService: () => ({
    generate: (input: unknown) => holder.generate(input),
  }),
}));

const { registerAudioCommands } = await import('../../../src/commands/audio/index.js');

function okEnvelope(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: {}, data };
}

beforeEach(() => {
  holder.generate = vi
    .fn()
    .mockResolvedValue(okEnvelope({ output: { audio: { url: 'u' } }, artifacts: [{ url: 'u' }] }));
});

describe('audio speech — flag surface', () => {
  it('registers every tier 1/2/3 flag on the speech command', () => {
    const program = new Command().name('qianwen');
    registerAudioCommands(program);
    const audio = program.commands.find((c) => c.name() === 'audio')!;
    const speech = audio.commands.find((c) => c.name() === 'speech')!;
    const flags = speech.options.map((o) => o.long);

    for (const flag of ['--model', '--voice', '--out', '--request', '--format', '--api-key']) {
      expect(flags).toContain(flag);
    }
  });

  it('does not expose async run-control flags on a synchronous command', () => {
    const program = new Command().name('qianwen');
    registerAudioCommands(program);
    const audio = program.commands.find((c) => c.name() === 'audio')!;
    const speech = audio.commands.find((c) => c.name() === 'speech')!;
    const flags = speech.options.map((o) => o.long);

    expect(flags).not.toContain('--wait');
    expect(flags).not.toContain('--timeout');
  });
});

describe('audio speech — argument forwarding', () => {
  it('forwards the text argument and tier flags into the service input', async () => {
    await runCommand(
      (program) => registerAudioCommands(program),
      [
        'audio',
        'speech',
        '欢迎使用千问云',
        '--model',
        'qwen3-tts-flash',
        '--voice',
        'Cherry',
        '--out',
        'hello.wav',
        '--format',
        'json',
      ],
    );

    expect(holder.generate).toHaveBeenCalledTimes(1);
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.text).toBe('欢迎使用千问云');
    expect(input.model).toBe('qwen3-tts-flash');
    expect(input.voice).toBe('Cherry');
    expect(input.out).toBe('hello.wav');
  });

  it('forwards --request passthrough into the service input', async () => {
    await runCommand(
      (program) => registerAudioCommands(program),
      [
        'audio',
        'speech',
        '--request',
        '{"model":"qwen3-tts-flash","input":{"text":"你好"}}',
        '--format',
        'json',
      ],
    );

    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.request).toBe('{"model":"qwen3-tts-flash","input":{"text":"你好"}}');
  });
});

describe('audio speech — output and exit codes', () => {
  it('prints the success envelope as JSON', async () => {
    const result = await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'speech', 'hi', '--format', 'json'],
    );

    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.artifacts[0].url).toBe('u');
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('exits 4 when the service rejects an invalid argument combination', async () => {
    holder.generate = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('bad'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerAudioCommands(program),
      ['audio', 'speech', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });
});

describe('audio speech — command group help', () => {
  it('lists both transcribe and speech under the audio group', () => {
    const program = new Command().name('qianwen');
    registerAudioCommands(program);
    const audio = program.commands.find((c) => c.name() === 'audio')!;
    const names = audio.commands.map((c) => c.name());
    expect(names).toContain('transcribe');
    expect(names).toContain('speech');
  });
});
