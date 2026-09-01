/** Single-query normalization for `task get` and reusable async wait orchestration. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { AsyncWaiter, type PollResult } from './async-waiter.js';
import { TaskClient } from '../api/providers/dashscope/task-client.js';
import type { InvocationEnvelope } from './invocation-envelope.js';
import type { SuccessEnvelope } from '../types/invocation-params.js';
import type { TranscriptFetcher } from './transcript.js';
import { expiresInFromUrl } from '../utils/expiry.js';

export interface TaskServiceDeps {
  client: TaskClient;
  waiter: AsyncWaiter;
  envelope: InvocationEnvelope;
  transcriptFetcher?: TranscriptFetcher;
  assetDownloader?: TaskAssetDownloader;
}

export interface TaskArtifact {
  type: string;
  url: string;
  path: string;
}

export interface TaskAssetDownloader {
  supports(type: string | undefined): boolean;
  download(data: Record<string, unknown>, out?: string): Promise<TaskArtifact[]>;
}

export interface WaitForTaskOptions {
  wait: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface WaitForTaskResult {
  envelope: SuccessEnvelope;
  completed: boolean;
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  async get(taskId: string, out?: string): Promise<SuccessEnvelope> {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new CliError({
        code: 'INVALID_ARGUMENT',
        message: 'Provide a task id: qianwen task get <task-id>.',
        exitCode: EXIT_CODES.INVALID_ARGUMENT,
      });
    }

    const upstream = await this.deps.client.get(taskId.trim());
    const enriched = await this.attachAssets(
      await this.attachTranscript(this.normalize(upstream)),
      out,
    );
    return finalizeTaskEnvelope(enriched, { includeType: true });
  }

  private async attachAssets(envelope: SuccessEnvelope, out?: string): Promise<SuccessEnvelope> {
    const downloader = this.deps.assetDownloader;
    if (downloader === undefined) return envelope;
    if (envelope.data.task_status !== 'SUCCEEDED') return envelope;
    const type = typeof envelope.data.type === 'string' ? envelope.data.type : undefined;
    if (!downloader.supports(type)) return envelope;
    const artifacts = await downloader.download(envelope.data, out);
    if (artifacts.length === 0) return envelope;
    return { ...envelope, data: { ...envelope.data, artifacts } };
  }

  private async attachTranscript(envelope: SuccessEnvelope): Promise<SuccessEnvelope> {
    if (this.deps.transcriptFetcher === undefined) return envelope;
    if (envelope.data.type !== 'transcription') return envelope;
    if (envelope.data.task_status !== 'SUCCEEDED') return envelope;
    const urls = envelope.data.urls;
    const url = Array.isArray(urls)
      ? urls.find((u): u is string => typeof u === 'string' && u.length > 0)
      : undefined;
    if (url === undefined) return envelope;
    const preview = await this.deps.transcriptFetcher.preview(url);
    if (preview === undefined) return envelope;
    return {
      ...envelope,
      data: {
        ...envelope.data,
        text: preview.text,
        text_truncated: preview.truncated,
        text_limit: preview.limit,
      },
    };
  }

  /**
   * Surface a terminal FAILED task as an error for the async generation
   * commands. `waitForTaskDetailed` treats FAILED as `completed:true` (the task
   * reached a terminal state), so without this a failed remote task would be
   * rendered as success with an empty result and exit 0. The failure `code` /
   * `message` are lifted onto `data` by `normalize()`.
   */
  assertNotFailed(envelope: SuccessEnvelope): void {
    if (envelope.data.task_status !== 'FAILED') return;
    const code = typeof envelope.data.code === 'string' ? envelope.data.code : 'TASK_FAILED';
    const message =
      typeof envelope.data.message === 'string' && envelope.data.message.length > 0
        ? envelope.data.message
        : 'The asynchronous task failed.';
    throw new CliError({
      code,
      message,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
  }

  async waitForTask(
    submitUpstream: Record<string, unknown>,
    options: WaitForTaskOptions,
  ): Promise<SuccessEnvelope> {
    const { envelope } = await this.waitForTaskDetailed(submitUpstream, options);
    return envelope;
  }

  async waitForTaskDetailed(
    submitUpstream: Record<string, unknown>,
    options: WaitForTaskOptions,
  ): Promise<WaitForTaskResult> {
    if (!options.wait) {
      // The request was submitted successfully, but the asynchronous task has
      // not completed. Callers use this flag to choose the submitted view; the
      // command layer separately decides that an intentional --no-wait is not
      // a timeout/error exit.
      return { envelope: this.normalize(submitUpstream), completed: false };
    }

    const taskId = this.deps.client.extractTaskId(submitUpstream);
    if (taskId === undefined) {
      return { envelope: this.normalize(submitUpstream), completed: true };
    }

    const result = await this.deps.waiter.wait<Record<string, unknown>>(
      async (): Promise<PollResult<Record<string, unknown>>> => {
        const polled = await this.deps.client.get(taskId);
        const status = this.deps.client.normalizeStatus(polled);
        return {
          status: TERMINAL_STATUSES.has(status) ? 'terminal' : 'pending',
          value: polled,
        };
      },
      { timeoutMs: options.timeoutMs, pollIntervalMs: options.pollIntervalMs },
    );

    return { envelope: this.normalize(result.value), completed: result.completed };
  }

  private normalize(upstream: Record<string, unknown>): SuccessEnvelope {
    const taskStatus = this.deps.client.normalizeStatus(upstream).toUpperCase();
    const data: Record<string, unknown> = {
      task_status: taskStatus,
      urls: this.deps.client.extractUrls(upstream),
    };
    if (upstream.output && typeof upstream.output === 'object') {
      data.output = upstream.output;
    }

    const taskId = this.deps.client.extractTaskId(upstream);
    if (taskId !== undefined) data.task_id = taskId;

    const failure = extractFailure(upstream);
    if (failure.code !== undefined) data.code = failure.code;
    if (failure.message !== undefined) data.message = failure.message;

    const type = inferTaskType(data);
    if (type !== undefined) data.type = type;

    const meta: { requestId?: string } = {};
    if (typeof upstream.request_id === 'string' && upstream.request_id.length > 0) {
      meta.requestId = upstream.request_id;
    }
    const usage = extractUsage(upstream);

    return this.deps.envelope.success(data, usage !== undefined ? { ...meta, usage } : meta);
  }
}

/** Lift the upstream failure reason (`output.code` / `output.message`) when present. */
function extractFailure(upstream: Record<string, unknown>): {
  code?: string;
  message?: string;
} {
  const output =
    upstream.output && typeof upstream.output === 'object'
      ? (upstream.output as Record<string, unknown>)
      : undefined;
  const result: { code?: string; message?: string } = {};
  const code = output?.code ?? upstream.code;
  const message = output?.message ?? upstream.message;
  if (typeof code === 'string' && code.length > 0) result.code = code;
  if (typeof message === 'string' && message.length > 0) result.message = message;
  return result;
}

/** Lift `output.usage` (product metering) into the envelope meta when present. */
function extractUsage(upstream: Record<string, unknown>): Record<string, unknown> | undefined {
  const output =
    upstream.output && typeof upstream.output === 'object'
      ? (upstream.output as Record<string, unknown>)
      : undefined;
  const usage = output?.usage;
  if (usage && typeof usage === 'object' && Object.keys(usage as object).length > 0) {
    return usage as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Best-effort task classification from the normalized result URLs.
 *
 * The DashScope task payload does not name the modality, but each producer
 * leaves a recognizable artifact extension. Unknown shapes return undefined so
 * the renderer simply omits the `type` segment rather than guessing wrong.
 */
function inferTaskType(data: Record<string, unknown>): string | undefined {
  const urls = Array.isArray(data.urls)
    ? data.urls.filter((u): u is string => typeof u === 'string')
    : [];

  for (const url of urls) {
    const path = url.split('?')[0]?.toLowerCase() ?? '';
    if (/\.(mp4|mov|webm)$/.test(path)) return 'video';
    if (/\.(glb|gltf|obj|fbx)$/.test(path)) return 'model3d';
    if (/\.(wav|mp3|aac|flac|ogg)$/.test(path)) return 'audio';
    if (/\.json$/.test(path)) return 'transcription';
    if (/\.(png|jpg|jpeg|webp)$/.test(path)) return 'image';
  }
  return undefined;
}

const TASK_URL_FIELD: Record<string, string> = {
  video: 'video_url',
  audio: 'audio_url',
  image: 'image_url',
  transcription: 'transcription_url',
};

/**
 * Collapse the internal working fields (`urls`, `artifacts`, `text`, …) into
 * the PRD success shape for the task's modality. Drops the raw backend
 * `output` and the internal `urls`, and derives `expires_in` from the signed
 * URL. `includeType` keeps `data.type` for `task get`, which reports it.
 */
export function finalizeTaskEnvelope(
  envelope: SuccessEnvelope,
  options: { includeType?: boolean } = {},
): SuccessEnvelope {
  const src = envelope.data;
  const status = typeof src.task_status === 'string' ? src.task_status : undefined;
  const type = typeof src.type === 'string' ? src.type : undefined;

  const data: Record<string, unknown> = {};
  if (typeof src.task_id === 'string') data.task_id = src.task_id;
  if (status !== undefined) data.task_status = status;
  if (options.includeType && type !== undefined) data.type = type;

  if (status === 'FAILED') {
    if (typeof src.code === 'string') data.code = src.code;
    if (typeof src.message === 'string') data.message = src.message;
    return { ...envelope, data };
  }

  if (status !== 'SUCCEEDED') return { ...envelope, data };

  const artifacts = Array.isArray(src.artifacts)
    ? (src.artifacts as Array<Record<string, unknown>>)
    : [];
  const urls = Array.isArray(src.urls)
    ? (src.urls as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];

  if (type === 'model3d') {
    data.files = artifacts.map((a) => {
      const file: Record<string, unknown> = {};
      if (typeof a.type === 'string') file.type = a.type;
      if (typeof a.path === 'string') file.path = a.path;
      if (typeof a.url === 'string') file.url = a.url;
      const expiresIn = typeof a.url === 'string' ? expiresInFromUrl(a.url) : undefined;
      if (expiresIn !== undefined) file.expires_in = expiresIn;
      return file;
    });
    return { ...envelope, data };
  }

  const url = urls[0];
  const urlField = type !== undefined ? TASK_URL_FIELD[type] : undefined;
  if (urlField !== undefined && url !== undefined) {
    data[urlField] = url;
    const expiresIn = expiresInFromUrl(url);
    if (expiresIn !== undefined) data.expires_in = expiresIn;
  }

  if (type === 'transcription' && typeof src.text === 'string') {
    data.text = src.text;
    if (src.text_truncated === true) data.text_truncated = true;
    if (typeof src.text_limit === 'number') data.text_limit = src.text_limit;
  }

  const path = artifacts.map((a) => a.path).find((p): p is string => typeof p === 'string');
  if (path !== undefined) data.path = path;

  return { ...envelope, data };
}
