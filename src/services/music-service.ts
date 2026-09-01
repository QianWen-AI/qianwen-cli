import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { MappingRegistry } from '../api/providers/mapping-registry.js';
import type { RequestPayloadParser } from './request-payload-parser.js';
import type { LayerConflictDetector } from './layer-conflict-detector.js';
import type { DefaultModelResolver } from './default-model-resolver.js';
import type { InvocationEnvelope } from './invocation-envelope.js';
import { withFieldRejectionHint } from './invocation-envelope.js';
import type { MusicClient } from '../api/providers/dashscope/music-client.js';
import type { ImageDownloader } from './image-downloader.js';
import type { SiteAvailabilityGuard } from './site-availability.js';
import type { SuccessEnvelope } from '../types/invocation-params.js';
import { expiresInFromUrl } from '../utils/expiry.js';

const MUSIC_COMMAND = 'music generate';
const MUSIC_TASK_MODE = 'music';

export const DEFAULT_MUSIC_MODEL = 'fun-music-v1';

export const DEFAULT_MUSIC_TIMEOUT_MS = 5 * 60 * 1000;

export interface MusicGenerateInput {
  prompt?: string;
  model?: string;
  out?: string;
  request?: string;
  download?: boolean;
  timeoutMs?: number;
  stream?: boolean;
}

export interface MusicArtifact {
  url: string;
  path?: string;
}

export interface MusicServiceDeps {
  parser: RequestPayloadParser;
  conflictDetector: LayerConflictDetector;
  modelResolver: DefaultModelResolver;
  registry: MappingRegistry;
  envelope: InvocationEnvelope;
  client: MusicClient;
  downloader: ImageDownloader;
  guard: SiteAvailabilityGuard;
  context: () => { site: string; account: string };
}

export function registerMusicMappings(registry: MappingRegistry): void {
  registry.register({
    key: {
      command: MUSIC_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: 'fun',
      taskMode: MUSIC_TASK_MODE,
    },
    fieldTemplates: {},
    capabilities: { streaming: false, asynchronous: false },
    filePolicy: { allowBase64: false, allowTempUpload: false },
  });
}

function invalidArg(message: string): CliError {
  return new CliError({
    code: 'INVALID_ARGUMENT',
    message,
    exitCode: EXIT_CODES.INVALID_ARGUMENT,
  });
}

export class MusicService {
  constructor(private readonly deps: MusicServiceDeps) {}

  async buildRequest(
    input: MusicGenerateInput,
  ): Promise<{ model: string; body: Record<string, unknown> }> {
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.length > 0;
    const hasRequest = typeof input.request === 'string' && input.request.length > 0;

    if (!hasPrompt && !hasRequest) {
      throw invalidArg('Provide a prompt or a --request body for music generate.');
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
      { command: MUSIC_COMMAND, taskMode: MUSIC_TASK_MODE },
      input.model ?? existingModel,
    );
    body.model = model;

    if (hasPrompt) {
      body.input = { prompt: input.prompt as string };
    }

    return { model, body };
  }

  extractUrls(upstream: Record<string, unknown>): string[] {
    const output =
      upstream.output && typeof upstream.output === 'object'
        ? (upstream.output as Record<string, unknown>)
        : undefined;
    if (!output) return [];
    const audio = output.audio;
    if (typeof audio === 'string') {
      return isHttpUrl(audio) ? [audio] : [];
    }
    if (audio && typeof audio === 'object') {
      const url = (audio as Record<string, unknown>).url;
      if (typeof url === 'string' && isHttpUrl(url)) return [url];
      return [];
    }

    const url = output.url;
    if (typeof url === 'string' && isHttpUrl(url)) return [url];
    return [];
  }

  async generate(input: MusicGenerateInput): Promise<SuccessEnvelope> {
    this.deps.guard.assertAvailable();
    const { model, body } = await this.buildRequest(input);
    if (input.stream !== false) {
      return this.generateViaStream(model, body, input);
    }
    const upstream = await withFieldRejectionHint(model, () =>
      this.deps.client.generate(body, undefined, input.timeoutMs ?? DEFAULT_MUSIC_TIMEOUT_MS),
    );
    const urls = this.extractUrls(upstream);
    const artifacts = await this.buildArtifacts(urls, input);
    const audio = buildAudio(artifacts);
    const data = audio !== undefined ? { audio } : {};
    return this.deps.envelope.success(data, this.extractMeta(upstream, model));
  }

