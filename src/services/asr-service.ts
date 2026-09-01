/** Orchestrates tiers 0/1/2/3 into a native async transcription body and drives the ASR client. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { MappingRegistry, type MappingKey } from '../api/providers/mapping-registry.js';
import type { RequestPayloadParser } from './request-payload-parser.js';
import type { LayerConflictDetector } from './layer-conflict-detector.js';
import type { DefaultModelResolver } from './default-model-resolver.js';
import type { AssetPolicy } from './asset-policy.js';
import type { TaskService } from './task-service.js';
import type { InvocationEnvelope } from './invocation-envelope.js';
import { withFieldRejectionHint } from './invocation-envelope.js';
import type { ASRClient } from '../api/providers/dashscope/asr-client.js';
import type { Layer2Assignment, SuccessEnvelope, FilePolicy } from '../types/invocation-params.js';
import type { TranscriptFetcher } from './transcript.js';

const ASR_COMMAND = 'audio transcribe';
const ASR_TASK_MODE = 'asr';

const DEFAULT_AUDIO_FILE_POLICY: FilePolicy = { allowBase64: false, allowTempUpload: true };

export const DEFAULT_ASR_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_ASR_POLL_INTERVAL_MS = 2000;
export const DEFAULT_ASR_MODEL = 'qwen-audio-3.0-asr-flash';

/** Qwen-family ASR (qwen-audio / qwen3-asr) is a synchronous multimodal-generation model. */
function isQwenFamily(model: string): boolean {
  return model.trim().toLowerCase().startsWith('qwen');
}

const SUPPORTED_AUDIO_FORMATS = new Set([
  'aac',
  'amr',
  'avi',
  'flac',
  'flv',
  'm4a',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mpeg',
  'ogg',
  'opus',
  'wav',
  'webm',
  'wma',
  'wmv',
]);

/** Qwen ASR requires an explicit audio `format`; infer it from the source extension. */
function inferAudioFormat(source: string): string {
  const withoutQuery = source.split('?')[0] ?? '';
  const segment = withoutQuery.split('/').pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot > 0 && dot < segment.length - 1) {
    const ext = segment.slice(dot + 1).toLowerCase();
    if (SUPPORTED_AUDIO_FORMATS.has(ext)) return ext;
  }
  return 'wav';
}

/** First audio URL inside a native request body's Qwen messages shape. */
function firstAudioUrlFromBody(input: unknown): string | undefined {
  const messages = asRecord(input)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const content = asRecord(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const audio = asRecord(part)?.audio;
      if (typeof audio === 'string' && audio.length > 0) return audio;
      const url = asRecord(audio)?.url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
  }
  return undefined;
}

export interface AudioTranscribeInput {
  source?: string;
  model?: string;
  language?: string;
  wait?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  request?: string;
}

export interface ASRServiceDeps {
  parser: RequestPayloadParser;
  conflictDetector: LayerConflictDetector;
  modelResolver: DefaultModelResolver;
  registry: MappingRegistry;
  assetPolicy: AssetPolicy;
  taskService: TaskService;
  client: ASRClient;
  envelope: InvocationEnvelope;
  context: () => { site: string; account: string };
  transcriptFetcher: TranscriptFetcher;
}

export interface AudioTranscribeOutcome {
  envelope: SuccessEnvelope;
  completed: boolean;
}

