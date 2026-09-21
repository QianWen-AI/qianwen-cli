import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { MappingRegistry, type MappingKey } from '../api/providers/mapping-registry.js';
import type { RequestPayloadParser } from './request-payload-parser.js';
import type { LayerConflictDetector } from './layer-conflict-detector.js';
import type { DefaultModelResolver } from './default-model-resolver.js';
import type { ModelDeprecationGuard } from './model-deprecation-guard.js';
import type { AssetPolicy } from './asset-policy.js';
import type { InvocationEnvelope } from './invocation-envelope.js';
import { withFieldRejectionHint } from './invocation-envelope.js';
import type { ImageClient } from '../api/providers/dashscope/image-client.js';
import type { ImageDownloader } from './image-downloader.js';
import type { TaskService } from './task-service.js';
import type { Layer2Assignment, SuccessEnvelope } from '../types/invocation-params.js';
import type { ImageArtifact } from '../types/image.js';
import { expiresInFromUrl } from '../utils/expiry.js';

const IMAGE_COMMAND = 'image generate';
const IMAGE_TASK_MODE = 'image';
const SIZE_SHAPE = /^\d+\*\d+$/;

export const DEFAULT_IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_IMAGE_POLL_INTERVAL_MS = 2000;

export interface ImageGenerateInput {
  prompt?: string;
  model?: string;
  size?: string;
  n?: number;
  image?: string;
  out?: string;
  responseFormat?: 'b64';
  request?: string;
  download?: boolean;
  timeoutMs?: number;
  wait?: boolean;
  pollIntervalMs?: number;
}

export interface ImageServiceDeps {
  parser: RequestPayloadParser;
  conflictDetector: LayerConflictDetector;
  modelResolver: DefaultModelResolver;
  registry: MappingRegistry;
  assetPolicy: AssetPolicy;
  envelope: InvocationEnvelope;
  client: ImageClient;
  downloader: ImageDownloader;
  taskService: TaskService;
  context: () => { site: string; account: string };
  deprecationGuard?: ModelDeprecationGuard;
}

export function registerImageMappings(registry: MappingRegistry): void {
  registry.register({
    key: {
      command: IMAGE_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: 'qwen',
      taskMode: IMAGE_TASK_MODE,
    },
    fieldTemplates: {
      '--size': 'parameters.size',
      '--n': 'parameters.n',
      '--image': 'input.messages[].content[].image',
    },
    capabilities: { streaming: false, asynchronous: false },
    filePolicy: { allowBase64: false, allowTempUpload: true },
  });
}

function modelFamily(model: string): string {
  const match = /^[a-z]+/i.exec(model.trim());
  return (match ? match[0] : model).toLowerCase();
}

function usesAsyncText2Image(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (id.startsWith('wanx')) return true;
  const match = /^wan(\d+)\.(\d+)/.exec(id);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 2) return false;
  return major === 2 && minor < 6;
}

function invalidArg(message: string): CliError {
  return new CliError({
    code: 'INVALID_ARGUMENT',
    message,
    exitCode: EXIT_CODES.INVALID_ARGUMENT,
  });
}

function maxImages(model: string): number {
  const id = model.trim().toLowerCase();
  if (id === 'qwen-image-edit') return 1;
  if (/(^|[-.])image-(max|plus)($|[-.])/.test(id)) return 1;
  return 6;
}

function supportsEditing(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (id.includes('nonedit')) return false;
  if (id.includes('edit')) return true;
  return /(^|[-.])image-2\.0(-pro)?($|[-.])/.test(id);
}

export class ImageService {
  /** Populated after `buildRequest`; non-null when the model has a retirement notice. */
  lastDeprecationNotice: string | null = null;

  constructor(private readonly deps: ImageServiceDeps) {}

  private mappingKey(model: string): MappingKey {
    return {
      command: IMAGE_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: modelFamily(model),
      taskMode: IMAGE_TASK_MODE,
    };
  }

  private layer2Assignments(input: ImageGenerateInput): Layer2Assignment[] {
    const assignments: Layer2Assignment[] = [];
    if (input.size !== undefined) {
      assignments.push({ flag: '--size', paths: ['parameters.size'] });
    }
    if (input.n !== undefined) {
      assignments.push({ flag: '--n', paths: ['parameters.n'] });
    }
    if (input.image !== undefined) {
      assignments.push({ flag: '--image', paths: ['input'] });
    }
    return assignments;
  }

