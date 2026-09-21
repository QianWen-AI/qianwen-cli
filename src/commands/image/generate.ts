import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand, resolveExplicitFormat } from '../../output/format.js';
import {
  detail,
  expiryNote,
  hintText,
  labelText,
  readImages,
  readNumber,
  readString,
  renderInvocation,
  savedLines,
  submittedView,
  title,
} from '../../output/invocation-view.js';
import type { SuccessEnvelope } from '../../types/invocation-params.js';
import type { ResolvedFormat } from '../../types/config.js';
import { handleError, CliError } from '../../utils/errors.js';
import { preflightOutPath } from '../../utils/out-path.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { createImageService } from '../../services/image-runtime.js';
import type { ImageGenerateInput } from '../../services/image-service.js';
import { withSpinner } from '../../ui/spinner.js';

function coerceCount(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid value "${raw}" for --n. Must be a positive integer.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
  return value;
}

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

export function imageGenerateAction(
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
      const input: ImageGenerateInput = {};
      if (typeof prompt === 'string' && prompt.length > 0) input.prompt = prompt;
      if (typeof options.model === 'string') input.model = options.model;
      if (typeof options.size === 'string') input.size = options.size;
      if (typeof options.n === 'string') input.n = coerceCount(options.n);
      if (typeof options.image === 'string') input.image = options.image;
      if (typeof options.out === 'string') input.out = options.out;
      if (options.responseFormat === 'b64') input.responseFormat = 'b64';
      if (typeof options.request === 'string') input.request = options.request;
      if (typeof options.timeout === 'string') input.timeoutMs = coerceTimeout(options.timeout);
      if (options.wait === false) input.wait = false;
      preflightOutPath(input.out);
      const runtimeOptions: { apiKey?: string; silentGuard?: boolean } = {
        silentGuard: resolveExplicitFormat(this ?? cmd) === 'json',
      };
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createImageService(runtimeOptions);
      const envelope = await withSpinner('图片生成中', () => service.generate(input), format);
      if (service.lastDeprecationNotice) {
        envelope.meta.model_offline_warning = service.lastDeprecationNotice;
      }
      renderImage(envelope, format);
    } catch (error) {
      handleError(error, format);
    }
  };
}

function renderImage(envelope: SuccessEnvelope, format: ResolvedFormat): void {
  renderInvocation(envelope, format, (data, meta) => {
    const images = readImages(data);
    const taskId = readString(data, 'task_id');
    if (images.length === 0 && taskId !== undefined) {
      return submittedView(data, '已提交图片生成任务');
    }
    const savedPaths = images
      .map((a) => a.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    const remoteUrls = images
      .map((a) => a.url)
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    const hasB64 = images.some((a) => a.b64 !== undefined);

    const lines: string[] = [
      title(images.length === 1 ? '已生成 1 张图片' : `已生成 ${images.length} 张图片`),
    ];

    if (savedPaths.length > 0) {
      lines.push(...savedLines(savedPaths));
      lines.push(detail(hintText('已保存到本地，原始 URL 24h 后失效')));
    } else if (remoteUrls.length > 0) {
      for (let i = 0; i < remoteUrls.length; i += 1) {
        const expires = images[i]?.expires_in;
        lines.push(
          detail(`${labelText('image_url')}  ${remoteUrls[i]}${expiryNote(expires ?? '24h')}`),
        );
      }
    } else if (hasB64) {
      lines.push(detail(hintText('图片以 base64 返回')));
    }

    const width = readNumber(meta.usage, 'width');
    const height = readNumber(meta.usage, 'height');
    const size =
      width !== undefined && height !== undefined ? `${width}*${height}` : readString(data, 'size');

    return {
      body: lines.join('\n'),
      footerExtras: [size !== undefined ? `size ${size}` : ''],
    };
  });
}

export function registerImageGenerateCommand(parent: Command): Command {
  const generate = parent
    .command('generate [prompt]')
    .description('Generate or edit an image')
    .option('--model <id>', 'Model to use (tier 1)')
    .option('--size <width*height>', 'Output image size, e.g. 1024*1024 (tier 2)')
    .option('--n <count>', 'Number of images to generate (tier 2)')
    .option('--image <path-or-url>', 'Source image to edit (tier 2)')
    .option('--out <path>', 'Output file or directory for downloaded images (tier 2)')
    .option(
      '--response-format <fmt>',
      'Set to b64 to return base64 instead of downloading (tier 2)',
    )
    .option('--request <json|@file|->', 'Native request body passthrough (tier 3)')
    .option('--no-wait', 'Return the task id immediately for async models instead of waiting')
    .option(
      '--timeout <seconds>',
      'Maximum seconds to wait for the synthesis response (default: 300)',
    )
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  generate.action(imageGenerateAction(generate));
  return generate;
}
