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
import type { Model3dClient } from '../api/providers/dashscope/model3d-client.js';
import type { ImageDownloader } from './image-downloader.js';
import type { SiteAvailabilityGuard } from './site-availability.js';
import type { Layer2Assignment, SuccessEnvelope, FilePolicy } from '../types/invocation-params.js';

const MODEL3D_COMMAND = 'model3d generate';
const MODEL3D_TASK_MODE = 'model3d';

const DEFAULT_IMAGE_FILE_POLICY: FilePolicy = { allowBase64: false, allowTempUpload: true };
const TEXTURE_QUALITIES = new Set(['standard', 'detailed']);

export const DEFAULT_MODEL3D_MODEL = 'Tripo/Tripo-P1.0';
export const DEFAULT_MODEL3D_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MODEL3D_POLL_INTERVAL_MS = 2000;

export interface Model3dGenerateInput {
  prompt?: string;
  model?: string;
  image?: string;
  textureQuality?: string;
  out?: string;
  wait?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  request?: string;
  download?: boolean;
}

export interface Model3dGenerateOutcome {
  envelope: SuccessEnvelope;
  completed: boolean;
}

export interface Model3dServiceDeps {
  parser: RequestPayloadParser;
  conflictDetector: LayerConflictDetector;
  modelResolver: DefaultModelResolver;
  registry: MappingRegistry;
  assetPolicy: AssetPolicy;
  taskService: TaskService;
  client: Model3dClient;
  downloader: ImageDownloader;
  guard: SiteAvailabilityGuard;
  context: () => { site: string; account: string };
  deprecationGuard?: ModelDeprecationGuard;
}

