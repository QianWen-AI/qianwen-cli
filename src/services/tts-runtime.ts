/** Composition seam for the speech modality: builds a fully wired TTSService. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { site, sourceUserAgent } from '../site.js';
import { resolveCredentials } from '../auth/credentials.js';
import { getConfigValueWithSource } from '../config/manager.js';
import { DashScopeTransport } from '../api/providers/dashscope/transport.js';
import { TTSClient } from '../api/providers/dashscope/tts-client.js';
import { TtsWebSocketClient } from '../api/providers/dashscope/tts-ws-client.js';
import { MappingRegistry } from '../api/providers/mapping-registry.js';
import { RequestPayloadParser } from './request-payload-parser.js';
import { LayerConflictDetector } from './layer-conflict-detector.js';
import { InvocationEnvelope } from './invocation-envelope.js';
import { DefaultModelResolver } from './default-model-resolver.js';
import { ImageDownloader } from './image-downloader.js';
import {
  InvocationCredentialResolver,
  API_KEY_ENV_NAME,
} from './invocation-credential-resolver.js';
import { EndpointResolver } from './endpoint-resolver.js';
import { TTSService, registerTTSMappings, DEFAULT_TTS_MODEL } from './tts-service.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export interface TTSRuntimeOptions {
  apiKey?: string;
  endpoint?: string;
}

export function createTTSService(options: TTSRuntimeOptions = {}): TTSService {
  const credentialResolver = new InvocationCredentialResolver({
    resolveOAuth: () => {
      const resolved = resolveCredentials();
      return resolved ? { access_token: resolved.access_token } : null;
    },
    readEnv: (name) => process.env[name],
    readConfig: () => {
      const entry = getConfigValueWithSource('model.api_key');
      return entry.source === 'global' ? entry.value : undefined;
    },
  });

  const endpointResolver = new EndpointResolver({
    readEnv: (name) => process.env[name],
    readConfig: () => {
      const entry = getConfigValueWithSource('model.endpoint');
      return entry.source === 'global' ? entry.value : undefined;
    },
  });

  const token = credentialResolver.resolve(options.apiKey).token;
  const baseUrl = endpointResolver.resolve(options.endpoint, token);
  const transport = new DashScopeTransport({
    baseUrl,
    token,
    channel: site.sourceChannel,
    commandType: 'audio-speech',
    userAgent: sourceUserAgent(),
  });
  const client = new TTSClient({ transport });
  const wsClient = new TtsWebSocketClient({
    baseUrl,
    token,
    userAgent: sourceUserAgent(),
  });

  const parser = new RequestPayloadParser({
    readFile: (path) => readFileSync(path, 'utf-8'),
    readStdin: () => readFileSync(0, 'utf-8'),
  });

  const registry = new MappingRegistry();
  registerTTSMappings(registry);

  const modelResolver = new DefaultModelResolver({
    fetchMapping: async () => ({ [`audio speech:tts`]: DEFAULT_TTS_MODEL }),
    readCache: () => null,
    writeCache: () => {},
  });

  const downloader = new ImageDownloader({
    fetchBytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new CliError({
          code: 'NETWORK_ERROR',
          message: `Failed to download audio (${response.status}): ${url}`,
          exitCode: EXIT_CODES.NETWORK_ERROR,
        });
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    writeFile: (path, bytes) => writeFileSync(path, bytes),
    ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
    fileExists: (path) => existsSync(path),
    isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
  });

  return new TTSService({
    parser,
    conflictDetector: new LayerConflictDetector(),
    modelResolver,
    registry,
    envelope: new InvocationEnvelope(),
    client,
    wsClient,
    downloader,
    context: () => ({ site: site.key, account: API_KEY_ENV_NAME }),
  });
}