  async buildRequest(input: ImageGenerateInput): Promise<{
    model: string;
    body: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
    async: boolean;
  }> {
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.length > 0;
    const hasRequest = typeof input.request === 'string' && input.request.length > 0;

    if (!hasPrompt && !hasRequest) {
      throw invalidArg('Provide a prompt or a --request body for image generate.');
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
      { command: IMAGE_COMMAND, taskMode: IMAGE_TASK_MODE },
      input.model ?? existingModel,
    );
    body.model = model;
    this.lastDeprecationNotice =
      (await this.deps.deprecationGuard?.notifyIfDeprecated(model)) ?? null;
    const async = usesAsyncText2Image(model);

    if (input.n !== undefined) {
      if (!Number.isInteger(input.n) || input.n <= 0) {
        throw invalidArg('--n must be a positive integer.');
      }
      const ceiling = maxImages(model);
      if (input.n > ceiling) {
        throw invalidArg(
          `--n exceeds the limit of ${ceiling} for "${model}". Reduce --n or choose a model that supports more images.`,
        );
      }
    }

    if (input.size !== undefined && !SIZE_SHAPE.test(input.size)) {
      throw invalidArg('--size must be in the form <width>*<height>, e.g. 1024*1024.');
    }

    const editMode = input.image !== undefined;
    if (editMode && !supportsEditing(model)) {
      throw invalidArg(
        `The model "${model}" does not support image editing. Use a public URL and --request for complex multi-image or mask edits.`,
      );
    }
    if (editMode && async) {
      throw invalidArg(
        `The model "${model}" does not support --image editing here. Choose an editing model such as qwen-image-edit, or use --request for the wan image-edit endpoint.`,
      );
    }

    this.deps.conflictDetector.assertNoConflict(this.layer2Assignments(input), body);
    let extraHeaders: Record<string, string> | undefined;
    if (hasPrompt && !requestHasInput && async) {
      body.input = { prompt: input.prompt };
    } else if (hasPrompt && !requestHasInput) {
      const built = await this.buildInput(input, model, editMode);
      body.input = built.input;
      extraHeaders = built.extraHeaders;
    }

    if (input.size !== undefined || input.n !== undefined) {
      const parameters =
        body.parameters && typeof body.parameters === 'object'
          ? (body.parameters as Record<string, unknown>)
          : {};
      if (input.size !== undefined) parameters.size = input.size;
      if (input.n !== undefined) parameters.n = input.n;
      body.parameters = parameters;
    }

    return { model, body, async, ...(extraHeaders ? { extraHeaders } : {}) };
  }

