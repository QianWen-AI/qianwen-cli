/** `model3d generate` — asynchronous text/image-to-3D synthesis with tier 2 convenience flags and tier 3 passthrough. */

import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand } from '../../output/format.js';
import {
  detail,
  expiryNote,
  hintText,
  labelText,
  readString,
  renderInvocation,
  savedLines,
  submittedView,
  title,
} from '../../output/invocation-view.js';
import { handleError, CliError, HandledError } from '../../utils/errors.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { preflightOutPath } from '../../utils/out-path.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { createModel3dService } from '../../services/model3d-runtime.js';
import type { Model3dGenerateInput } from '../../services/model3d-service.js';
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

export function model3dGenerateAction(
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
      const input: Model3dGenerateInput = {};
      if (typeof prompt === 'string' && prompt.length > 0) input.prompt = prompt;
      if (typeof options.model === 'string') input.model = options.model;
      if (typeof options.image === 'string') input.image = options.image;
      if (typeof options.textureQuality === 'string') input.textureQuality = options.textureQuality;
      if (options.wait === false) input.wait = false;
      if (typeof options.timeout === 'string') input.timeoutMs = coerceTimeout(options.timeout);
      if (typeof options.out === 'string') input.out = options.out;
      if (typeof options.request === 'string') input.request = options.request;

      preflightOutPath(input.out);
      ensureAuthenticated();
      const runtimeOptions: { apiKey?: string } = {};
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createModel3dService(runtimeOptions);
      const label = input.wait === false ? '提交 3D 模型生成任务' : '3D 模型生成中';
      const outcome = await withSpinner(label, () => service.generate(input), format);
      renderModel3d(outcome.envelope, format, outcome.completed);

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
 * Human-readable view for 3D generation. Download URLs are valid for only 2h,
 * so the completed view leads with the local files that were saved.
 */
function renderModel3d(
  envelope: SuccessEnvelope,
  format: ResolvedFormat,
  completed: boolean,
): void {
  renderInvocation(envelope, format, (data) => {
    const taskId = readString(data, 'task_id');

    if (!completed) {
      return submittedView(data, '已提交 3D 生成任务', '（task ID 24h 内可续查）');
    }

    const lines = [title('3D 模型生成完成')];
    const fileList = Array.isArray(data.files)
      ? (data.files as Array<Record<string, unknown>>)
      : [];
    const paths = fileList
      .map((f) => f.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);

    if (paths.length > 0) {
      lines.push(...savedLines(paths));
      lines.push(detail(hintText('已保存到本地，下载 URL 仅 2h 有效（task ID 24h 内可续查）')));
    } else {
      for (const file of fileList) {
        const url = typeof file.url === 'string' ? file.url : undefined;
        if (url === undefined) continue;
        const kind = typeof file.type === 'string' ? file.type : 'file';
        const expires = typeof file.expires_in === 'string' ? file.expires_in : '2h';
        lines.push(detail(`${labelText(kind)}  ${url}${expiryNote(expires)}`));
      }
      lines.push(detail(hintText('下载 URL 仅 2h 有效（task ID 24h 内可续查）')));
    }

    return {
      body: lines.join('\n'),
      footerExtras: [taskId !== undefined ? `task_id ${taskId}（24h）` : ''],
    };
  });
}

export function registerModel3dGenerateCommand(parent: Command): Command {
  const generate = parent
    .command('generate [prompt]')
    .description('Generate a 3D model from text or a single image')
    .option('--model <id>', 'Model to use (tier 1)')
    .option('--image <path-or-url>', 'Single reference image to generate 3D from (tier 2)')
    .option('--texture-quality <level>', 'Texture quality: standard or detailed (tier 2)')
    .option('--wait', 'Wait for the task to complete (default)')
    .option('--no-wait', 'Return the task id immediately without waiting')
    .option('--timeout <seconds>', 'Maximum seconds to wait for completion')
    .option('--out <path>', 'Output file or directory for downloaded assets (tier 2)')
    .option('--request <json|@file|->', 'Native request body passthrough (tier 3)')
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  generate.action(model3dGenerateAction(generate));
  return generate;
}
