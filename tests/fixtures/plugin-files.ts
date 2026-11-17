import fs from 'node:fs';
import path from 'node:path';
import type { InstalledPlugin, PluginManifest } from '../../src/plugins/manifest.js';

export function directoryState(directory: string): Record<string, string> {
  if (!fs.existsSync(directory)) return {};
  return Object.fromEntries(
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return Object.entries(directoryState(file));
      return [
        [file, entry.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file, 'base64')],
      ];
    }),
  );
}

export function writePluginPackage(
  directory: string,
  name: string,
  version: string,
  manifest: PluginManifest,
  entry: string,
): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version, qianwen: manifest }),
  );
  fs.writeFileSync(path.join(directory, 'index.mjs'), entry);
  return directory;
}

export function npmRecord(
  name: string,
  version: string,
  manifest: PluginManifest,
): InstalledPlugin {
  return {
    name,
    version,
    source: 'npm',
    enabled: true,
    command: manifest.command,
    commandAliases: manifest.commandAliases,
  };
}

export function writeInstalledPlugins(
  file: string,
  plugins: InstalledPlugin[],
  disabledDefaults?: string[],
): void {
  fs.writeFileSync(
    file,
    JSON.stringify({ plugins, ...(disabledDefaults ? { disabledDefaults } : {}) }),
  );
}
