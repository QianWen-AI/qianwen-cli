import { homedir } from 'os';
import { join, resolve } from 'path';
import { site } from '../site.js';

const CONFIG_DIR_NAME = site.configDirName;
const CREDENTIALS_FILE = 'credentials';
const CONFIG_FILE = 'config.json';
const LOCAL_CONFIG_FILE = site.localConfigFile;
const MIGRATION_STATE_FILE = '.migrated-projects';
const DEVICE_FLOW_PENDING_FILE = '.device-flow-pending';

/**
 * Get the global config directory path (~/.qianwen).
 */
export function getConfigDir(): string {
  return join(homedir(), CONFIG_DIR_NAME);
}

/**
 * Get the credentials file path (~/.qianwen/credentials).
 */
export function getCredentialsPath(): string {
  return join(getConfigDir(), CREDENTIALS_FILE);
}

/**
 * Get the global config file path (~/.qianwen/config.json).
 */
export function getGlobalConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE);
}

/**
 * Path to a legacy project-level config file (.qianwen.json in cwd).
 * Retained only so the one-time migration can find and merge old files into
 * the global config; it is no longer the active config location.
 */
export function getLocalConfigPath(cwd?: string): string {
  return resolve(cwd ?? process.cwd(), LOCAL_CONFIG_FILE);
}

/**
 * Newline-delimited list of absolute paths whose legacy `.qianwen.json`
 * has already been merged into the global config.
 */
export function getMigrationStatePath(): string {
  return join(getConfigDir(), MIGRATION_STATE_FILE);
}

/**
 * Path to the device-flow pending state file (~/.qianwen/.device-flow-pending).
 * Used by --init-only / --complete two-stage login.
 */
export function getDeviceFlowPendingPath(): string {
  return join(getConfigDir(), DEVICE_FLOW_PENDING_FILE);
}
