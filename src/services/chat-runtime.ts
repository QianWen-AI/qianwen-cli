/** Composition seam for the chat modality: builds a fully wired ChatService. */

import { existsSync, readFileSync } from 'fs';
import { statSync } from 'fs';
import { site, sourceUserAgent } from '../site.js';
import { resolveCredentials } from '../auth/credentials.js';
import { getConfigValueWithSource } from '../config/manager.js';
import { DashScopeTransport } from '../api/providers/dashscope/transport.js';
import { ChatClient } from '../api/providers/dashscope/chat-client.js';
import { MappingRegistry } from '../api/providers/mapping-registry.js';
import { RequestPayloadParser } from './request-payload-parser.js';
import { LayerConflictDetector } from './layer-conflict-detector.js';
import { InvocationEnvelope } from './invocation-envelope.js';
import { DefaultModelResolver } from './default-model-resolver.js';
import { AssetPolicy } from './asset-policy.js';
import { OssUploader, assertLocalUploadSupported } from './oss-uploader.js';
import {
  InvocationCredentialResolver,
  API_KEY_ENV_NAME,
} from './invocation-credential-resolver.js';
import { EndpointResolver } from './endpoint-resolver.js';
import { ChatService, registerChatMappings } from './chat-service.js';

const DEFAULT_CHAT_MODEL = 'qwen3.8-max';

export interface ChatRuntimeOptions {
  apiKey?: string;
  endpoint?: string;
}

export function createChatService(options: ChatRuntimeOptions = {}): ChatService {
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
    commandType: 'chat-create',
    userAgent: sourceUserAgent(),
  });
  const client = new ChatClient({ transport });

  const parser = new RequestPayloadParser({
    readFile: (path) => readFileSync(path, 'utf-8'),
    readStdin: () => readFileSync(0, 'utf-8'),
  });

  const registry = new MappingRegistry();
  registerChatMappings(registry);

  const ossUploader = new OssUploader({ defaultEndpoint: site.dashscopeEndpoint });

  const modelResolver = new DefaultModelResolver({
    fetchMapping: async () => ({ [`chat create:chat`]: DEFAULT_CHAT_MODEL }),
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

  return new ChatService({
    parser,
    conflictDetector: new LayerConflictDetector(),
    modelResolver,
    registry,
    assetPolicy,
    envelope: new InvocationEnvelope(),
    client,
    context: () => ({ site: site.key, account: API_KEY_ENV_NAME }),
  });
}