/** Register the DashScope-native transcription entry into a mapping registry. */
export function registerASRMappings(registry: MappingRegistry): void {
  registry.register({
    key: {
      command: ASR_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: 'fun',
      taskMode: ASR_TASK_MODE,
    },
    fieldTemplates: { '--language': 'parameters.language_hints' },
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

export class ASRService {
  constructor(private readonly deps: ASRServiceDeps) {}

  private mappingKey(model: string): MappingKey {
    return {
      command: ASR_COMMAND,
      protocol: 'dashscope-native',
      modelFamily: modelFamily(model),
      taskMode: ASR_TASK_MODE,
    };
  }

  private layer2Assignments(input: AudioTranscribeInput, qwen: boolean): Layer2Assignment[] {
    const assignments: Layer2Assignment[] = [];
    if (input.language !== undefined) {
      assignments.push({
        flag: '--language',
        paths: [qwen ? 'parameters.asr_options.language' : 'parameters.language_hints'],
      });
    }
    return assignments;
  }

  async buildRequest(input: AudioTranscribeInput): Promise<{
    model: string;
    body: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
  }> {
    const hasSource = typeof input.source === 'string' && input.source.length > 0;
    const hasRequest = typeof input.request === 'string' && input.request.length > 0;

    if (!hasSource && !hasRequest) {
      throw invalidArg('Provide an audio file or URL, or a --request body for audio transcribe.');
    }

    let body: Record<string, unknown> = {};
    if (hasRequest) {
      const parsed = this.deps.parser.parse(input.request as string);
      body = { ...parsed.body };
    }

    body = this.deps.conflictDetector.applyModelOverride(body, input.model);

    const requestHasInput = Object.prototype.hasOwnProperty.call(body, 'input');
    if (hasSource && requestHasInput) {
      throw invalidArg(
        'An audio source cannot be combined with request.input. Use one or the other.',
      );
    }

    const existingModel =
      typeof body.model === 'string' && body.model.trim().length > 0
        ? (body.model as string)
        : undefined;
    const model = await this.deps.modelResolver.resolve(
      { command: ASR_COMMAND, taskMode: ASR_TASK_MODE },
      input.model ?? existingModel,
    );
    body.model = model;

    const qwen = isQwenFamily(model);

    this.deps.conflictDetector.assertNoConflict(this.layer2Assignments(input, qwen), body);

    let extraHeaders: Record<string, string> | undefined;
    if (hasSource) {
      const built = await this.buildInput(input, model, qwen);
      body.input = built.input;
      extraHeaders = built.extraHeaders;
    }

    if (input.language !== undefined) {
      const parameters =
        body.parameters && typeof body.parameters === 'object'
          ? (body.parameters as Record<string, unknown>)
          : {};
      if (qwen) {
        const asrOptions =
          parameters.asr_options && typeof parameters.asr_options === 'object'
            ? (parameters.asr_options as Record<string, unknown>)
            : {};
        asrOptions.language = input.language;
        parameters.asr_options = asrOptions;
      } else {
        parameters.language_hints = [input.language];
      }
      body.parameters = parameters;
    }

    if (!Object.prototype.hasOwnProperty.call(body, 'parameters')) {
      body.parameters = {};
    }

    if (qwen) {
      const parameters = body.parameters as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(parameters, 'format')) {
        const audioSource = hasSource
          ? (input.source as string)
          : firstAudioUrlFromBody(body.input);
        if (audioSource !== undefined) {
          parameters.format = inferAudioFormat(audioSource);
        }
      }
    }

    return { model, body, ...(extraHeaders ? { extraHeaders } : {}) };
  }

  private async buildInput(
    input: AudioTranscribeInput,
    model: string,
    qwen: boolean,
  ): Promise<{ input: Record<string, unknown>; extraHeaders?: Record<string, string> }> {
    const entry = this.deps.registry.lookup(this.mappingKey(model));
    const filePolicy = entry?.filePolicy ?? DEFAULT_AUDIO_FILE_POLICY;
    const ctx = this.deps.context();
    const asset = await this.deps.assetPolicy.resolve(
      input.source as string,
      { site: ctx.site, account: ctx.account, model },
      filePolicy,
    );
    const built = qwen
      ? { messages: [{ role: 'user', content: [{ audio: asset.url }] }] }
      : { file_urls: [asset.url] };
    return {
      input: built,
      ...(asset.extraHeaders ? { extraHeaders: { ...asset.extraHeaders } } : {}),
    };
  }

  async generate(input: AudioTranscribeInput): Promise<AudioTranscribeOutcome> {
    const { model, body, extraHeaders } = await this.buildRequest(input);

    if (isQwenFamily(model)) {
      return this.generateSync(model, body, extraHeaders);
    }

    const submitUpstream = await withFieldRejectionHint(model, () =>
      this.deps.client.submit(body, extraHeaders),
    );

    const wait = input.wait !== false;
    const { envelope: raw, completed } = await this.deps.taskService.waitForTaskDetailed(
      submitUpstream,
      {
        wait,
        timeoutMs: input.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS,
        pollIntervalMs: input.pollIntervalMs ?? DEFAULT_ASR_POLL_INTERVAL_MS,
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

    return { envelope: await this.attachTranscript(envelope), completed: true };
  }

  private async generateSync(
    model: string,
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<AudioTranscribeOutcome> {
    const upstream = await withFieldRejectionHint(model, () =>
      this.deps.client.generate(body, extraHeaders),
    );

    const text = extractSyncText(upstream);
    const data: Record<string, unknown> = { ...upstream };
    if (text !== undefined) data.text = text;
    const language = extractSyncAnnotation(upstream, 'language');
    if (language !== undefined) data.language = language;
    const emotion = extractSyncAnnotation(upstream, 'emotion');
    if (emotion !== undefined) data.emotion = emotion;

    const meta: { requestId?: string; model: string; usage?: Record<string, unknown> } = { model };
    if (typeof upstream.request_id === 'string' && upstream.request_id.length > 0) {
      meta.requestId = upstream.request_id;
    }
    const usage =
      upstream.usage && typeof upstream.usage === 'object'
        ? (upstream.usage as Record<string, unknown>)
        : undefined;
    if (usage !== undefined) meta.usage = usage;

    return { envelope: this.deps.envelope.success(data, meta), completed: true };
  }

  private async attachTranscript(envelope: SuccessEnvelope): Promise<SuccessEnvelope> {
    const url = firstUrl(envelope.data);
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
        transcription_url: url,
      },
    };
  }
}

function firstUrl(data: Record<string, unknown>): string | undefined {
  const raw = data.urls;
  if (Array.isArray(raw)) {
    const found = raw.find((u): u is string => typeof u === 'string' && u.length > 0);
    if (found !== undefined) return found;
  }
  const single = data.transcription_url;
  return typeof single === 'string' && single.length > 0 ? single : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function firstMessage(output: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = output.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = asRecord(choices[0])?.message;
  return asRecord(message);
}

function extractSyncText(upstream: Record<string, unknown>): string | undefined {
  const output = asRecord(upstream.output);
  if (output === undefined) return undefined;

  const direct = output.text;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const sentenceText = asRecord(output.sentence)?.text;
  if (typeof sentenceText === 'string' && sentenceText.length > 0) return sentenceText;

  const content = firstMessage(output)?.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const text = asRecord(item)?.text;
      if (typeof text === 'string' && text.length > 0) parts.push(text);
    }
    if (parts.length > 0) return parts.join('');
  }
  return undefined;
}

function extractSyncAnnotation(
  upstream: Record<string, unknown>,
  field: 'language' | 'emotion',
): string | undefined {
  const output = asRecord(upstream.output);
  if (output === undefined) return undefined;

  const fromSentence = asRecord(output.sentence)?.[field];
  if (typeof fromSentence === 'string' && fromSentence.length > 0) return fromSentence;

  const annotations = firstMessage(output)?.annotations;
  if (Array.isArray(annotations)) {
    for (const item of annotations) {
      const value = asRecord(item)?.[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}
