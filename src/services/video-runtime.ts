/** Composition seam for the video modality: builds a fully wired VideoService. */

import { setTimeout as sleepFor } from 'timers/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { site, sourceUserAgent } from '../site.js';
import { resolveCredentials } from '../auth/credentials.js';
import { getConfigValueWithSource } from '../config/manager.js';
import { DashScopeTransport } from '../api/providers/dashscope/transport.js';
import { VideoClient } from '../api/providers/dashscope/video-client.js';
import { TaskClient } from '../api/providers/dashscope/task-client.js';
import { MappingRegistry } from '../api/providers/mapping-registry.js';
import { RequestPayloadParser } from './request-payload-parser.js';
import { LayerConflictDetector } from './layer-conflict-detector.js';
import { InvocationEnvelope } from './invocation-envelope.js';
import { DefaultModelResolver } from './default-model-resolver.js';
import { AssetPolicy } from './asset-policy.js';
import { ImageDownloader } from './image-downloader.js';
import { OssUploader, assertLocalUploadSupported } from './oss-uploader.js';
import { AsyncWaiter } from './async-waiter.js';
import { TaskService } from './task-service.js';
import {
  InvocationCredentialResolver,
  API_KEY_ENV_NAME,
} from './invocation-credential-resolver.js';
import { EndpointResolver } from './endpoint-resolver.js';
import {
  VideoService,
  registerVideoMappings,
  DEFAULT_T2V_MODEL,
  DEFAULT_I2V_MODEL,
} from './video-service.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export interface VideoRuntimeOptions {
  apiKey?: string;
  endpoint?: string;
}

export function createVideoService(options: VideoRuntimeOptions = {}): VideoService {
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
    commandType: 'video-generate',
    userAgent: sourceUserAgent(),
  });
  const client = new VideoClient({ transport });

  const parser = new RequestPayloadParser({
    readFile: (path) => readFileSync(path, 'utf-8'),
    readStdin: () => readFileSync(0, 'utf-8'),
  });

  const registry = new MappingRegistry();
  registerVideoMappings(registry);

  const ossUploader = new OssUploader({ defaultEndpoint: site.dashscopeEndpoint });

  const modelResolver = new DefaultModelResolver({
    fetchMapping: async () => ({
      [`video generate:t2v`]: DEFAULT_T2V_MODEL,
      [`video generate:i2v`]: DEFAULT_I2V_MODEL,
    }),
    readCache: () => null,
    writeCache: () => {},
  });

  const assetPolicy = new AssetPolicy({
    readFileBytes: (path) => readFileSync(path),
    fileExists: (path) => existsSync(path) && statSync(path).isFile(),
    uploadTemp: async ({ path, model }) => {
      assertLocalUploadSupported(token);
      const result = await ossUploader.upload(path, {
        model,
        apiKey: token,
        endpoint: site.dashscopeEndpoint,
      });
      return result.ossUrl;
    },
    readCache: () => null,
    writeCache: () => {},
  });

  const downloader = new ImageDownloader({
    fetchBytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new CliError({
          code: 'NETWORK_ERROR',
          message: `Failed to download video (${response.status}): ${url}`,
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

  const taskService = new TaskService({
    client: new TaskClient({ transport }),
    waiter: new AsyncWaiter({ sleep: (ms) => sleepFor(ms), now: () => Date.now() }),
    envelope: new InvocationEnvelope(),
  });

  return new VideoService({
    parser,
    conflictDetector: new LayerConflictDetector(),
    modelResolver,
    registry,
    assetPolicy,
    taskService,
    client,
    downloader,
    context: () => ({ site: site.key, account: API_KEY_ENV_NAME }),
  });
}
