/** Composition seam for the music modality: builds a fully wired MusicService. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { site, sourceUserAgent } from '../site.js';
import { resolveCredentials } from '../auth/credentials.js';
import { getConfigValueWithSource } from '../config/manager.js';
import { DashScopeTransport } from '../api/providers/dashscope/transport.js';
import { MusicClient } from '../api/providers/dashscope/music-client.js';
import { MappingRegistry } from '../api/providers/mapping-registry.js';
import { RequestPayloadParser } from './request-payload-parser.js';
import { LayerConflictDetector } from './layer-conflict-detector.js';
import { InvocationEnvelope } from './invocation-envelope.js';
import { DefaultModelResolver } from './default-model-resolver.js';
import { ImageDownloader } from './image-downloader.js';
import { SiteAvailabilityGuard } from './site-availability.js';
import {
  InvocationCredentialResolver,
  API_KEY_ENV_NAME,
} from './invocation-credential-resolver.js';
import { EndpointResolver } from './endpoint-resolver.js';
import { MusicService, registerMusicMappings, DEFAULT_MUSIC_MODEL } from './music-service.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export interface MusicRuntimeOptions {
  apiKey?: string;
  endpoint?: string;
}

export function createMusicService(options: MusicRuntimeOptions = {}): MusicService {
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
    commandType: 'music-generate',
    userAgent: sourceUserAgent(),
  });
  const client = new MusicClient({ transport });

  const parser = new RequestPayloadParser({
    readFile: (path) => readFileSync(path, 'utf-8'),
    readStdin: () => readFileSync(0, 'utf-8'),
  });

  const registry = new MappingRegistry();
  registerMusicMappings(registry);

  const modelResolver = new DefaultModelResolver({
    fetchMapping: async () => ({ [`music generate:music`]: DEFAULT_MUSIC_MODEL }),
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

  const guard = new SiteAvailabilityGuard({
    site: () => site.key,
    availableSites: new Set(['qianwen']),
    command: 'music generate',
  });

  return new MusicService({
    parser,
    conflictDetector: new LayerConflictDetector(),
    modelResolver,
    registry,
    envelope: new InvocationEnvelope(),
    client,
    downloader,
    guard,
    context: () => ({ site: site.key, account: API_KEY_ENV_NAME }),
  });
}
