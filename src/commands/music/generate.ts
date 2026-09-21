import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import { mediaView, renderInvocation } from '../../output/invocation-view.js';
import { handleError, CliError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { preflightOutPath } from '../../utils/out-path.js';
import { createMusicService } from '../../services/music-runtime.js';
import type { MusicGenerateInput } from '../../services/music-service.js';
import type { SuccessEnvelope } from '../../types/invocation-params.js';
import type { ResolvedFormat } from '../../types/config.js';
import { withSpinner } from '../../ui/spinner.js';

function coerceTimeout(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid value "${raw}" for --timeout. Must be a positive number of seconds.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
  return Math.round(seconds * 1000);
}

export function musicGenerateAction(
  cmd: Command,
): (this: Command, prompt: string | undefined, options: Record<string, unknown>) => Promise<void> {
  return async function (
    this: Command,
    prompt: string | undefined,
    options: Record<string, unknown>,
  ) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      const input: MusicGenerateInput = {};
      if (typeof prompt === 'string' && prompt.length > 0) input.prompt = prompt;
      if (typeof options.model === 'string') input.model = options.model;
      if (typeof options.out === 'string') input.out = options.out;
      if (typeof options.request === 'string') input.request = options.request;
      if (typeof options.timeout === 'string') input.timeoutMs = coerceTimeout(options.timeout);
      if (options.stream === false) input.stream = false;
      preflightOutPath(input.out);
      const runtimeOptions: { apiKey?: string } = {};
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createMusicService(runtimeOptions);
      const envelope = await withSpinner('音乐生成中', () => service.generate(input), format);
      renderMusic(envelope, format);
    } catch (error) {
      handleError(error, format);
    }
  };
}

function renderMusic(envelope: SuccessEnvelope, format: ResolvedFormat): void {
  renderInvocation(envelope, format, (data) =>
    mediaView(data, {
      title: '音乐生成完成',
      urlLabel: 'audio_url',
      expiresIn: '24h',
    }),
  );
}

export function registerMusicGenerateCommand(parent: Command): Command {
  const generate = parent
    .command('generate [prompt]')
    .description('Generate music from a text prompt')
    .option('--model <id>', 'Model to use (tier 1)')
    .option('--out <path>', 'Output file or directory for the downloaded audio (tier 2)')
    .option(
      '--timeout <seconds>',
      'Maximum seconds to wait for the synthesis response (default: 300)',
    )
    .option(
      '--no-stream',
      'Wait for the whole response in one blocking request instead of streaming (SSE)',
    )
    .option('--request <json|@file|->', 'Native request body passthrough (tier 3)')
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  generate.action(musicGenerateAction(generate));
  return generate;
}
