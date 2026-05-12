import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { getGlobalConfigPath, getLocalConfigPath, getMigrationStatePath } from './paths.js';
import { CONFIG_DEFAULTS, PUBLIC_KEYS, validateConfigValue } from './schema.js';
import type { ConfigKey, ConfigSchema, ConfigEntry } from '../types/config.js';
import { site } from '../site.js';

// ── Internal helpers: DRY config file operations ──────────────────────

/**
 * Read a config file and convert nested JSON to flat dot-notation.
 * Returns empty object on missing file or parse error.
 */
function readConfigFile(filePath: string): Partial<ConfigSchema> {
  if (!existsSync(filePath)) return {};

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    const result: Record<string, string> = {};
    for (const [section, values] of Object.entries(parsed)) {
      if (typeof values === 'object' && values !== null) {
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
          if (typeof value === 'string') {
            result[`${section}.${key}`] = value;
          }
        }
      }
    }
    return result as Partial<ConfigSchema>;
  } catch {
    return {};
  }
}

/**
 * Write a single key-value pair into a config file (nested JSON format).
 * Creates parent directory if needed when `ensureDir` is true.
 */
function writeConfigFile(
  filePath: string,
  key: ConfigKey,
  value: string,
  ensureDir: boolean = false,
): void {
  if (ensureDir) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  let config: Record<string, Record<string, string>> = {};
  if (existsSync(filePath)) {
    try {
      config = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      /* start fresh */
    }
  }

  const [section, prop] = key.split('.');
  if (!config[section]) config[section] = {};
  config[section][prop] = value;

  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Remove a key from a config file. Cleans up empty sections.
 */
function removeFromConfigFile(filePath: string, key: ConfigKey): void {
  if (!existsSync(filePath)) return;

  try {
    const config = JSON.parse(readFileSync(filePath, 'utf-8'));
    const [section, prop] = key.split('.');
    if (config[section]) {
      delete config[section][prop];
      if (Object.keys(config[section]).length === 0) {
        delete config[section];
      }
    }
    writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  } catch {
    /* ignore */
  }
}

// ── Legacy migration ──────────────────────────────────────────────────

let migrationAttempted = false;

/**
 * One-shot migration: if the cwd has a legacy `.qianwen.json` and it has
 * not been merged before, fold its values into `~/.qianwen/config.json`,
 * then record the absolute path so we never re-migrate. Keys already present
 * in the global config win — explicit user intent beats stale project data.
 * Failures are swallowed; migration must never block CLI startup.
 */
function migrateLegacyProjectConfigOnce(): void {
  if (migrationAttempted) return;
  migrationAttempted = true;

  try {
    const legacyPath = getLocalConfigPath();
    if (!existsSync(legacyPath)) return;

    const statePath = getMigrationStatePath();
    if (existsSync(statePath)) {
      try {
        const migrated = readFileSync(statePath, 'utf-8')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (migrated.includes(legacyPath)) return;
      } catch {
        /* fall through and attempt migration */
      }
    }

    const legacy = readConfigFile(legacyPath);
    const globalPath = getGlobalConfigPath();
    const current = readConfigFile(globalPath);

    for (const [key, value] of Object.entries(legacy)) {
      if (typeof value !== 'string') continue;
      if (key in current) continue;
      writeConfigFile(globalPath, key as ConfigKey, value, true);
    }

    const stateDir = dirname(statePath);
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    appendFileSync(statePath, `${legacyPath}\n`);
  } catch {
    /* never break CLI startup */
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Read global config (JSON format: ~/.qianwen/config.json)
 */
export function readGlobalConfig(): Partial<ConfigSchema> {
  return readConfigFile(getGlobalConfigPath());
}

/**
 * Get the effective (merged) config.
 * Priority: global > defaults
 */
export function getEffectiveConfig(): ConfigSchema {
  migrateLegacyProjectConfigOnce();
  return {
    ...CONFIG_DEFAULTS,
    ...readGlobalConfig(),
  };
}

/**
 * Get all config entries with their sources.
 */
export function getConfigEntries(): ConfigEntry[] {
  migrateLegacyProjectConfigOnce();
  const globalConfig = readGlobalConfig();
  const entries: ConfigEntry[] = [];

  for (const key of PUBLIC_KEYS) {
    if (key in globalConfig) {
      entries.push({
        key,
        value: globalConfig[key] as string,
        source: 'global',
        sourcePath: `~/${site.configDirName}/config.json`,
      });
    } else {
      entries.push({
        key,
        value: CONFIG_DEFAULTS[key] as string,
        source: 'default',
      });
    }
  }

  return entries;
}

/**
 * Get a single config value.
 */
export function getConfigValue(key: ConfigKey): string {
  const config = getEffectiveConfig();
  return config[key] as string;
}

/**
 * Get a single config value along with the source it was resolved from.
 * Useful for `config get --format json`, where Agents need to know whether a
 * value came from the global file or the built-in default.
 */
export function getConfigValueWithSource(key: ConfigKey): {
  value: string;
  source: 'global' | 'default';
  sourcePath?: string;
} {
  migrateLegacyProjectConfigOnce();
  const globalConfig = readGlobalConfig();
  if (key in globalConfig) {
    return {
      value: globalConfig[key] as string,
      source: 'global',
      sourcePath: `~/${site.configDirName}/config.json`,
    };
  }
  return { value: CONFIG_DEFAULTS[key] as string, source: 'default' };
}

/**
 * Set a config value in `~/.qianwen/config.json`.
 */
export function setConfigValue(key: ConfigKey, value: string): void {
  const error = validateConfigValue(key, value);
  if (error) {
    throw new Error(error);
  }
  writeConfigFile(getGlobalConfigPath(), key, value, true);
}

/**
 * Unset (remove) a config value from `~/.qianwen/config.json`.
 */
export function unsetConfigValue(key: ConfigKey): void {
  removeFromConfigFile(getGlobalConfigPath(), key);
}
