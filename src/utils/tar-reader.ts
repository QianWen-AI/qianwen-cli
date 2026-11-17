/**
 * Read gzip-compressed npm ustar archives, stripping the required package/ prefix.
 * Accept only files and directories, with safe unique paths and bounded entry counts and sizes.
 * Extraction stays inside its root and refuses existing files or symlinks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isSafeRelativeEntryPath, resolveWithinBase, isRealPathWithinBase } from './path-safety.js';

const BLOCK_SIZE = 512;

// ustar header field offsets (POSIX.1-1988 / GNU tar compatible layout).
const OFF_NAME = 0;
const LEN_NAME = 100;
const OFF_SIZE = 124;
const LEN_SIZE = 12;
const OFF_TYPEFLAG = 156;
const OFF_MAGIC = 257;
const LEN_MAGIC = 6;
const OFF_PREFIX = 345;
const LEN_PREFIX = 155;

// Reject other entry types, including links and path-overriding extension headers.
const TYPE_FILE = '0';
const TYPE_FILE_LEGACY = '\0';
const TYPE_DIR = '5';

// npm tarballs place every member under this single top-level directory.
const NPM_PREFIX = 'package/';

// Bound decompression memory, extracted size and entry count.
const MAX_ENTRY_COUNT = 2000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const MIB = 1024 * 1024;

// Limit allocation during inflation, allowing one block for trailing archive padding.
const MAX_GUNZIP_OUTPUT_BYTES = MAX_TOTAL_UNCOMPRESSED_BYTES + BLOCK_SIZE;

/** Raised for any malformed or rejected archive; message is user-facing. */
export class TarReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarReadError';
  }
}

export interface TarEntry {
  /** Path relative to the extraction root, with the `package/` prefix stripped. */
  path: string;
  isDirectory: boolean;
  size: number;
  /** Offset of the entry's data within the inflated tar buffer. */
  dataOffset: number;
}

/**
 * Inflate the gzip layer and parse the tar stream into validated entries.
 * Throws TarReadError on any malformed or rejected input. The returned buffer
 * is the inflated tar so callers can slice entry data without re-inflating.
 */
export function readTarEntries(tgz: Buffer): { entries: TarEntry[]; tar: Buffer } {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: MAX_GUNZIP_OUTPUT_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TarReadError(
        `Tarball inflates beyond the ${MAX_TOTAL_UNCOMPRESSED_BYTES / MIB} MiB total uncompressed size limit.`,
      );
    }
    throw new TarReadError('Failed to gunzip tarball.');
  }

  const entries: TarEntry[] = [];
  const seenPaths = new Set<string>();
  let totalUncompressed = 0;
  let offset = 0;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);

    // Two consecutive all-zero blocks mark the end of the archive; a single
    // one is enough to stop parsing safely.
    if (isZeroBlock(header)) break;

    if (!hasUstarMagic(header)) {
      throw new TarReadError('Invalid tarball: missing ustar magic in header.');
    }

    const rawName = readString(header, OFF_NAME, LEN_NAME);
    const prefix = readString(header, OFF_PREFIX, LEN_PREFIX);
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const size = readOctal(header, OFF_SIZE, LEN_SIZE, fullName);
    const typeflag = String.fromCharCode(header[OFF_TYPEFLAG]);

    offset += BLOCK_SIZE;

    if (typeflag !== TYPE_FILE && typeflag !== TYPE_FILE_LEGACY && typeflag !== TYPE_DIR) {
      throw new TarReadError(`Unsupported tar entry type '${typeflag}': ${fullName}`);
    }

    if (entries.length >= MAX_ENTRY_COUNT) {
      throw new TarReadError(`Tarball has too many entries (> ${MAX_ENTRY_COUNT}).`);
    }
    if (size > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new TarReadError(
        `Tar entry exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES / MIB} MiB uncompressed size limit: ${fullName}`,
      );
    }
    totalUncompressed += size;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new TarReadError(
        `Tarball exceeds the ${MAX_TOTAL_UNCOMPRESSED_BYTES / MIB} MiB total uncompressed size limit.`,
      );
    }

    const dataOffset = offset;
    // Data is padded up to the next 512-byte boundary.
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (dataOffset + size > tar.length) {
      throw new TarReadError(`Invalid tarball: entry data out of bounds for ${fullName}`);
    }

    // Strip the mandatory npm `package/` prefix; anything outside it is a
    // malformed npm tarball and is refused.
    const isDirectory = typeflag === TYPE_DIR || fullName.endsWith('/');
    const relPath = stripNpmPrefix(fullName, isDirectory);
    if (relPath === null) {
      throw new TarReadError(`Tar entry outside the npm 'package/' prefix rejected: ${fullName}`);
    }
    // The prefix directory itself carries no content to write.
    if (relPath === '') continue;

    if (!isSafeRelativeEntryPath(relPath)) {
      throw new TarReadError(`Unsafe tar entry path rejected: ${fullName}`);
    }

    const pathKey = relPath.replace(/\/+$/, '');
    if (seenPaths.has(pathKey)) {
      throw new TarReadError(`Duplicate tar entry for path: ${relPath}`);
    }
    seenPaths.add(pathKey);

    entries.push({ path: relPath, isDirectory, size, dataOffset });
  }

  return { entries, tar };
}