  private async generateViaStream(
    model: string,
    body: Record<string, unknown>,
    input: MusicGenerateInput,
  ): Promise<SuccessEnvelope> {
    const chunks: string[] = [];
    let finalUrl: string | undefined;
    let requestId: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let extraInfo: Record<string, unknown> | undefined;
    let finished = false;
    const timeoutMs = input.timeoutMs ?? DEFAULT_MUSIC_TIMEOUT_MS;
    try {
      await withFieldRejectionHint(model, async () => {
        const stream = this.deps.client.generateStream(body, undefined, timeoutMs);
        for await (const event of stream) {
          if (event.requestId) requestId = event.requestId;
          if (event.audioData) chunks.push(event.audioData);
          if (event.url) finalUrl = event.url;
          if (event.usage) usage = event.usage;
          if (event.extraInfo) extraInfo = event.extraInfo;
          if (event.finishReason === 'stop') finished = true;
        }
      });
    } catch (error) {
      throw this.enrichStallError(error, timeoutMs);
    }

    if (!finished && !finalUrl && chunks.length === 0) {
      throw new CliError({
        code: 'UPSTREAM_ERROR',
        message: 'Music generation stream ended without any audio output.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    const upstream: Record<string, unknown> = {};
    if (requestId) upstream.request_id = requestId;
    if (usage) upstream.usage = usage;
    const artifacts = await this.buildStreamArtifacts(finalUrl, chunks, input);
    const audio = buildAudio(artifacts);
    const data = audio !== undefined ? { audio } : {};
    return this.deps.envelope.success(data, this.extractMeta(upstream, model));
  }

  private enrichStallError(error: unknown, timeoutMs: number): unknown {
    if (error instanceof CliError && error.code === 'NETWORK_ERROR' && error.hint === undefined) {
      const seconds = Math.round(timeoutMs / 1000);
      return new CliError({
        code: error.code,
        message: error.message,
        exitCode: error.exitCode,
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
        hint:
          `Fun-Music held the connection for ${seconds}s without returning audio. ` +
          `Generation can take several minutes and fun-music-preview may queue longer — ` +
          `retry with a larger window, e.g. \`--timeout 900\`, or try \`--model fun-music-v1\`.`,
      });
    }
    return error;
  }

  private async buildStreamArtifacts(
    finalUrl: string | undefined,
    chunks: string[],
    input: MusicGenerateInput,
  ): Promise<MusicArtifact[]> {
    if (finalUrl) {
      return this.buildArtifacts([finalUrl], input);
    }
    if (chunks.length === 0) return [];
    if (input.download === false) return [];
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
    const path = this.deps.downloader.writeBytes(new Uint8Array(bytes), 0, input.out, 'mp3');
    return [{ url: '', path }];
  }

  private async buildArtifacts(
    urls: string[],
    input: MusicGenerateInput,
  ): Promise<MusicArtifact[]> {
    if (input.download === false) {
      return urls.map((url) => ({ url }));
    }

    const artifacts: MusicArtifact[] = [];
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index] as string;
      const path = await this.deps.downloader.download(url, index, input.out, 'mp3');
      artifacts.push({ url, path });
    }
    return artifacts;
  }

  private extractMeta(
    upstream: Record<string, unknown>,
    model: string,
  ): { requestId?: string; model?: string; usage?: Record<string, unknown> } {
    const meta: { requestId?: string; model?: string; usage?: Record<string, unknown> } = { model };
    if (typeof upstream.request_id === 'string' && upstream.request_id.length > 0) {
      meta.requestId = upstream.request_id;
    }
    const usage = upstream.usage;
    if (usage && typeof usage === 'object') meta.usage = usage as Record<string, unknown>;
    return meta;
  }
}

/** Fold the single generated track into the PRD `data.audio` object. */
function buildAudio(artifacts: MusicArtifact[]): Record<string, unknown> | undefined {
  const first = artifacts[0];
  if (first === undefined) return undefined;
  const audio: Record<string, unknown> = {};
  if (first.url !== undefined && first.url.length > 0) audio.url = first.url;
  if (first.path !== undefined) audio.path = first.path;
  const expiresIn = audio.url !== undefined ? expiresInFromUrl(audio.url as string) : undefined;
  if (expiresIn !== undefined) audio.expires_in = expiresIn;
  return audio;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}
