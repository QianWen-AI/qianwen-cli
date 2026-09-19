/**
 * Minimal zero-dependency ZIP reader for the skills install engine.
 *
 * Parse chain: EOCD (backward scan from the file tail) → Central Directory →
 * Local File Header. Entry sizes and CRC-32 always come from the Central
 * Directory: real-world archives set general-purpose bit 3 (data descriptor),
 * which zeroes the corresponding Local File Header fields.
 *
 * Hard rejections (any hit fails the whole archive, nothing is written):
 * encrypted entries, compression methods other than store(0)/deflate(8),
 * absolute or drive-letter paths, `..`/`.` segments, symlink entries
 * (external attributes), ZIP64 archives (EOCD64 locator or sentinel
 * values), duplicate entry paths and decompression bombs (per-entry and
 * total uncompressed ceilings plus an entry-count cap, all enforced from
 * Central Directory metadata before any byte is inflated). Extraction is
 * confined to the destination root with per-entry boundary and realpath
 * checks; files are created with O_EXCL (plus O_NOFOLLOW where available)
 * so an existing path or symlink can never be written through.
 */

import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  isSafeRelativeEntryPath,
  resolveWithinBase,
  isRealPathWithinBase,
} from './skills-security.js';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
const EOCD64_LOCATOR_SIZE = 20;
const MAX_COMMENT_LENGTH = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;

// Decompression-bomb ceilings. Real skill archives are kilobytes today; these
// leave orders of magnitude of headroom while keeping worst-case memory and
// disk usage bounded. Enforced from Central Directory metadata up front and
// re-checked while inflating.
const MAX_ENTRY_COUNT = 2000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const MIB = 1024 * 1024;

/** Raised for any malformed or rejected archive; message is user-facing. */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

