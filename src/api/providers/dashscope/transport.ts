import { CliError } from '../../../utils/errors.js';
import { EXIT_CODES } from '../../../utils/exit-codes.js';
import type { NormalizedError } from '../../../types/model-invocation.js';
import { tokenPlanModelUnsupportedMessage } from '../../../site.js';

const DEFAULT_TIMEOUT_MS = 60_000;

const SOURCE_CONFIG_HEADER = 'X-DashScope-Source-Config';

export function paymentTier(token: string): 'payg' | 'tokenplan' | 'other' {
  if (token.startsWith('sk-ws-')) return 'payg';
  if (token.startsWith('sk-sp-')) return 'tokenplan';
  return 'other';
}

export interface TransportRequest {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  rawBody?: string;
  stream?: boolean;
}

export interface TransportDeps {
  baseUrl: string;
  token: string;
  channel: string;
  commandType: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

function normalizeErrorBody(payload: unknown, status: number, statusText: string): NormalizedError {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === 'object') {
      const nestedRecord = nested as Record<string, unknown>;
      const code = nestedRecord.code;
      const message = nestedRecord.message;
      if (typeof message === 'string') {
        return { code: typeof code === 'string' ? code : 'UNKNOWN_ERROR', message };
      }
    }

    const code = record.code;
    const message = record.message;
    if (typeof message === 'string') {
      return { code: typeof code === 'string' ? code : 'UNKNOWN_ERROR', message };
    }
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`,
  };
}

export class DashScopeTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly channel: string;
  private readonly commandType: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: TransportDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.token = deps.token;
    this.channel = deps.channel;
    this.commandType = deps.commandType;
    this.userAgent = deps.userAgent;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  }

  async request<T>(req: TransportRequest): Promise<T> {
    const response = await this.requestRaw(req);
    return (await response.json()) as T;
  }

  async requestRaw(req: TransportRequest): Promise<Response> {
    const url = `${this.baseUrl}${req.path}`;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
      [SOURCE_CONFIG_HEADER]: JSON.stringify({
        channel: this.channel,
        tags: { t1: this.commandType, t2: paymentTier(this.token) },
      }),
      ...req.headers,
      Authorization: `Bearer ${this.token}`,
    };
    const body = req.rawBody ?? (req.body === undefined ? undefined : JSON.stringify(req.body));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const resetTimer = (): void => {
      stopTimer();
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };
    resetTimer();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: req.method ?? 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const detail = controller.signal.aborted
        ? req.stream
          ? `Request stalled: the server sent no response for ${timeoutMs}ms (no data received). ` +
            `The endpoint may be queuing the job or not streaming for this model/account.`
          : `Request timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new CliError({
        code: 'NETWORK_ERROR',
        message: `${detail}\n  URL: ${url}`,
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    } finally {
      if (!req.stream) stopTimer();
    }

    if (!response.ok) {
      const payload = await response
        .clone()
        .json()
        .catch(() => undefined);
      const normalized = normalizeErrorBody(payload, response.status, response.statusText);
      stopTimer();
      if (
        (response.status === 403 || response.status === 404) &&
        paymentTier(this.token) === 'tokenplan'
      ) {
        throw new CliError({
          code: 'MODEL_NOT_SUPPORTED',
          message: tokenPlanModelUnsupportedMessage(),
          exitCode: EXIT_CODES.GENERAL_ERROR,
          detail: normalized.message,
        });
      }
      throw new CliError({
        code: normalized.code,
        message: normalized.message,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    if (req.stream) {
      resetTimer();
      return this.wrapStreamWithIdleTimer(response, controller.signal, resetTimer, stopTimer);
    }

    return response;
  }

  private wrapStreamWithIdleTimer(
    response: Response,
    signal: AbortSignal,
    resetTimer: () => void,
    stopTimer: () => void,
  ): Response {
    const source = response.body;
    if (!source) {
      stopTimer();
      return response;
    }

    const reader = source.getReader();
    const wrapped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const abortPromise = new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error(`Stream stalled (no data received in time)`));
              return;
            }
            signal.addEventListener(
              'abort',
              () => reject(new Error(`Stream stalled (no data received in time)`)),
              { once: true },
            );
          });
          const { value, done } = await Promise.race([reader.read(), abortPromise]);
          if (done) {
            stopTimer();
            controller.close();
            return;
          }
          resetTimer();
          controller.enqueue(value);
        } catch (error) {
          stopTimer();
          void reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        stopTimer();
        return reader.cancel(reason);
      },
    });

    return new Response(wrapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
