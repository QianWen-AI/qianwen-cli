/** `audio transcribe` — asynchronous recorded-audio transcription with tier 2 convenience flags and tier 3 passthrough. */

import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand, resolveExplicitFormat } from '../../output/format.js';
import {
  detail,
  expiryNote,
  readNumber,
  readString,
  renderInvocation,
  submittedView,
  title,
} from '../../output/invocation-view.js';
import { handleError, CliError, HandledError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { createASRService } from '../../services/asr-runtime.js';
import type { AudioTranscribeInput } from '../../services/asr-service.js';
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

export function audioTranscribeAction(
  cmd: Command,
): (this: Command, source: string | undefined, options: Record<string, unknown>) => Promise<void> {
  return async function (
    this: Command,
    source: string | undefined,
    options: Record<string, unknown>,
  ) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      const input: AudioTranscribeInput = {};
      if (typeof source === 'string' && source.length > 0) input.source = source;
      if (typeof options.model === 'string') input.model = options.model;
      if (typeof options.language === 'string') input.language = options.language;
      if (options.wait === false) input.wait = false;
      if (typeof options.timeout === 'string') input.timeoutMs = coerceTimeout(options.timeout);
      if (typeof options.request === 'string') input.request = options.request;

      const runtimeOptions: { apiKey?: string; silentGuard?: boolean } = {
        silentGuard: resolveExplicitFormat(this ?? cmd) === 'json',
      };
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createASRService(runtimeOptions);
      const label = input.wait === false ? '提交语音转写任务' : '语音转写中';
      const outcome = await withSpinner(label, () => service.generate(input), format);
      if (service.lastDeprecationNotice) {
        outcome.envelope.meta.model_offline_warning = service.lastDeprecationNotice;
      }
      renderTranscribe(outcome.envelope, format, outcome.completed);

      // A wait timeout is a non-success exit, while an intentional --no-wait
      // is a successful submission even though the remote task is incomplete.
      if (input.wait !== false && !outcome.completed) {
        throw new HandledError(EXIT_CODES.TASK_NOT_COMPLETED);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}

/**
 * Human-readable view for transcription: the transcript itself when available,
 * otherwise the result-file URL, plus a `model · 音频 Ns · task_id` footer.
 */
function renderTranscribe(
  envelope: SuccessEnvelope,
  format: ResolvedFormat,
  completed: boolean,
): void {
  renderInvocation(envelope, format, (data, meta) => {
    if (!completed) {
      return submittedView(data, '已提交转写任务');
    }

    const lines = [title('转写完成')];

    const text = readString(data, 'text');
    if (text !== undefined) {
      lines.push(detail(text));
      if (data.text_truncated === true) {
        const limit = readNumber(data, 'text_limit') ?? 200;
        lines.push(detail(`正文输出已超出 ${limit} 字限制，完整内容请借助 URL 下载`));
      }
      lines.push('');
    }

    const resultUrl = readString(data, 'transcription_url') ?? firstUrl(data);
    if (resultUrl !== undefined) {
      lines.push(detail(`结果文件 ${resultUrl}${expiryNote('24h')}`));
    }

    const taskId = readString(data, 'task_id');
    const duration = readNumber(meta.usage, 'duration') ?? readNumber(meta.usage, 'seconds');
    return {
      body: lines.join('\n'),
      footerExtras: [
        duration !== undefined ? `音频 ${duration}s` : '',
        taskId !== undefined ? `task_id ${taskId}` : '',
      ],
    };
  });
}

function firstUrl(data: Record<string, unknown>): string | undefined {
  const raw = data.urls;
  if (!Array.isArray(raw)) return undefined;
  return raw.find((u): u is string => typeof u === 'string' && u.length > 0);
}

export function registerAudioTranscribeCommand(parent: Command): Command {
  const transcribe = parent
    .command('transcribe [file-or-url]')
    .description('Transcribe a recorded audio file or URL')
    .option('--model <id>', 'Model to use (tier 1)')
    .option('--language <hint>', 'Language hint for recognition (tier 2)')
    .option('--wait', 'Wait for the task to complete (default)')
    .option('--no-wait', 'Return the task id immediately without waiting')
    .option('--timeout <seconds>', 'Maximum seconds to wait for completion')
    .option(
      '--request <json|@file|->',
      'Native request body passthrough (tier 3); parameters.format is auto-inferred from the audio URL for Qwen models',
    )
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  transcribe.action(audioTranscribeAction(transcribe));
  return transcribe;
}
