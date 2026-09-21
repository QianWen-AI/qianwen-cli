/** Orchestrates tiers 0/1/2/3 into a native async video body and drives the video client. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { MappingRegistry, type MappingKey } from '../api/providers/mapping-registry.js';
import type { RequestPayloadParser } from './request-payload-parser.js';
import type { LayerConflictDetector } from './layer-conflict-detector.js';
import type { DefaultModelResolver } from './default-model-resolver.js';
import type { ModelDeprecationGuard } from './model-deprecation-guard.js';
import type { AssetPolicy } from './asset-policy.js';
import type { TaskService } from './task-service.js';
import { finalizeTaskEnvelope } from './task-service.js';
import { withFieldRejectionHint } from './invocation-envelope.js';
import type { VideoClient } from '../api/providers/dashscope/video-client.js';
import type { ImageDownloader } from './image-downloader.js';
import type { Layer2Assignment, SuccessEnvelope } from '../types/invocation-params.js';
import type { FilePolicy } from '../types/invocation-params.js';
import type { VideoArtifact } from '../types/video.js';

const VIDEO_COMMAND = 'video generate';
const T2V_TASK_MODE = 't2v';
const I2V_TASK_MODE = 'i2v';

const DEFAULT_FRAME_FILE_POLICY: FilePolicy = { allowBase64: false, allowTempUpload: true };

export const DEFAULT_VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_VIDEO_POLL_INTERVAL_MS = 2000;
export const DEFAULT_T2V_MODEL = 'happyhorse-1.1-t2v';
export const DEFAULT_I2V_MODEL = 'happyhorse-1.1-i2v';

export interface VideoGenerateInput {
  prompt?: string;
  model?: string;
  image?: string;
  wait?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  out?: string;
  request?: string;
  download?: boolean;
}

export interface VideoServiceDeps {
  parser: RequestPayloadParser;
  conflictDetector: LayerConflictDetector;
  modelResolver: DefaultModelResolver;
  registry: MappingRegistry;
  assetPolicy: AssetPolicy;
  taskService: TaskService;
  client: VideoClient;
  downloader: ImageDownloader;
  context: () => { site: string; account: string };
  deprecationGuard?: ModelDeprecationGuard;
}

export interface VideoGenerateOutcome {
  envelope: SuccessEnvelope;
  completed: boolean;
}

/** Register the DashScope-native video entries (T2V and I2V) into a mapping registry. */
export function registerVideoMappings(registry: MappingRegistry): void {
  const shared = {
    capabilities: { streaming: false, asynchronous: true },
    filePolicy: { allowBase64: false, allowTempUpload: true },
  };
  registry.register({
    key: {
      command: VIDEO_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: 'wan',
      taskMode: T2V_TASK_MODE,
    },
    fieldTemplates: {},
    ...shared,
  });
  registry.register({
    key: {
      command: VIDEO_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: 'wan',
      taskMode: I2V_TASK_MODE,
    },
    fieldTemplates: { '--image': 'input' },
    ...shared,
  });
}

function invalidArg(message: string): CliError {
  return new CliError({
    code: 'INVALID_ARGUMENT',
    message,
    exitCode: EXIT_CODES.INVALID_ARGUMENT,
  });
}

function modelFamily(model: string): string {
  const match = /^[a-z]+/i.exec(model.trim());
  return (match ? match[0] : model).toLowerCase();
}

/** Whether a model id names an explicit text-to-video model (rejects --image). */
function isT2VModel(model: string): boolean {
  return /t2v/i.test(model);
}

/** Wan 2.7+ I2V uses input.media[first_frame]; Wan 2.1-2.6 uses input.img_url. */
function usesMediaFirstFrame(model: string): boolean {
  const match = /wan(\d+)\.(\d+)/i.exec(model.trim());
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 2) return true;
  return major === 2 && minor >= 7;
}

export class VideoService {
  /** Populated after `buildRequest`; non-null when the model has a retirement notice. */
  lastDeprecationNotice: string | null = null;

  constructor(private readonly deps: VideoServiceDeps) {}

  private mappingKey(model: string, taskMode: string): MappingKey {
    return {
      command: VIDEO_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: modelFamily(model),
      taskMode,
    };
  }

