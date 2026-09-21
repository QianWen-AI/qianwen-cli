/** `video generate` — asynchronous video synthesis with tier 2 convenience flags and tier 3 passthrough. */

import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand, resolveExplicitFormat } from '../../output/format.js';
import {
  detail,
  expiryNote,
  hintText,
  labelText,
  readNumber,
  readString,
  renderInvocation,
  savedLines,
  submittedView,
  title,
} from '../../output/invocation-view.js';
import { handleError, CliError, HandledError } from '../../utils/errors.js';
import { preflightOutPath } from '../../utils/out-path.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { createVideoService } from '../../services/video-runtime.js';
import type { VideoGenerateInput } from '../../services/video-service.js';
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

export function videoGenerateAction(
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
      const input: VideoGenerateInput = {};
      if (typeof prompt === 'string' && prompt.length > 0) input.prompt = prompt;
      if (typeof options.model === 'string') input.model = options.model;
      if (typeof options.image === 'string') input.image = options.image;
      if (options.wait === false) input.wait = false;
      if (typeof options.timeout === 'string') input.timeoutMs = coerceTimeout(options.timeout);
      if (typeof options.out === 'string') input.out = options.out;
      if (typeof options.request === 'string') input.request = options.request;

      preflightOutPath(input.out);
      const runtimeOptions: { apiKey?: string; silentGuard?: boolean } = {
        silentGuard: resolveExplicitFormat(this ?? cmd) === 'json',
      };
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createVideoService(runtimeOptions);
      const label = input.wait === false ? '提交视频生成任务' : '视频生成中';
      const outcome = await withSpinner(label, () => service.generate(input), format);
      if (service.lastDeprecationNotice) {
        outcome.envelope.meta.model_offline_warning = service.lastDeprecationNotice;
      }
      renderVideo(outcome.envelope, format, outcome.completed);

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
 * Human-readable view for video generation. Incomplete tasks (`--no-wait` or a
 * wait timeout) render the submitted form with a `task get` pointer; completed
 * ones show the URL, any saved path, and the clip's shape.
 */
function renderVideo(envelope: SuccessEnvelope, format: ResolvedFormat, completed: boolean): void {
  renderInvocation(envelope, format, (data, meta) => {
    const taskId = readString(data, 'task_id');

    if (!completed) {
      return submittedView(data, '已提交视频生成任务');
    }

    const lines = [title('视频生成完成')];

    const savedPath = readString(data, 'path');
    if (savedPath !== undefined) lines.push(...savedLines([savedPath]));

    const url = readString(data, 'video_url');
    const expires = readString(data, 'expires_in') ?? '24h';
    if (url !== undefined) {
      lines.push(detail(`${labelText('video_url')}  ${url}${expiryNote(expires)}`));
    }

    // `10s · 16:9 · 720P` — only the parts the backend actually reported.
    const duration = readNumber(meta.usage, 'output_video_duration');
    const ratio = readString(meta.usage as Record<string, unknown>, 'ratio');
    const sr = readNumber(meta.usage, 'SR');
    const shape = [
      duration !== undefined ? `${duration}s` : '',
      ratio !== undefined ? ratio : '',
      sr !== undefined ? `${sr}P` : '',
    ].filter((s) => s.length > 0);
    if (shape.length > 0) lines.push(detail(shape.join(' · ')));

    if (savedPath === undefined && url !== undefined) {
      lines.push(detail(hintText(`URL ${expires} 后失效；加 --out <path> 可保存到本地`)));
    }

    return {
      body: lines.join('\n'),
      footerExtras: [taskId !== undefined ? `task_id ${taskId}` : ''],
    };
  });
}

export function registerVideoGenerateCommand(parent: Command): Command {
  const generate = parent
    .command('generate [prompt]')
    .description('Generate or edit a video')
    .option('--model <id>', 'Model to use (tier 1)')
    .option(
      '--image <path-or-url>',
      'Source image used as the first frame; switches to I2V (tier 2)',
    )
    .option('--wait', 'Wait for the task to complete (default)')
    .option('--no-wait', 'Return the task id immediately without waiting')
    .option('--timeout <seconds>', 'Maximum seconds to wait for completion')
    .option('--out <path>', 'Output file or directory for the downloaded video (tier 2)')
    .option('--request <json|@file|->', 'Native request body passthrough (tier 3)')
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  generate.action(videoGenerateAction(generate));
  return generate;
}
