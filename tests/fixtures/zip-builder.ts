/**
 * Programmatic ZIP fixture builder for zip-reader and install-service tests.
 *
 * Produces raw archive buffers with full control over the malicious knobs the
 * reader must reject: encryption flag, arbitrary compression methods, symlink
 * external attributes, traversal / absolute entry paths, data descriptors
 * (general-purpose bit 3), ZIP64 locators and sentinel values, plus corrupt
 * CRC / size fields. Uses its own CRC-32 so reader bugs cannot mask
 * themselves through a shared implementation.
 */

import { deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  /** Entry path exactly as stored (forward slashes; may be intentionally evil). */
  path: string;
  /** File payload; ignored for directory entries (path ending in '/'). */
  data?: Buffer | string;
  /** 0 = store, 8 = deflate; other values simulate unsupported methods. */
  method?: number;
  /** Set general-purpose bit 3 and zero the local-header CRC/size fields. */
  useDataDescriptor?: boolean;
  /** Set the encryption bit (bit 0). */
  encrypted?: boolean;
  /** Unix mode for the external attributes' high 16 bits (0o120777 = symlink). */
  unixMode?: number;
  /** Corrupt the Central Directory CRC with this value. */
  crcOverride?: number;
  /** Corrupt the Central Directory uncompressed size with this value. */
  uncompressedSizeOverride?: number;
}

export interface ZipBuildOptions {
  /** Insert an EOCD64 locator record immediately before the EOCD. */
  zip64Locator?: boolean;
  /** Force the EOCD total-entry count (e.g. 0xffff ZIP64 sentinel). */
  totalEntriesOverride?: number;
  /** Force the EOCD central-directory offset (e.g. 0xffffffff sentinel). */
  cdOffsetOverride?: number;
  /** Trailing archive comment. */
  comment?: string;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const DESCRIPTOR_SIG = 0x08074b50;

export function buildZip(specs: ZipEntrySpec[], options: ZipBuildOptions = {}): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const spec of specs) {
    const isDirectory = spec.path.endsWith('/');
    const raw = isDirectory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(spec.data)
        ? spec.data
        : Buffer.from(spec.data ?? '', 'utf8');
    const method = spec.method ?? 0;
    const stored = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const flags = (spec.encrypted ? 0x0001 : 0) | (spec.useDataDescriptor ? 0x0008 : 0) | 0x0800;
    const nameBuf = Buffer.from(spec.path, 'utf8');

    // Local File Header — bit 3 zeroes the CRC/size fields here.
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LOCAL_SIG, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(spec.useDataDescriptor ? 0 : crc, 14);
    lfh.writeUInt32LE(spec.useDataDescriptor ? 0 : stored.length, 18);
    lfh.writeUInt32LE(spec.useDataDescriptor ? 0 : raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    const localChunks = [lfh, nameBuf, stored];
    if (spec.useDataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DESCRIPTOR_SIG, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(stored.length, 8);
      descriptor.writeUInt32LE(raw.length, 12);
      localChunks.push(descriptor);
    }
    const localRecord = Buffer.concat(localChunks);
    localParts.push(localRecord);

    // Central Directory record — always carries the authoritative values.
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CENTRAL_SIG, 0);
    cdh.writeUInt16LE(0x031e, 4); // version made by: unix
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(spec.crcOverride ?? crc, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(spec.uncompressedSizeOverride ?? raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    const unixMode = spec.unixMode ?? (isDirectory ? 0o40755 : 0o100644);
    cdh.writeUInt32LE((unixMode << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([cdh, nameBuf]));

    offset += localRecord.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const commentBuf = Buffer.from(options.comment ?? '', 'utf8');

  const tail: Buffer[] = [];
  if (options.zip64Locator) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(EOCD64_LOCATOR_SIG, 0);
    tail.push(locator);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(options.totalEntriesOverride ?? specs.length, 8);
  eocd.writeUInt16LE(options.totalEntriesOverride ?? specs.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(options.cdOffsetOverride ?? offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  tail.push(eocd, commentBuf);

  return Buffer.concat([...localParts, centralDir, ...tail]);
}

// Independent CRC-32 implementation (do not share code with the reader).
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
