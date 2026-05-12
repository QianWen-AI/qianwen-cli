import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { getConfigDir } from '../config/paths.js';
import { join } from 'path';

const DEVICE_FILE = 'device';

/**
 * Get the device file path (~/.qianwen/device).
 */
function getDeviceFilePath(): string {
  return join(getConfigDir(), DEVICE_FILE);
}

/**
 * Get or create a persistent device_id for this machine.
 * Reads from ~/.qianwen/device if exists, otherwise generates UUID v4 and writes to file.
 * File permissions set to 0o600 (owner read/write only) for security.
 */
export function getOrCreateClientId(): string {
  const filePath = getDeviceFilePath();

  // Read existing device_id
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8').trim();
      if (content) return content;
    } catch {
      // Fall through to create new one
    }
  }

  // Create new device_id
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const deviceId = randomUUID();
  writeFileSync(filePath, deviceId + '\n');
  // Set owner-only permissions (matching credentials file security)
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on Windows or certain filesystems — non-critical
  }
  return deviceId;
}
