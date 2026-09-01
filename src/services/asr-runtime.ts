/** Composition seam for the transcription modality: builds a fully wired ASRService. */

import { setTimeout as sleepFor } from 'timers/promises';
import { existsSync, readFileSync, statSync } from 'fs';
import { site, sourceUserAgent } from '../site.js';
import { resolveCredentials } from '../auth/credentials.js';
import { getConfigValueWithSource } from '../config/manager.js';
import { DashScopeTransport } from '../api/providers/dashscope/transport.js';
import { ASRClient } from '../api/providers/dashscope/asr-client.js';
import { TaskClient } from '../api/providers/dashscope/task-client.js';
import { MappingRegistry } from '../api/providers/mapping-registry.js';
import { RequestPayloadParser } from './request-payload-parser.js';
import { LayerConflictDetector } from './layer-conflict-detector.js';
import { InvocationEnvelope } from './invocation-envelope.js';
import { DefaultModelResolver } from './default-model-resolver.js';
import { AssetPolicy } from './asset-policy.js';
import { AsyncWaiter } from './async-waiter.js';
import { OssUploader, assertLocalUploadSupported } from './oss-uploader.js';
import { TaskService } from './task-service.js';
import {
  InvocationCredentialResolver,
  API_KEY_ENV_NAME,
} from './invocation-credential-resolver.js';
import { EndpointResolver } from './endpoint-resolver.js';
import { ASRService, registerASRMappings, DEFAULT_ASR_MODEL } from './asr-service.js';
import { TranscriptFetcher } from './transcript.js';

export interface ASRRuntimeOptions {
  apiKey?: string;
  endpoint?: string;
}

export function createASRService(options: ASRRuntimeOptions = {}): ASRService {
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
    commandType: 'audio-transcribe',
    userAgent: sourceUserAgent(),
  });
  const client = new ASRClient({ transport });

  const parser = new RequestPayloadParser({
    readFile: (path) => readFileSync(path, 'utf-8'),
    readStdin: () => readFileSync(0, 'utf-8'),
  });

  const registry = new MappingRegistry();
  registerASRMappings(registry);

  const ossUploader = new OssUploader({ defaultEndpoint: site.dashscopeEndpoint });

  const modelResolver = new DefaultModelResolver({
    fetchMapping: async () => ({ [`audio transcribe:asr`]: DEFAULT_ASR_MODEL }),
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

  const taskService = new TaskService({
    client: new TaskClient({ transport }),
    waiter: new AsyncWaiter({ sleep: (ms) => sleepFor(ms), now: () => Date.now() }),
    envelope: new InvocationEnvelope(),
  });

  return new ASRService({
    parser,
    conflictDetector: new LayerConflictDetector(),
    modelResolver,
    registry,
    assetPolicy,
    taskService,
    client,
    envelope: new InvocationEnvelope(),
    context: () => ({ site: site.key, account: API_KEY_ENV_NAME }),
    transcriptFetcher: new TranscriptFetcher({
      fetchText: async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      },
    }),
  });
}