/**
 * Extract a validated tarball under `destDir` (which must already exist).
 * Every entry passes a resolve-based boundary check plus a realpath probe
 * before any byte is written.
 */
export function extractTarballTo(tgz: Buffer, destDir: string): void {
  const { entries, tar } = readTarEntries(tgz);

  for (const entry of entries) {
    const target = resolveWithinBase(destDir, entry.path);
    if (target === null || !isRealPathWithinBase(destDir, target)) {
      throw new TarReadError(`Tar entry escapes the extraction root: ${entry.path}`);
    }

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    const data = tar.subarray(entry.dataOffset, entry.dataOffset + entry.size);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileExclusive(target, data, entry.path);
  }
}

// O_NOFOLLOW closes the check→open window against a symlink swapped in between;
// capability-detected because not every platform exposes it (the exclusive-
// create fallback still refuses to follow an existing symlink).
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
    throw new TarReadError(`Refusing to write through a symlink: ${entryPath}`);
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
      throw new TarReadError(`Duplicate tar entry for path: ${entryPath}`);
    }
    throw error;
  }
}

/**
 * Remove the leading `package/` segment. Returns the remainder (possibly the
 * empty string for the prefix directory itself), or null when the path is not
 * under the npm prefix at all.
 */
function stripNpmPrefix(fullName: string, isDirectory: boolean): string | null {
  const normalized = isDirectory ? fullName.replace(/\/+$/, '') + '/' : fullName;
  if (normalized === NPM_PREFIX || normalized === 'package') return '';
  if (!normalized.startsWith(NPM_PREFIX)) return null;
  const rest = normalized.slice(NPM_PREFIX.length);
  return isDirectory ? rest.replace(/\/+$/, '') : rest;
}

/** True when the whole 512-byte block is zero (archive terminator). */
function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/** ustar magic is the six bytes "ustar\0" (POSIX) or "ustar " (GNU). */
function hasUstarMagic(header: Buffer): boolean {
  const magic = header.subarray(OFF_MAGIC, OFF_MAGIC + LEN_MAGIC).toString('binary');
  return magic.startsWith('ustar');
}

/** Read a NUL-terminated field as UTF-8, trimming at the first NUL. */
function readString(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  const end = nul === -1 ? raw.length : nul;
  return raw.subarray(0, end).toString('utf8');
}

/**
 * Parse a tar octal numeric field. Fields are ASCII octal digits, optionally
 * space/NUL padded. Rejects non-octal content and negative results so a
 * malformed size can never drive the parser out of the buffer.
 */
function readOctal(header: Buffer, offset: number, length: number, entryName: string): number {
  const raw = header.subarray(offset, offset + length).toString('binary');
  const trimmed = raw.replace(/[\0 ]+$/, '').replace(/^[\0 ]+/, '');
  if (trimmed === '') return 0;
  if (!/^[0-7]+$/.test(trimmed)) {
    throw new TarReadError(`Invalid tar octal field for ${entryName}.`);
  }
  const value = parseInt(trimmed, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new TarReadError(`Invalid tar size field for ${entryName}.`);
  }
  return value;
}