export interface ZipEntry {
  /** Normalized forward-slash relative path as stored in the archive. */
  path: string;
  isDirectory: boolean;
  method: number;
  flags: number;
  /** CRC-32 from the Central Directory. */
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Parse the Central Directory and validate every entry against the security
 * policy. Throws ZipReadError on any malformed or rejected input.
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ZipReadError('Invalid zip archive: file too small.');
  }

  const eocd = findEocd(buf);
  if (eocd < 0) {
    throw new ZipReadError('Invalid zip archive: end of central directory not found.');
  }

  // ZIP64 detection: an EOCD64 locator immediately precedes the EOCD.
  const locatorPos = eocd - EOCD64_LOCATOR_SIZE;
  if (locatorPos >= 0 && buf.readUInt32LE(locatorPos) === EOCD64_LOCATOR_SIGNATURE) {
    throw new ZipReadError('ZIP64 archives are not supported.');
  }

  const diskNumber = buf.readUInt16LE(eocd + 4);
  const cdDiskNumber = buf.readUInt16LE(eocd + 6);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || cdDiskNumber !== 0) {
    throw new ZipReadError('Multi-disk zip archives are not supported.');
  }
  // ZIP64 sentinel values without a locator still mean ZIP64.
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipReadError('ZIP64 archives are not supported.');
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipReadError('Invalid zip archive: central directory out of bounds.');
  }
  if (totalEntries > MAX_ENTRY_COUNT) {
    throw new ZipReadError(
      `Zip archive has too many entries (${totalEntries} > ${MAX_ENTRY_COUNT}).`,
    );
  }

  const entries: ZipEntry[] = [];
  const seenPaths = new Set<string>();
  let totalUncompressed = 0;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_DIR_SIGNATURE) {
      throw new ZipReadError('Invalid zip archive: corrupt central directory.');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    // Sizes and CRC are authoritative here even when bit 3 zeroes the LFH copies.
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const externalAttributes = buf.readUInt32LE(p + 38);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const entryPath = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipReadError(`Encrypted zip entries are not supported: ${entryPath}`);
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipReadError(`Unsupported compression method ${method}: ${entryPath}`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipReadError('ZIP64 archives are not supported.');
    }
    // Unix mode lives in the high 16 bits of the external attributes.
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new ZipReadError(`Symlink zip entries are not allowed: ${entryPath}`);
    }
    if (!isSafeRelativeEntryPath(entryPath)) {
      throw new ZipReadError(`Unsafe zip entry path rejected: ${entryPath}`);
    }
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new ZipReadError(
        `Zip entry exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES / MIB} MiB uncompressed size limit: ${entryPath}`,
      );
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ZipReadError(
        `Zip archive exceeds the ${MAX_TOTAL_UNCOMPRESSED_BYTES / MIB} MiB total uncompressed size limit.`,
      );
    }
    // A trailing slash only marks a directory; "dir" and "dir/" still collide
    // on the file system, so both count as the same path here.
    const pathKey = entryPath.replace(/\/+$/, '');
    if (seenPaths.has(pathKey)) {
      throw new ZipReadError(`Duplicate zip entry for path: ${entryPath}`);
    }
    seenPaths.add(pathKey);

    entries.push({
      path: entryPath,
      isDirectory: entryPath.endsWith('/'),
      method,
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    p += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Extract a validated archive under `destDir` (which must already exist).
 * Every entry passes a resolve-based boundary check plus a realpath probe
 * before any byte is written; decompressed data is verified against the
 * Central Directory size and CRC-32.
 */
export function extractZipTo(buf: Buffer, destDir: string): void {
  const entries = readZipEntries(buf);

  for (const entry of entries) {
    const target = resolveWithinBase(destDir, entry.path);
    if (target === null || !isRealPathWithinBase(destDir, target)) {
      throw new ZipReadError(`Zip entry escapes the extraction root: ${entry.path}`);
    }

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    const data = readEntryData(buf, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileExclusive(target, data, entry.path);
  }
}

/**
 * Read one file entry's decoded bytes by exact path (validated against the
 * Central Directory size and CRC-32) — used for nested payloads such as pack
 * member zips inside a pack archive. Throws ZipReadError when the path is
 * absent from the archive.
 */
export function readZipEntryByPath(buf: Buffer, entryPath: string): Buffer {
  const entries = readZipEntries(buf);
  const entry = entries.find((e) => e.path === entryPath && !e.isDirectory);
  if (!entry) {
    throw new ZipReadError(`Zip entry not found: ${entryPath}`);
  }
  return readEntryData(buf, entry);
}

// O_NOFOLLOW closes the check→open window against a symlink swapped in
// between; capability-detected because not every platform exposes it (the
// exclusive-create fallback still refuses to follow an existing symlink).
const O_NOFOLLOW: number | undefined = fs.constants.O_NOFOLLOW;

/** Create `target` exclusively and write `data`, never following symlinks. */
function writeFileExclusive(target: string, data: Buffer, entryPath: string): void {
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(target);
  } catch {
    // Path does not exist yet — the expected case.
  }
  if (existing?.isSymbolicLink()) {
    throw new ZipReadError(`Refusing to write through a symlink: ${entryPath}`);
  }

  try {
    if (typeof O_NOFOLLOW === 'number') {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
      const fd = fs.openSync(target, flags, 0o644);
      try {
        fs.writeFileSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.writeFileSync(target, data, { flag: 'wx' });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ZipReadError(`Duplicate zip entry for path: ${entryPath}`);
    }
    throw error;
  }
}

/** Decode one file entry's bytes, verifying size and CRC-32 against the CD. */
function readEntryData(buf: Buffer, entry: ZipEntry): Buffer {
  // Second layer of the bomb defence: reject oversized declarations even when
  // this function is reached without going through readZipEntries.
  if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    throw new ZipReadError(
      `Zip entry exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES / MIB} MiB uncompressed size limit: ${entry.path}`,
    );
  }
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipReadError(`Invalid zip archive: bad local header for ${entry.path}`);
  }
  // Name/extra lengths must come from the LFH — they may differ from the CD.
  const nameLength = buf.readUInt16LE(off + 26);
  const extraLength = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new ZipReadError(`Invalid zip archive: entry data out of bounds for ${entry.path}`);
  }

  const raw = buf.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (entry.method === METHOD_DEFLATE) {
    if (entry.uncompressedSize === 0) {
      data = Buffer.alloc(0);
    } else {
      try {
        // maxOutputLength caps inflation at the declared size, so a bomb fails
        // during decompression instead of after allocating its full payload.
        data = inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipReadError(`Zip entry inflates beyond its declared size: ${entry.path}`);
        }
        throw new ZipReadError(`Failed to decompress zip entry: ${entry.path}`);
      }
    }
  } else {
    data = Buffer.from(raw);
  }

  if (data.length !== entry.uncompressedSize) {
    throw new ZipReadError(`Zip entry size mismatch: ${entry.path}`);
  }
  if (crc32(data) !== entry.crc32) {
    throw new ZipReadError(`Zip entry CRC mismatch: ${entry.path}`);
  }
  return data;
}

/** Locate the EOCD record by scanning backwards over a possible comment. */
function findEocd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      const commentLength = buf.readUInt16LE(i + 20);
      if (i + EOCD_MIN_SIZE + commentLength === buf.length) return i;
    }
  }
  return -1;
}

// ── CRC-32 (IEEE 802.3 polynomial, as used by the zip format) ────────────────

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
