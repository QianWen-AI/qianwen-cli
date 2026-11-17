import type { PluginManifest } from './manifest.js';
import type { PluginHandler } from './loader.js';

/** A module provider lets default and installed plugins share one executor. */
export interface PluginDescriptor {
  name: string;
  version: string;
  manifest: PluginManifest;
  loadHandlers: () => Promise<{ handlers?: Record<string, PluginHandler> }>;
}