export function registerModel3dMappings(registry: MappingRegistry): void {
  registry.register({
    key: {
      command: MODEL3D_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: 'tripo',
      taskMode: MODEL3D_TASK_MODE,
    },
    fieldTemplates: {
      '--image': 'input.image',
      '--texture-quality': 'parameters.texture_quality',
    },
    capabilities: { streaming: false, asynchronous: true },
    filePolicy: { allowBase64: false, allowTempUpload: true },
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

export class Model3dService {
  constructor(private readonly deps: Model3dServiceDeps) {}

  private mappingKey(model: string): MappingKey {
    return {
      command: MODEL3D_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: modelFamily(model),
      taskMode: MODEL3D_TASK_MODE,
    };
  }

  private layer2Assignments(input: Model3dGenerateInput): Layer2Assignment[] {
    const assignments: Layer2Assignment[] = [];
    if (input.image !== undefined) {
      assignments.push({ flag: '--image', paths: ['input.image'] });
    }
    if (input.textureQuality !== undefined) {
      assignments.push({ flag: '--texture-quality', paths: ['parameters.texture_quality'] });
    }
    return assignments;
  }

  async buildRequest(input: Model3dGenerateInput): Promise<{
    model: string;
    body: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
  }> {
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.length > 0;
    const hasImage = typeof input.image === 'string' && input.image.length > 0;
    const hasRequest = typeof input.request === 'string' && input.request.length > 0;

    if (!hasPrompt && !hasImage && !hasRequest) {
      throw invalidArg('Provide a prompt, --image, or a --request body for model3d generate.');
    }

    if (hasPrompt && hasImage) {
      throw invalidArg('A prompt cannot be combined with --image. Use one or the other.');
    }

    if (input.textureQuality !== undefined && !TEXTURE_QUALITIES.has(input.textureQuality)) {
      throw invalidArg('--texture-quality must be either standard or detailed.');
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

    const existingModel =
      typeof body.model === 'string' && body.model.trim().length > 0
        ? (body.model as string)
        : undefined;
    const model = await this.deps.modelResolver.resolve(
      { command: MODEL3D_COMMAND, taskMode: MODEL3D_TASK_MODE },
      input.model ?? existingModel,
    );
    body.model = model;
    await this.deps.deprecationGuard?.notifyIfDeprecated(model);
    this.deps.conflictDetector.assertNoConflict(this.layer2Assignments(input), body);
    let extraHeaders: Record<string, string> | undefined;
    if (hasPrompt) {
      body.input = { prompt: input.prompt as string };
    } else if (hasImage) {
      const resolved = await this.resolveImage(input.image as string, model);
      body.input = { image: resolved.url };
      extraHeaders = resolved.extraHeaders;
    }

    if (input.textureQuality !== undefined) {
      const parameters =
        body.parameters && typeof body.parameters === 'object'
          ? (body.parameters as Record<string, unknown>)
          : {};
      parameters.texture_quality = input.textureQuality;
      body.parameters = parameters;
    }

    return { model, body, ...(extraHeaders ? { extraHeaders } : {}) };
  }

  private async resolveImage(
    image: string,
    model: string,
  ): Promise<{ url: string; extraHeaders?: Record<string, string> }> {
    const entry = this.deps.registry.lookup(this.mappingKey(model));
    const filePolicy = entry?.filePolicy ?? DEFAULT_IMAGE_FILE_POLICY;
    const ctx = this.deps.context();
    const asset = await this.deps.assetPolicy.resolve(
      image,
      { site: ctx.site, account: ctx.account, model },
      filePolicy,
    );
    return {
      url: asset.url,
      ...(asset.extraHeaders ? { extraHeaders: { ...asset.extraHeaders } } : {}),
    };
  }

  extractUrls(upstream: Record<string, unknown>): string[] {
    return this.extractAssets(upstream)
      .filter((asset) => asset.type === 'model')
      .map((asset) => asset.url);
  }

  extractAssets(
    upstream: Record<string, unknown>,
  ): Array<{ url: string; type: string; ext: string }> {
    return extractModel3dAssets(upstream);
  }

  async generate(input: Model3dGenerateInput): Promise<Model3dGenerateOutcome> {
    this.deps.guard.assertAvailable();
    const { model, body, extraHeaders } = await this.buildRequest(input);
    const submitUpstream = await withFieldRejectionHint(model, () =>
      this.deps.client.submit(body, extraHeaders),
    );
    const wait = input.wait !== false;
    const { envelope: raw, completed } = await this.deps.taskService.waitForTaskDetailed(
      submitUpstream,
      {
        wait,
        timeoutMs: input.timeoutMs ?? DEFAULT_MODEL3D_TIMEOUT_MS,
        pollIntervalMs: input.pollIntervalMs ?? DEFAULT_MODEL3D_POLL_INTERVAL_MS,
      },
    );
    const envelope: SuccessEnvelope = { ...raw, meta: { ...raw.meta, model } };

    if (!completed) {
      const data = { ...envelope.data };
      const taskId = typeof data.task_id === 'string' ? data.task_id : undefined;
      data.hint = taskId
        ? `Task still running. Query later: qianwen task get ${taskId}.`
        : 'Task still running. Query later with: qianwen task get <task-id>.';
      return { envelope: { ...envelope, data }, completed: false };
    }

    this.deps.taskService.assertNotFailed(envelope);
    const assets = this.extractAssets(envelope.data);
    const artifacts: Array<{ type: string; url: string; path?: string }> = [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index]!;
      const artifact: { type: string; url: string; path?: string } = {
        type: asset.type,
        url: asset.url,
      };
      if (input.download !== false) {
        artifact.path = await this.deps.downloader.download(asset.url, index, input.out, asset.ext);
      }
      artifacts.push(artifact);
    }
    const withArtifacts = { ...envelope, data: { ...envelope.data, type: 'model3d', artifacts } };
    return { envelope: finalizeTaskEnvelope(withArtifacts), completed: true };
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

export interface Model3dAsset {
  url: string;
  type: string;
  ext: string;
}

export function extractModel3dAssets(upstream: Record<string, unknown>): Model3dAsset[] {
  const output =
    upstream.output && typeof upstream.output === 'object'
      ? (upstream.output as Record<string, unknown>)
      : undefined;
  if (!output) return [];
  const assets: Model3dAsset[] = [];
  const results = output.results;
  if (Array.isArray(results)) {
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      const record = result as Record<string, unknown>;
      const modelUrl = record.pbr_model_url ?? record.base_model_url ?? record.url;
      if (typeof modelUrl === 'string' && isHttpUrl(modelUrl)) {
        assets.push({ url: modelUrl, type: 'model', ext: 'glb' });
      }
      const previewUrl = record.rendered_image_url;
      if (typeof previewUrl === 'string' && isHttpUrl(previewUrl)) {
        assets.push({
          url: previewUrl,
          type: 'preview',
          ext: extensionFromUrl(previewUrl) ?? 'webp',
        });
      }
    }
  }
  return assets;
}

function extensionFromUrl(url: string): string | undefined {
  const segment = (url.split('?')[0] ?? '').split('/').pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot >= segment.length - 1) return undefined;
  return segment.slice(dot + 1).toLowerCase();
}
