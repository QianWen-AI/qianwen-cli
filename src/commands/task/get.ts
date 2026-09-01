/** `task get` — single query for an asynchronous task by id. */

import type { Command } from 'commander';
import { getEffectiveConfig } from '../../config/manager.js';
import { resolveFormatFromCommand, outputJSON, outputText } from '../../output/format.js';
import {
  detail,
  expiryNote,
  readNumber,
  readString,
  savedLines,
  labelText,
  hintText,
  statusText,
  dot,
} from '../../output/invocation-view.js';
import { handleError, HandledError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { preflightOutPath } from '../../utils/out-path.js';
import { createTaskService } from '../../services/task-runtime.js';
import { theme } from '../../ui/theme.js';
import type { SuccessEnvelope } from '../../types/invocation-params.js';
import type { ResolvedFormat } from '../../types/config.js';

export function taskGetAction(
  cmd: Command,
): (this: Command, taskId: string, options: Record<string, unknown>) => Promise<void> {
  return async function (this: Command, taskId: string, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      ensureAuthenticated();
      const out = typeof options.out === 'string' ? options.out : undefined;
      if (out !== undefined) preflightOutPath(out);
      const runtimeOptions: { apiKey?: string } = {};
      if (typeof options.apiKey === 'string') runtimeOptions.apiKey = options.apiKey;
      const service = createTaskService(runtimeOptions);
      const envelope = await service.get(taskId, out);
      renderTask(envelope, format);
      if ((readString(envelope.data, 'task_status') ?? '').toUpperCase() === 'FAILED') {
        throw new HandledError(EXIT_CODES.GENERAL_ERROR);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}

/** Field name carrying the signed result URL, per task type. */
const URL_FIELDS: Record<string, string> = {
  video: 'video_url',
  audio: 'audio_url',
  image: 'image_url',
  transcription: 'transcription_url',
};

/**
 * Human-readable view for `task get`.
 *
 * Unlike the generation commands this one has no `meta.model` (the task record
 * doesn't carry it), so the footer is just the query's own request_id.
 */
function renderTask(envelope: SuccessEnvelope, format: ResolvedFormat): void {
  if (format === 'json') {
    outputJSON(envelope);
    return;
  }

  const data = envelope.data;
  const taskId = readString(data, 'task_id');
  const status = (readString(data, 'task_status') ?? 'UNKNOWN').toUpperCase();
  const type = readString(data, 'type');

  const head = [
    taskId !== undefined ? `${labelText('task_id')} ${taskId}` : undefined,
    `${labelText('status')} ${statusText(status)}`,
    type !== undefined ? `${labelText('type')} ${type}` : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(` ${dot()} `);

  const lines = [head];
  const normalized = status;

  if (normalized === 'SUCCEEDED') {
    const text = readString(data, 'text');
    if (text !== undefined) {
      lines.push(detail(text));
      if (data.text_truncated === true) {
        const limit = readNumber(data, 'text_limit') ?? 200;
        lines.push(detail(`正文输出已超出 ${limit} 字限制，完整内容请借助 URL 下载`));
      }
    }
    if (type === 'model3d') {
      renderModel3d(data, lines);
    } else {
      const label = type !== undefined ? (URL_FIELDS[type] ?? 'url') : 'url';
      const savedPath = readString(data, 'path');
      const expires = readString(data, 'expires_in') ?? '24h';
      if (savedPath !== undefined) {
        lines.push(...savedLines([savedPath]));
        lines.push(detail(hintText(`已保存到本地，原始 URL ${expires} 后失效`)));
      } else {
        const url = readString(data, label);
        if (url !== undefined) {
          lines.push(detail(`${labelText(label)}  ${url}${expiryNote(expires)}`));
        }
      }
    }
  } else if (normalized === 'FAILED') {
    // Surface the upstream failure reason; the command still exits non-zero via
    // the caller's own error handling when the task itself reports an error.
    const code = readString(data, 'code');
    const message = readString(data, 'message');
    if (code !== undefined) lines.push(detail(`${labelText('code')} ${code}`));
    if (message !== undefined) lines.push(detail(`${labelText('message')} ${message}`));
  } else if (normalized === 'PENDING' || normalized === 'RUNNING') {
    lines.push(detail(hintText('任务尚未完成，可稍后再查')));
  } else {
    // Unmapped states surface as UNKNOWN (the task client folds CANCELED into
    // FAILED, so it never lands here).
    lines.push(detail(hintText('任务状态无法识别，可用 --output json 查看原始返回')));
  }

  const requestId = envelope.meta.request_id;
  const blocks = [lines.join('\n')];
  if (requestId !== undefined) blocks.push(theme.dim(`request_id ${requestId}`));
  outputText(blocks.join('\n\n'));
}

/** Render the 3D asset list (`files[]`) with per-file path/url. */
function renderModel3d(data: Record<string, unknown>, lines: string[]): void {
  const files = Array.isArray(data.files) ? (data.files as Array<Record<string, unknown>>) : [];
  const paths = files
    .map((f) => f.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (paths.length > 0) {
    lines.push(...savedLines(paths));
    lines.push(detail(hintText('已保存到本地')));
    return;
  }
  for (const file of files) {
    const url = typeof file.url === 'string' ? file.url : undefined;
    if (url === undefined) continue;
    const kind = typeof file.type === 'string' ? file.type : 'file';
    const expires = typeof file.expires_in === 'string' ? file.expires_in : undefined;
    lines.push(detail(`${labelText(kind)}  ${url}${expiryNote(expires)}`));
  }
}

export function registerTaskGetCommand(parent: Command): Command {
  const get = parent
    .command('get <task-id>')
    .description('Query an asynchronous task by id')
    .option('--out <path>', 'Output file or directory for downloaded 3D assets')
    .option('--api-key <key>', 'API key for this invocation (tier 0)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  get.action(taskGetAction(get));
  return get;
}
