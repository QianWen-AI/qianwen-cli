/**
 * Build tar headers independently so reader defects cannot be masked by shared code.
 */

import { gzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;

export interface TarEntrySpec {
  /** Entry path exactly as stored (forward slashes; may be intentionally evil). */
  name: string;
  /** File payload; ignored for directory entries. */
  data?: Buffer | string;
  /** ustar typeflag: '0' file, '5' dir, '2' symlink, '1' hardlink, etc. */
  typeflag?: string;
  /** Override the octal size field verbatim (e.g. 'ZZZZ' for non-octal). */
  sizeFieldOverride?: string;
  /** Override the declared size (bytes) independent of the real payload. */
  sizeOverride?: number;
  /** Replace the 6-byte ustar magic (e.g. 'xxxxx\0' to break detection). */
  magicOverride?: string;
}

export interface TarBuildOptions {
  /** Append the two zero-block end-of-archive terminator (default true). */
  terminate?: boolean;
  /** Skip gzip compression, returning the raw tar (for gunzip-failure tests). */
  noGzip?: boolean;
}

function inferType(spec: TarEntrySpec): string {
  if (spec.typeflag !== undefined) return spec.typeflag;
  return spec.name.endsWith('/') ? '5' : '0';
}

function buildHeader(spec: TarEntrySpec, payload: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(spec.name.slice(0, 100), 0, 'utf8');

  const size = spec.sizeOverride ?? payload.length;
  const sizeField = spec.sizeFieldOverride ?? size.toString(8).padStart(11, '0') + '\0';
  header.write(sizeField.slice(0, 12), 124, 'binary');

  // mode / uid / gid / mtime — plausible constants keep checksum realistic.
  header.write('0000644\0', 100, 'binary');
  header.write('0000000\0', 108, 'binary');
  header.write('0000000\0', 116, 'binary');
  header.write('00000000000\0', 136, 'binary');

  header.write(inferType(spec), 156, 'binary');

  const magic = spec.magicOverride ?? 'ustar\0';
  header.write(magic.slice(0, 6), 257, 'binary');
  header.write('00', 263, 'binary'); // version

  // Checksum: spaces first, sum all bytes, then write back as octal.
  header.write('        ', 148, 'binary');
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'binary');

  return header;
}

/** Build a gzip-compressed tarball (`.tgz`) from the given entry specs. */
export function buildTarball(entries: TarEntrySpec[], options: TarBuildOptions = {}): Buffer {
  const blocks: Buffer[] = [];

  for (const spec of entries) {
    const type = inferType(spec);
    const data = spec.data ?? '';
    const payload =
      type === '5'
        ? Buffer.alloc(0)
        : typeof data === 'string'
          ? Buffer.from(data, 'utf8')
          : Buffer.from(data);
    blocks.push(buildHeader(spec, payload));
    if (payload.length > 0) {
      const padded = Buffer.alloc(Math.ceil(payload.length / BLOCK_SIZE) * BLOCK_SIZE, 0);
      payload.copy(padded);
      blocks.push(padded);
    }
  }

  if (options.terminate !== false) {
    blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  }

  const tar = Buffer.concat(blocks);
  return options.noGzip ? tar : gzipSync(tar);
}
