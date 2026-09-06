/** Composition seam for the async task modality: builds a fully wired TaskService. */

import { setTimeout as sleepFor } from 'timers/promises';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { getConfigValueWithSource } from '../config/manager.js';
import { site, sourceUserAgent } from '../site.js';
import { DashScopeTransport } from '../api/providers/dashscope/transport.js';
import { TaskClient } from '../api/providers/dashscope/task-client.js';
import { AsyncWaiter } from './async-waiter.js';
import { InvocationEnvelope } from './invocation-envelope.js';
import { InvocationCredentialResolver } from './invocation-credential-resolver.js';
import { EndpointResolver } from './endpoint-resolver.js';
import { TaskService, type TaskAssetDownloader } from './task-service.js';
import { TranscriptFetcher } from './transcript.js';
import { ImageDownloader } from './image-downloader.js';
import { extractModel3dAssets } from './model3d-service.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export interface TaskRuntimeOptions {
  apiKey?: string;
  endpoint?: string;
}

export function createTaskService(options: TaskRuntimeOptions = {}): TaskService {
  const credentialResolver = new InvocationCredentialResolver({
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
    commandType: 'task-get',
    userAgent: sourceUserAgent(),
  });
  const client = new TaskClient({ transport });

  const waiter = new AsyncWaiter({
    sleep: (ms) => sleepFor(ms),
    now: () => Date.now(),
  });

  return new TaskService({
    client,
    waiter,
    envelope: new InvocationEnvelope(),
    transcriptFetcher: new TranscriptFetcher({
      fetchText: async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      },
    }),
    assetDownloader: createTaskAssetDownloader(),
  });
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
};

function readMediaUrls(data: Record<string, unknown>): string[] {
  const raw = data.urls;
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === 'string' && u.length > 0);
}

function createTaskAssetDownloader(): TaskAssetDownloader | undefined {
  if (site.key !== 'qianwen') return undefined;

  const downloader = new ImageDownloader({
    fetchBytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new CliError({
          code: 'NETWORK_ERROR',
          message: `Failed to download asset (${response.status}): ${url}`,
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

  return {
    supports: (type) => type === 'model3d' || (type !== undefined && type in MEDIA_EXTENSIONS),
    download: async (data, out) => {
      const type = typeof data.type === 'string' ? data.type : undefined;
      const artifacts: Array<{ type: string; url: string; path: string }> = [];
      if (type === 'model3d') {
        const assets = extractModel3dAssets(data);
        for (let index = 0; index < assets.length; index += 1) {
          const asset = assets[index]!;
          const path = await downloader.download(asset.url, index, out, asset.ext);
          artifacts.push({ type: asset.type, url: asset.url, path });
        }
        return artifacts;
      }
      const ext = type !== undefined ? (MEDIA_EXTENSIONS[type] ?? 'bin') : 'bin';
      const urls = readMediaUrls(data);
      for (let index = 0; index < urls.length; index += 1) {
        const url = urls[index]!;
        const path = await downloader.download(url, index, out, ext);
        artifacts.push({ type: type ?? 'file', url, path });
      }
      return artifacts;
    },
  };
}
