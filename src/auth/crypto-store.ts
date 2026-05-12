// ============================================================
// AES-256-GCM encrypted credential storage module
// References the Python credential_store.py implementation, using Node.js
// built-in crypto.
// ============================================================

import crypto from 'crypto';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'fs';
import { platform, machine, homedir } from 'os';
import { join } from 'path';
import { loginCommand } from '../utils/runtime-mode.js';
import { site } from '../site.js';

// ─── Constants ──────────────────────────────────────────────

const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 260_000;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 32;
const NONCE_LEN = 12; // Standard GCM nonce

// ─── Types ──────────────────────────────────────────────────

export interface EncryptedEnvelope {
  version: number;
  salt: string; // base64
  nonce: string; // base64
  ciphertext: string; // base64
}

// ─── Helper functions ──────────────────────────────────────

/**
 * Run a shell command and return stdout (returns an empty string on failure).
 */
function runCommand(cmd: string, timeout: number = 5000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    }).trim();
  } catch {
    return '';
  }
}

// ─── Encryption / decryption ─────────────────────────────────────────

/**
 * PBKDF2-HMAC-SHA256 key derivation.
 */
function deriveKey(fingerprint: Buffer, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(fingerprint, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

/**
 * AES-256-GCM encrypt a dict → EncryptedEnvelope.
 */
function encryptDict(data: Record<string, unknown>, fingerprint: Buffer): EncryptedEnvelope {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const key = deriveKey(fingerprint, salt);
  const plaintext = Buffer.from(JSON.stringify(data, null, 0), 'utf-8');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Base64-encode ciphertext + authTag together (consistent with Python cryptography AESGCM behavior)
  const ciphertextWithTag = Buffer.concat([encrypted, authTag]);

  return {
    version: FORMAT_VERSION,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertextWithTag.toString('base64'),
  };
}

/**
 * AES-256-GCM decrypt an EncryptedEnvelope → dict.
 */
function decryptDict(envelope: EncryptedEnvelope, fingerprint: Buffer): Record<string, unknown> {
  if (envelope.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported credential file version: ${envelope.version}`);
  }

  const salt = Buffer.from(envelope.salt, 'base64');
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const ciphertextWithTag = Buffer.from(envelope.ciphertext, 'base64');
  const key = deriveKey(fingerprint, salt);

  // The GCM auth tag is fixed at 16 bytes, located at the end
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  } catch {
    throw new Error(
      'Decryption failed: machine fingerprint mismatch or file corrupted. Run: ' + loginCommand(),
    );
  }
}

// ─── Machine fingerprint collection ──────────────────────────────────────

/**
 * macOS hardware information sources.
 */
function getMacosSources(): string[] {
  const ioregOut = runCommand('ioreg -rd1 -c IOPlatformExpertDevice');
  const uuidMatch = ioregOut.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  const serialMatch = ioregOut.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);

  return [
    uuidMatch?.[1] ?? '',
    serialMatch?.[1] ?? '',
    runCommand('sysctl -n machdep.cpu.brand_string'),
    runCommand('sysctl -n kern.uuid'),
  ];
}

/**
 * Linux hardware information sources.
 */
function getLinuxSources(): string[] {
  // machine-id
  let machineId = '';
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    if (existsSync(p)) {
      try {
        machineId = readFileSync(p, 'utf-8').trim();
        if (machineId) break;
      } catch {
        /* permission denied */
      }
    }
  }

  // DMI fields
  const dmiFields = ['product_uuid', 'product_serial', 'board_serial'];
  const dmiValues: string[] = [];
  for (const field of dmiFields) {
    const sysPath = `/sys/class/dmi/id/${field}`;
    if (existsSync(sysPath)) {
      try {
        dmiValues.push(readFileSync(sysPath, 'utf-8').trim());
      } catch {
        // permission denied, try dmidecode
        dmiValues.push(runCommand(`dmidecode -s ${field.replace('_', '-')}`, 3000));
      }
    } else {
      dmiValues.push(runCommand(`dmidecode -s ${field.replace('_', '-')}`, 3000));
    }
  }

  return [machineId, ...dmiValues];
}

/**
 * Windows hardware information sources.
 */
function getWindowsSources(): string[] {
  // MachineGuid from registry
  const regOut = runCommand('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid');
  const guidMatch = regOut.match(/MachineGuid\s+REG_SZ\s+(\S+)/);

  // Motherboard UUID
  const wmicUuid = runCommand('wmic csproduct get UUID /value');
  const uuidMatch = wmicUuid.match(/UUID=(.+)/);

  // CPU ProcessorId
  const wmicCpu = runCommand('wmic cpu get ProcessorId /value');
  const cpuMatch = wmicCpu.match(/ProcessorId=(.+)/);

  return [guidMatch?.[1]?.trim() ?? '', uuidMatch?.[1]?.trim() ?? '', cpuMatch?.[1]?.trim() ?? ''];
}

/**
 * Get a stable physical MAC address (filter out random/virtual MAC addresses).
 */
function getStableMacAddress(): string {
  const os = platform();
  try {
    let raw: string;
    if (os === 'win32') {
      raw = runCommand('ipconfig /all');
    } else {
      raw = runCommand('ifconfig');
    }

    const macRegex = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})/gi;
    const macs: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = macRegex.exec(raw)) !== null) {
      const mac = match[1].toLowerCase();
      const firstByte = parseInt(mac.split(':')[0], 16);

      // Filter out multicast (bit 0) and locally-administered (bit 1, random/virtual addresses)
      if ((firstByte & 0x01) !== 0 || (firstByte & 0x02) !== 0) continue;
      if (mac === '00:00:00:00:00:00') continue;

      macs.push(mac);
    }

    return macs.length > 0 ? macs.sort()[0] : '';
  } catch {
    return '';
  }
}

/**
 * Get the machine fingerprint (32-byte SHA-256).
 */
export function getMachineFingerprint(): Buffer {
  const os = platform();
  let sources: string[];

  if (os === 'win32') {
    sources = getWindowsSources();
  } else if (os === 'darwin') {
    sources = getMacosSources();
  } else if (os === 'linux') {
    sources = getLinuxSources();
  } else {
    sources = [];
  }

  sources.push(getStableMacAddress());
  sources.push(machine());

  const combined = sources.filter((s) => s).join('|');
  if (!combined) {
    throw new Error(
      'Cannot collect any machine fingerprint information. Check system permissions or platform support.',
    );
  }

  return crypto.createHash('sha256').update(combined).digest();
}

// ─── HostID Fallback ────────────────────────────────────────

/**
 * Candidate paths for the HostID file.
 */
function getHostIdCandidates(): string[] {
  const candidates = [join(homedir(), site.configDirName, 'host_id')];
  if (platform() !== 'win32') {
    candidates.push(`/etc/${site.cliName}-host-id`);
  } else {
    const programData = process.env.PROGRAMDATA ?? 'C:\\ProgramData';
    candidates.push(join(programData, site.cliName, 'host_id'));
  }
  return candidates;
}

/**
 * Get or create the persisted HostID (fallback when the hardware fingerprint is unavailable).
 */
function getOrCreateHostId(): string {
  const candidates = getHostIdCandidates();

  // First, try to read an existing one
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8').trim();
        if (content.length >= 32) return content;
      } catch {
        continue;
      }
    }
  }

  // Create a new one
  const newId = crypto.randomUUID();
  for (const path of candidates) {
    try {
      const dir = join(path, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, newId, 'utf-8');
      if (platform() !== 'win32') {
        try {
          chmodSync(path, 0o600);
        } catch {
          /* ignore */
        }
      }
      return newId;
    } catch {
      continue;
    }
  }

  throw new Error('Cannot write HostID to any candidate path');
}

/**
 * Get the fingerprint or fall back (hardware fingerprint first; on failure, SHA-256 of the HostID).
 */
export function getFingerprintOrFallback(): Buffer {
  try {
    return getMachineFingerprint();
  } catch {
    // Hardware fingerprint unavailable; use HostID fallback
  }
  const hostId = getOrCreateHostId();
  return crypto.createHash('sha256').update(hostId).digest();
}

// ─── File I/O ──────────────────────────────────────────────

/**
 * Determine whether the content is in encrypted-envelope format.
 */
export function isEncryptedEnvelope(rawContent: string): boolean {
  try {
    const parsed = JSON.parse(rawContent);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      parsed.version === FORMAT_VERSION &&
      typeof parsed.salt === 'string' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.ciphertext === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * Write the encrypted credentials file (atomic write: .tmp + rename + chmod).
 */
export function writeEncryptedCredentials(data: Record<string, unknown>, filePath: string): void {
  const fingerprint = getFingerprintOrFallback();
  const envelope = encryptDict(data, fingerprint);

  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(envelope, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);

  if (platform() !== 'win32') {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* ignore on Windows */
    }
  }
}

/**
 * Read the encrypted credentials file → decrypted dict (returns null on failure).
 */
export function readEncryptedCredentials(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!isEncryptedEnvelope(content)) return null;

    const envelope: EncryptedEnvelope = JSON.parse(content);
    const fingerprint = getFingerprintOrFallback();
    return decryptDict(envelope, fingerprint);
  } catch {
    return null;
  }
}

/**
 * Write a plaintext credentials file (only for QIANWEN_KEYRING=plaintext debug mode).
 */
export function writePlaintextCredentials(data: Record<string, unknown>, filePath: string): void {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);

  if (platform() !== 'win32') {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* ignore */
    }
  }
}
