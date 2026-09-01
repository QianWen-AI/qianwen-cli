/** WebSocket speech-synthesis boundary for models that only expose the DashScope realtime protocol. */

import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { CliError } from '../../../utils/errors.js';
import { EXIT_CODES } from '../../../utils/exit-codes.js';
import { WEBSOCKET_INFERENCE_PATH } from './endpoints.js';
import { paymentTier } from './transport.js';
import { tokenPlanModelUnsupportedMessage } from '../../../site.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Streaming mode: `duplex` sends text via continue-task, `out` sends it inside run-task. */
export type TtsWsStreamingMode = 'duplex' | 'out';

export interface TtsWsRequest {
  model: string;
  text: string;
  parameters: Record<string, unknown>;
  streaming: TtsWsStreamingMode;
}

export interface TtsWsResult {
  audio: Uint8Array;
  usage?: Record<string, unknown>;
  format: string;
}

export interface TtsWsClientDeps {
  baseUrl: string;
  token: string;
  userAgent: string;
  sourceConfig?: string;
  timeoutMs?: number;
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

function toWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const wsBase = trimmed.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${wsBase}${WEBSOCKET_INFERENCE_PATH}`;
}

function synthesisError(message: string, detail?: string): CliError {
  return new CliError({
    code: 'API_ERROR',
    message,
    exitCode: EXIT_CODES.GENERAL_ERROR,
    ...(detail ? { detail } : {}),
  });
}

/** A token-plan token hitting a model outside its entitlement reports as "model not exist". */
function isTokenPlanModelRejection(token: string, message: string): boolean {
  return paymentTier(token) === 'tokenplan' && /model\s+not\s+exist/i.test(message);
}

export class TtsWebSocketClient {
  constructor(private readonly deps: TtsWsClientDeps) {}

  async synthesize(req: TtsWsRequest): Promise<TtsWsResult> {
    const url = toWebSocketUrl(this.deps.baseUrl);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.deps.token}`,
      'User-Agent': this.deps.userAgent,
      ...(this.deps.sourceConfig ? { 'X-DashScope-Source-Config': this.deps.sourceConfig } : {}),
    };
    const ws = this.deps.connect
      ? this.deps.connect(url, headers)
      : new WebSocket(url, { headers });
    ws.binaryType = 'arraybuffer';

    const taskId = randomUUID();
    const format =
      typeof req.parameters.format === 'string' ? (req.parameters.format as string) : 'mp3';
    const chunks: Uint8Array[] = [];
    let usage: Record<string, unknown> | undefined;

    return await new Promise<TtsWsResult>((resolve, reject) => {
      let settled = false;
      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const finish = (error?: CliError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore close failures
        }
        if (error) {
          reject(error);
          return;
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const audio = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          audio.set(chunk, offset);
          offset += chunk.length;
        }
        if (audio.length === 0) {
          reject(synthesisError('WebSocket synthesis returned no audio.'));
          return;
        }
        resolve({ audio, usage, format });
      };

      const timer = setTimeout(() => {
        finish(synthesisError(`WebSocket synthesis timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const send = (payload: unknown): void => ws.send(JSON.stringify(payload));

      const runTask: Record<string, unknown> = {
        header: { action: 'run-task', task_id: taskId, streaming: req.streaming },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: req.model,
          parameters: req.parameters,
          input: req.streaming === 'out' ? { text: req.text } : {},
        },
      };

      ws.on('open', () => send(runTask));

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          chunks.push(new Uint8Array(data as ArrayBuffer));
          return;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }
        const header = (event.header ?? {}) as Record<string, unknown>;
        const name = header.event;
        if (name === 'task-started') {
          if (req.streaming === 'duplex') {
            send({
              header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
              payload: { input: { text: req.text } },
            });
            send({
              header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
              payload: { input: {} },
            });
          }
          return;
        }
        if (name === 'result-generated') {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (payload.usage && typeof payload.usage === 'object') {
            usage = payload.usage as Record<string, unknown>;
          }
          return;
        }
        if (name === 'task-finished') {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (payload.usage && typeof payload.usage === 'object') {
            usage = payload.usage as Record<string, unknown>;
          }
          finish();
          return;
        }
        if (name === 'task-failed') {
          const message =
            typeof header.error_message === 'string'
              ? header.error_message
              : 'WebSocket synthesis failed.';
          const code = typeof header.error_code === 'string' ? header.error_code : undefined;
          if (isTokenPlanModelRejection(this.deps.token, message)) {
            finish(
              new CliError({
                code: 'MODEL_NOT_SUPPORTED',
                message: tokenPlanModelUnsupportedMessage(),
                exitCode: EXIT_CODES.GENERAL_ERROR,
                detail: code ? `${message} (${code})` : message,
              }),
            );
            return;
          }
          finish(synthesisError(code ? `${message} (${code})` : message));
        }
      });

      ws.on('error', (error: Error) => finish(synthesisError(error.message)));
      ws.on('close', () => finish(synthesisError('WebSocket closed before synthesis completed.')));
    });
  }
}