  async buildRequest(input: VideoGenerateInput): Promise<{
    model: string;
    body: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
  }> {
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.length > 0;
    const hasRequest = typeof input.request === 'string' && input.request.length > 0;

    if (!hasPrompt && !hasRequest) {
      throw invalidArg('Provide a prompt or a --request body for video generate.');
    }

    let body: Record<string, unknown> = {};
    if (hasRequest) {
      const parsed = this.deps.parser.parse(input.request as string);
      body = { ...parsed.body };
    }

    body = this.deps.conflictDetector.applyModelOverride(body, input.model);

    const requestHasInput = Object.prototype.hasOwnProperty.call(body, 'input');
    if (hasPrompt && requestHasInput) {
      throw invalidArg('A prompt cannot be combined with request.input. Use one or the other.');
    }

    const imageMode = input.image !== undefined;
    const explicitModel = typeof input.model === 'string' && input.model.trim().length > 0;

    if (imageMode && explicitModel && isT2VModel(input.model as string)) {
      throw invalidArg(
        `The model "${input.model}" is a text-to-video model and cannot be combined with --image. ` +
          'Choose an image-to-video model or supply the frame via --request.',
      );
    }

    const taskMode = imageMode ? I2V_TASK_MODE : T2V_TASK_MODE;
    const existingModel =
      typeof body.model === 'string' && body.model.trim().length > 0
        ? (body.model as string)
        : undefined;
    const model = await this.deps.modelResolver.resolve(
      { command: VIDEO_COMMAND, taskMode },
      input.model ?? existingModel,
    );
    body.model = model;
    this.lastDeprecationNotice =
      (await this.deps.deprecationGuard?.notifyIfDeprecated(model)) ?? null;

    this.deps.conflictDetector.assertNoConflict(this.layer2Assignments(input), body);

    let extraHeaders: Record<string, string> | undefined;
    if (imageMode) {
      const built = await this.buildImageInput(input, model);
      body.input = built.input;
      extraHeaders = built.extraHeaders;
    } else if (hasPrompt && !requestHasInput) {
      body.input = { prompt: input.prompt };
    }

    if (!Object.prototype.hasOwnProperty.call(body, 'parameters')) {
      body.parameters = {};
    }

    return { model, body, ...(extraHeaders ? { extraHeaders } : {}) };
  }

  private layer2Assignments(input: VideoGenerateInput): Layer2Assignment[] {
    const assignments: Layer2Assignment[] = [];
    if (input.image !== undefined) {
      assignments.push({ flag: '--image', paths: ['input'] });
    }
    return assignments;
  }

  private async buildImageInput(
    input: VideoGenerateInput,
    model: string,
  ): Promise<{ input: Record<string, unknown>; extraHeaders?: Record<string, string> }> {
    const entry = this.deps.registry.lookup(this.mappingKey(model, I2V_TASK_MODE));
    const filePolicy = entry?.filePolicy ?? DEFAULT_FRAME_FILE_POLICY;
    const ctx = this.deps.context();
    const asset = await this.deps.assetPolicy.resolve(
      input.image as string,
      { site: ctx.site, account: ctx.account, model },
      filePolicy,
    );

    const result: Record<string, unknown> = {};
    if (typeof input.prompt === 'string' && input.prompt.length > 0) {
      result.prompt = input.prompt;
    }

    if (usesMediaFirstFrame(model)) {
      result.media = [{ type: 'first_frame', url: asset.url }];
    } else {
      result.img_url = asset.url;
    }

    return {
      input: result,
      ...(asset.extraHeaders ? { extraHeaders: { ...asset.extraHeaders } } : {}),
    };
  }

  async generate(input: VideoGenerateInput): Promise<VideoGenerateOutcome> {
    const { model, body, extraHeaders } = await this.buildRequest(input);
    const submitUpstream = await withFieldRejectionHint(model, () =>
      this.deps.client.submit(body, extraHeaders),
    );

    const wait = input.wait !== false;
    const { envelope: raw, completed } = await this.deps.taskService.waitForTaskDetailed(
      submitUpstream,
      {
        wait,
        timeoutMs: input.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
        pollIntervalMs: input.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS,
      },
    );

    // The task service only knows the polling response; stamp the model that
    // actually served this request so the envelope/footer can report it.
    const envelope: SuccessEnvelope = { ...raw, meta: { ...raw.meta, model } };

    if (!completed) {
      const data = { ...envelope.data };
      const taskId = typeof data.task_id === 'string' ? data.task_id : undefined;
      data.hint = taskId
        ? `Task still running. Query later: qianwen task get ${taskId}.`
        : 'Task still running. Query later with: qianwen task get <task-id>.';
      return { envelope: { ...envelope, data }, completed: false };
    }

    // A terminal FAILED task is not a success: surface the upstream reason
    // instead of rendering an empty "completed" view with exit 0.
    this.deps.taskService.assertNotFailed(envelope);

    const urls = Array.isArray(envelope.data.urls) ? (envelope.data.urls as string[]) : [];
    if (input.out !== undefined && input.download !== false && urls.length > 0) {
      const artifacts = await this.downloadArtifacts(urls, input.out);
      const withArtifacts = { ...envelope, data: { ...envelope.data, artifacts } };
      return { envelope: finalizeTaskEnvelope(withArtifacts), completed: true };
    }

    return { envelope: finalizeTaskEnvelope(envelope), completed: true };
  }

  private async downloadArtifacts(urls: string[], out: string): Promise<VideoArtifact[]> {
    const artifacts: VideoArtifact[] = [];
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index] as string;
      const path = await this.deps.downloader.download(url, index, out, 'mp4');
      artifacts.push({ url, path });
    }
    return artifacts;
  }
}