  private async buildInput(
    input: ImageGenerateInput,
    model: string,
    editMode: boolean,
  ): Promise<{
    input: { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    extraHeaders?: Record<string, string>;
  }> {
    const prompt = input.prompt as string;
    const content: Array<Record<string, unknown>> = [];
    let extraHeaders: Record<string, string> | undefined;

    if (editMode) {
      const entry = this.deps.registry.require(this.mappingKey(model));
      const ctx = this.deps.context();
      const asset = await this.deps.assetPolicy.resolve(
        input.image as string,
        { site: ctx.site, account: ctx.account, model },
        entry.filePolicy,
      );
      content.push({ image: asset.url });
      if (asset.extraHeaders) extraHeaders = { ...asset.extraHeaders };
    }

    content.push({ text: prompt });
    return {
      input: { messages: [{ role: 'user', content }] },
      ...(extraHeaders ? { extraHeaders } : {}),
    };
  }

  extractUrls(upstream: Record<string, unknown>): string[] {
    const output =
      upstream.output && typeof upstream.output === 'object'
        ? (upstream.output as Record<string, unknown>)
        : undefined;
    if (!output) return [];
    const fromChoices = this.urlsFromChoices(output.choices);
    if (fromChoices.length > 0) return fromChoices;
    return this.urlsFromResults(output.results);
  }

  private urlsFromChoices(choices: unknown): string[] {
    if (!Array.isArray(choices)) return [];
    const urls: string[] = [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== 'object') continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const image = (part as Record<string, unknown>).image;
        if (typeof image === 'string' && image.length > 0) urls.push(image);
      }
    }
    return urls;
  }

  private urlsFromResults(results: unknown): string[] {
    if (!Array.isArray(results)) return [];
    const urls: string[] = [];
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      const url = (result as Record<string, unknown>).url;
      if (typeof url === 'string' && url.length > 0) urls.push(url);
    }
    return urls;
  }

  async generate(input: ImageGenerateInput): Promise<SuccessEnvelope> {
    const { model, body, extraHeaders, async } = await this.buildRequest(input);
    if (async) {
      return this.generateAsync(model, body, extraHeaders, input);
    }
    const upstream = await withFieldRejectionHint(model, () =>
      this.deps.client.generate(body, extraHeaders, input.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS),
    );
    const urls = this.extractUrls(upstream);
    const artifacts = await this.buildArtifacts(urls, input);
    const data = { images: this.toImages(artifacts) };
    return this.deps.envelope.success(
      data,
      this.extractMeta(upstream, model, input, artifacts.length),
    );
  }

  private async generateAsync(
    model: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> | undefined,
    input: ImageGenerateInput,
  ): Promise<SuccessEnvelope> {
    const submitUpstream = await withFieldRejectionHint(model, () =>
      this.deps.client.submit(body, extraHeaders),
    );
    const wait = input.wait !== false;
    const { envelope: raw, completed } = await this.deps.taskService.waitForTaskDetailed(
      submitUpstream,
      {
        wait,
        timeoutMs: input.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
        pollIntervalMs: input.pollIntervalMs ?? DEFAULT_IMAGE_POLL_INTERVAL_MS,
      },
    );
    const envelope: SuccessEnvelope = { ...raw, meta: { ...raw.meta, model } };

    if (!completed) {
      const data = { ...envelope.data };
      const taskId = typeof data.task_id === 'string' ? data.task_id : undefined;
      data.hint = taskId
        ? `Task still running. Query later: qianwen task get ${taskId}.`
        : 'Task still running. Query later with: qianwen task get <task-id>.';
      return { ...envelope, data };
    }

    this.deps.taskService.assertNotFailed(envelope);

    const urls = Array.isArray(envelope.data.urls) ? (envelope.data.urls as string[]) : [];
    const artifacts = await this.buildArtifacts(urls, input);
    const usage = buildImageUsage(input, artifacts.length);
    const meta = { ...envelope.meta, model, ...(usage !== undefined ? { usage } : {}) };
    return { meta, data: { images: this.toImages(artifacts) } };
  }

  private async buildArtifacts(
    urls: string[],
    input: ImageGenerateInput,
  ): Promise<ImageArtifact[]> {
    if (input.download === false) {
      return urls.map((url) => ({ url }));
    }

    if (input.responseFormat === 'b64') {
      const artifacts: ImageArtifact[] = [];
      for (const url of urls) {
        const bytes = await this.deps.downloader.fetchBytes(url);
        artifacts.push({ url, b64: Buffer.from(bytes).toString('base64') });
      }
      return artifacts;
    }

    const artifacts: ImageArtifact[] = [];
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index] as string;
      const path = await this.deps.downloader.download(url, index, input.out, 'png');
      artifacts.push({ url, path });
    }
    return artifacts;
  }

  private toImages(artifacts: ImageArtifact[]): Array<Record<string, unknown>> {
    return artifacts.map((artifact, index) => {
      const image: Record<string, unknown> = { index: index + 1, url: artifact.url };
      if (artifact.path !== undefined) image.path = artifact.path;
      if (artifact.b64 !== undefined) image.b64 = artifact.b64;
      const expiresIn = expiresInFromUrl(artifact.url);
      if (expiresIn !== undefined) image.expires_in = expiresIn;
      return image;
    });
  }

  private extractMeta(
    upstream: Record<string, unknown>,
    model: string,
    input: ImageGenerateInput,
    count: number,
  ): { requestId?: string; model?: string; usage?: Record<string, unknown> } {
    const meta: { requestId?: string; model?: string; usage?: Record<string, unknown> } = { model };
    if (typeof upstream.request_id === 'string' && upstream.request_id.length > 0) {
      meta.requestId = upstream.request_id;
    }
    const usage = buildImageUsage(input, count);
    if (usage !== undefined) meta.usage = usage;
    return meta;
  }
}

/** Product metering for image generation, derived from the request and result count. */
function buildImageUsage(
  input: ImageGenerateInput,
  count: number,
): Record<string, unknown> | undefined {
  const usage: Record<string, unknown> = {};
  if (count > 0) usage.image_count = count;
  const size = typeof input.size === 'string' ? SIZE_SHAPE.exec(input.size) : null;
  if (input.size !== undefined && size !== null) {
    const [width, height] = input.size.split('*');
    usage.width = Number(width);
    usage.height = Number(height);
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
