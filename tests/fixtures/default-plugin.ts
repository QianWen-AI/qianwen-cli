import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type { PluginManifest } from '../../src/plugins/manifest.js';

/** A neutral default plugin exercises discovery without any product implementation. */
export const defaultPlugin: DefaultPlugin = {
  name: '@test/catalog-plugin',
  version: '1.0.0',
  source: { type: 'npm' },
  command: 'catalog',
};

export const defaultPluginManifest: PluginManifest = {
  command: 'catalog',
  description: 'Browse the example catalog',
  entry: './dist/index.js',
  auth: 'optional',
  subcommands: [
    {
      command: 'search [query]',
      description: 'Search the catalog',
      handlerKey: 'search',
      options: [
        { flag: '--limit <number>', description: 'Maximum results' },
        {
          flag: '--format <format>',
          description: 'Output format: table, json, text',
          choices: ['table', 'json', 'text'],
        },
      ],
    },
    {
      command: 'fetch <item>',
      description: 'Fetch a catalog item',
      handlerKey: 'fetch',
      options: [
        { flag: '--dir <path>', description: 'Destination directory' },
        {
          flag: '--format <format>',
          description: 'Output format: table, json, text',
          choices: ['table', 'json', 'text'],
        },
      ],
    },
    {
      command: 'sync-all <group>',
      description: 'Synchronize a catalog group',
      handlerKey: 'syncAll',
      options: [
        { flag: '--dir <path>', description: 'Destination directory' },
        {
          flag: '--format <format>',
          description: 'Output format: table, json, text',
          choices: ['table', 'json', 'text'],
        },
      ],
    },
  ],
};
