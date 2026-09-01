/** Orchestrates tiers 0/1/2/3 into a native speech-synthesis body and drives the TTS client. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { MappingRegistry } from '../api/providers/mapping-registry.js';
import type { RequestPayloadParser } from './request-payload-parser.js';
import type { LayerConflictDetector } from './layer-conflict-detector.js';
import type { DefaultModelResolver } from './default-model-resolver.js';
import type { InvocationEnvelope } from './invocation-envelope.js';
import { withFieldRejectionHint } from './invocation-envelope.js';
import type { TTSClient } from '../api/providers/dashscope/tts-client.js';
import { COSYVOICE_SYNTHESIS_PATH } from '../api/providers/dashscope/tts-client.js';
import type {
  TtsWebSocketClient,
  TtsWsStreamingMode,
} from '../api/providers/dashscope/tts-ws-client.js';
import type { ImageDownloader } from './image-downloader.js';
import type { Layer2Assignment, SuccessEnvelope } from '../types/invocation-params.js';
import { expiresInFromUrl } from '../utils/expiry.js';

const TTS_COMMAND = 'audio speech';
const TTS_TASK_MODE = 'tts';

export const DEFAULT_TTS_MODEL = 'qwen-audio-3.0-tts-plus';
export const DEFAULT_TTS_VOICE = 'longanhuan_v3.6';

export interface AudioSpeechInput {
  text?: string;
  model?: string;
  voice?: string;
  out?: string;
  request?: string;
  download?: boolean;
}

export interface AudioSpeechArtifact {
  url?: string;
  path?: string;
}

export interface TTSServiceDeps {
  parser: RequestPayloadParser;
  conflictDetector: LayerConflictDetector;
  modelResolver: DefaultModelResolver;
  registry: MappingRegistry;
  envelope: InvocationEnvelope;
  client: TTSClient;
  wsClient: TtsWebSocketClient;
  downloader: ImageDownloader;
  context: () => { site: string; account: string };
}

/** Register the DashScope-native speech-synthesis entry into a mapping registry. */
export function registerTTSMappings(registry: MappingRegistry): void {
  registry.register({
    key: {
      command: TTS_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: 'qwen',
      taskMode: TTS_TASK_MODE,
    },
    fieldTemplates: { '--voice': 'input.voice' },
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

/**
 * Non-realtime CosyVoice and Qwen-Audio-TTS use a dedicated HTTP synthesis
 * endpoint (`.../audio/tts/SpeechSynthesizer`) instead of the multimodal path.
 */
function usesSpeechSynthesizerEndpoint(model: string): boolean {
  const lower = model.trim().toLowerCase();
  return lower.includes('cosyvoice') || lower.includes('qwen-audio');
}

function isQwenFamily(model: string): boolean {
  return model.trim().toLowerCase().startsWith('qwen');
}

/** Models that only expose the realtime WebSocket protocol (no synchronous HTTP). */
function websocketOnlyStreamingMode(model: string): TtsWsStreamingMode | undefined {
  const lower = model.trim().toLowerCase();
  if (lower.startsWith('sambert')) return 'out';
  if (lower.startsWith('cosyvoice-v3.5')) return 'duplex';
  return undefined;
}

/** Omni and live-translate models are multimodal chat, not speech synthesis. */
function isMultimodalChatModel(model: string): boolean {
  const lower = model.trim().toLowerCase();
  return /(^|[-.])(omni|livetranslate)([-.]|$)/.test(lower);
}

/** TTS models that only run over the realtime WebSocket protocol (no synchronous HTTP). */
function isRealtimeOnlyTtsModel(model: string): boolean {
  const lower = model.trim().toLowerCase();
  return lower.includes('-tts') && lower.includes('-realtime');
}

/** Models that synthesize only with a custom voice from cloning or design. */
function isVoiceDesignModel(model: string): boolean {
  const lower = model.trim().toLowerCase();
  if (lower.startsWith('cosyvoice-v3.5')) return true;
  return /^qwen3(\.\d+)?-tts-v[cd]([-.]|$)/.test(lower);
}

function audioExtensionFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  const segment = withoutQuery.split('/').pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot >= segment.length - 1) return 'mp3';
  return segment.slice(dot + 1).toLowerCase();
}

export class TTSService {
  constructor(private readonly deps: TTSServiceDeps) {}

  private layer2Assignments(input: AudioSpeechInput): Layer2Assignment[] {
    const assignments: Layer2Assignment[] = [];
    if (input.voice !== undefined) {
      assignments.push({ flag: '--voice', paths: ['input.voice'] });
    }
    return assignments;
  }

  async buildRequest(
    input: AudioSpeechInput,
  ): Promise<{ model: string; body: Record<string, unknown>; path?: string }> {
    const hasText = typeof input.text === 'string' && input.text.length > 0;
    const hasRequest = typeof input.request === 'string' && input.request.length > 0;

    if (!hasText && !hasRequest) {
      throw invalidArg('Provide text or a --request body for audio speech.');
    }

    let body: Record<string, unknown> = {};
    if (hasRequest) {
      const parsed = this.deps.parser.parse(input.request as string);
      body = { ...parsed.body };
    }

    body = this.deps.conflictDetector.applyModelOverride(body, input.model);

    const requestHasInput = Object.prototype.hasOwnProperty.call(body, 'input');
    if (hasText && requestHasInput) {
      throw invalidArg('Text cannot be combined with request.input. Use one or the other.');
    }

    const existingModel =
      typeof body.model === 'string' && body.model.trim().length > 0
        ? (body.model as string)
        : undefined;
    const model = await this.deps.modelResolver.resolve(
      { command: TTS_COMMAND, taskMode: TTS_TASK_MODE },
      input.model ?? existingModel,
    );
    body.model = model;

    if (isMultimodalChatModel(model)) {
      throw invalidArg(
        `"${model}" is a multimodal chat model, not a speech-synthesis model. ` +
          `Use "chat create --model ${model}" instead of "audio speech".`,
      );
    }
    if (isRealtimeOnlyTtsModel(model)) {
      throw invalidArg(
        `"${model}" only supports the realtime streaming protocol and cannot be called from "audio speech". ` +
          'Choose a non-realtime TTS model (drop the "-realtime" suffix).',
      );
    }

    this.deps.conflictDetector.assertNoConflict(this.layer2Assignments(input), body);

    if (hasText) {
      const audioInput: Record<string, unknown> = { text: input.text as string };
      if (input.voice !== undefined) {
        audioInput.voice = input.voice;
      } else if (isQwenFamily(model)) {
        audioInput.voice = DEFAULT_TTS_VOICE;
      }
      body.input = audioInput;
    } else if (input.voice !== undefined) {
      const audioInput =
        body.input && typeof body.input === 'object' ? (body.input as Record<string, unknown>) : {};
      audioInput.voice = input.voice;
      body.input = audioInput;
    }

    const path = usesSpeechSynthesizerEndpoint(model) ? COSYVOICE_SYNTHESIS_PATH : undefined;
    return { model, body, path };
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

  async generate(input: AudioSpeechInput): Promise<SuccessEnvelope> {
    const { model, body, path } = await this.buildRequest(input);
    const streaming = websocketOnlyStreamingMode(model);
    if (streaming) {
      return this.generateViaWebSocket(model, body, streaming, input);
    }
    const upstream = await this.withVoiceDesignHint(model, () =>
      withFieldRejectionHint(model, () => this.deps.client.generate(body, undefined, path)),
    );
    const urls = this.extractUrls(upstream);
    const artifacts = await this.buildArtifacts(urls, input);

    const audio = buildAudio(artifacts, input.voice);
    const data = audio !== undefined ? { audio } : {};
    return this.deps.envelope.success(data, this.extractMeta(upstream, model));
  }

  private async generateViaWebSocket(
    model: string,
    body: Record<string, unknown>,
    streaming: TtsWsStreamingMode,
    input: AudioSpeechInput,
  ): Promise<SuccessEnvelope> {
    const inputObj =
      body.input && typeof body.input === 'object' ? (body.input as Record<string, unknown>) : {};
    const text = typeof inputObj.text === 'string' ? inputObj.text : '';
    if (text.length === 0) {
      throw invalidArg('Provide text for audio speech.');
    }

    const parameters: Record<string, unknown> =
      body.parameters && typeof body.parameters === 'object'
        ? { ...(body.parameters as Record<string, unknown>) }
        : {};
    if (typeof inputObj.voice === 'string' && parameters.voice === undefined) {
      parameters.voice = inputObj.voice;
    }
    if (parameters.text_type === undefined) parameters.text_type = 'PlainText';
    if (parameters.format === undefined) parameters.format = 'mp3';

    const result = await this.synthesizeViaWebSocket(model, text, parameters, streaming);
    const artifacts =
      input.download === false
        ? []
        : [
            {
              path: this.deps.downloader.writeBytes(result.audio, 0, input.out, result.format),
            },
          ];

    const audio = buildAudio(artifacts, input.voice);
    const data = audio !== undefined ? { audio } : {};
    const meta: { model: string; usage?: Record<string, unknown> } = { model };
    if (result.usage) meta.usage = result.usage;
    return this.deps.envelope.success(data, meta);
  }

  private async synthesizeViaWebSocket(
    model: string,
    text: string,
    parameters: Record<string, unknown>,
    streaming: TtsWsStreamingMode,
  ): Promise<Awaited<ReturnType<TtsWebSocketClient['synthesize']>>> {
    return this.withVoiceDesignHint(model, () =>
      this.deps.wsClient.synthesize({ model, text, parameters, streaming }),
    );
  }

  /** Add a custom-voice hint when voice-clone/design models reject a system voice. */
  private async withVoiceDesignHint<T>(model: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isVoiceDesignModel(model) && error instanceof CliError) {
        throw new CliError({
          code: error.code,
          message: error.message,
          exitCode: error.exitCode,
          hint: `${model} synthesizes only with a custom voice from voice cloning or voice design; pass its --voice id (system voices are not supported).`,
          ...(error.detail ? { detail: error.detail } : {}),
        });
      }
      throw error;
    }
  }

  private async buildArtifacts(
    urls: string[],
    input: AudioSpeechInput,
  ): Promise<AudioSpeechArtifact[]> {
    if (input.download === false) {
      return urls.map((url) => ({ url }));
    }

    const artifacts: AudioSpeechArtifact[] = [];
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index] as string;
      const path = await this.deps.downloader.download(
        url,
        index,
        input.out,
        audioExtensionFromUrl(url),
      );
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

/** Fold the single synthesized clip into the PRD `data.audio` object. */
function buildAudio(
  artifacts: AudioSpeechArtifact[],
  voice: string | undefined,
): Record<string, unknown> | undefined {
  const first = artifacts[0];
  if (first === undefined) return undefined;
  const audio: Record<string, unknown> = {};
  if (first.url !== undefined) audio.url = first.url;
  if (first.path !== undefined) audio.path = first.path;
  if (voice !== undefined) audio.voice = voice;
  const expiresIn = first.url !== undefined ? expiresInFromUrl(first.url) : undefined;
  if (expiresIn !== undefined) audio.expires_in = expiresIn;
  return audio;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}
