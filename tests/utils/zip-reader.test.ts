/**
 * Tests for the zero-dependency zip reader — happy paths (store, deflate,
 * data descriptor, implicit parent directories) and the full malicious-sample
 * rejection matrix: traversal, absolute paths, symlink entries, encryption,
 * unsupported methods, ZIP64 markers, corrupt CRC/size, decompression bombs
 * (per-entry / total-size / entry-count ceilings), duplicate entry paths and
 * symlink escape or swap at extraction time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readZipEntries, extractZipTo, ZipReadError, crc32 } from '../../src/utils/zip-reader.js';
import { buildZip } from '../fixtures/zip-builder.js';

describe('readZipEntries — parsing happy paths', () => {
  it('parses store and deflate entries with sizes/CRC from the Central Directory', () => {
    const zip = buildZip([
      { path: 'a.txt', data: 'hello', method: 0 },
      { path: 'b.txt', data: 'world of deflate', method: 8 },
    ]);

    const entries = readZipEntries(zip);

    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt']);
    expect(entries[0].uncompressedSize).toBe(5);
    expect(entries[0].crc32).toBe(crc32(Buffer.from('hello')));
    expect(entries[1].method).toBe(8);
  });

  it('reads sizes/CRC from the CD when bit 3 zeroes the local header fields', () => {
    const zip = buildZip([
      { path: 'dd.txt', data: 'descriptor', method: 8, useDataDescriptor: true },
    ]);

    const entries = readZipEntries(zip);

    expect(entries[0].flags & 0x0008).toBe(0x0008);
    expect(entries[0].uncompressedSize).toBe('descriptor'.length);
    expect(entries[0].crc32).toBe(crc32(Buffer.from('descriptor')));
  });

  it('parses archives with a trailing comment', () => {
    const zip = buildZip([{ path: 'c.txt', data: 'x' }], { comment: 'release notes' });

    expect(readZipEntries(zip)).toHaveLength(1);
  });

  it('flags directory entries', () => {
    const zip = buildZip([{ path: 'dir/' }, { path: 'dir/f.txt', data: 'y' }]);

    const entries = readZipEntries(zip);

    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].isDirectory).toBe(false);
  });
});

describe('readZipEntries — malicious sample rejection', () => {
  it('rejects encrypted entries', () => {
    const zip = buildZip([{ path: 'sec.txt', data: 'x', encrypted: true }]);
    expect(() => readZipEntries(zip)).toThrow(/Encrypted zip entries are not supported/);
  });

  it('rejects unsupported compression methods', () => {
    const zip = buildZip([{ path: 'bz.txt', data: 'x', method: 12 }]);
    expect(() => readZipEntries(zip)).toThrow(/Unsupported compression method 12/);
  });

  it('rejects symlink entries via external attributes', () => {
    const zip = buildZip([{ path: 'link', data: '/etc/passwd', unixMode: 0o120777 }]);
    expect(() => readZipEntries(zip)).toThrow(/Symlink zip entries are not allowed/);
  });

  it('rejects traversal entry paths', () => {
    const zip = buildZip([{ path: '../evil.txt', data: 'x' }]);
    expect(() => readZipEntries(zip)).toThrow(/Unsafe zip entry path rejected/);
  });

  it('rejects absolute entry paths', () => {
    const zip = buildZip([{ path: '/etc/cron.d/evil', data: 'x' }]);
    expect(() => readZipEntries(zip)).toThrow(/Unsafe zip entry path rejected/);
  });

  it('rejects drive-letter entry paths', () => {
    const zip = buildZip([{ path: 'C:/windows/evil.dll', data: 'x' }]);
    expect(() => readZipEntries(zip)).toThrow(/Unsafe zip entry path rejected/);
  });

  it('rejects ZIP64 archives detected via the EOCD64 locator', () => {
    const zip = buildZip([{ path: 'big.txt', data: 'x' }], { zip64Locator: true });
    expect(() => readZipEntries(zip)).toThrow(/ZIP64 archives are not supported/);
  });

  it('rejects ZIP64 sentinel entry counts', () => {
    const zip = buildZip([{ path: 'a.txt', data: 'x' }], { totalEntriesOverride: 0xffff });
    expect(() => readZipEntries(zip)).toThrow(/ZIP64 archives are not supported/);
  });

  it('rejects ZIP64 sentinel central-directory offsets', () => {
    const zip = buildZip([{ path: 'a.txt', data: 'x' }], { cdOffsetOverride: 0xffffffff });
    expect(() => readZipEntries(zip)).toThrow(/ZIP64 archives are not supported/);
  });

  it('rejects buffers too small to be a zip', () => {
    expect(() => readZipEntries(Buffer.from('tiny'))).toThrow(/file too small/);
  });

  it('rejects data without an EOCD record', () => {
    expect(() => readZipEntries(Buffer.alloc(64, 0x41))).toThrow(
      /end of central directory not found/,
    );
  });

  it('throws ZipReadError instances', () => {
    expect(() => readZipEntries(Buffer.alloc(64, 0x41))).toThrow(ZipReadError);
  });
});

describe('readZipEntries — decompression bombs and duplicate paths', () => {
  const MIB = 1024 * 1024;

  it('rejects an entry whose declared uncompressed size exceeds the per-entry limit', () => {
    const zip = buildZip([
      { path: 'bomb.bin', data: 'tiny', uncompressedSizeOverride: 50 * MIB + 1 },
    ]);
    expect(() => readZipEntries(zip)).toThrow(/exceeds the 50 MiB uncompressed size limit/);
  });

  it('accepts an entry declaring exactly the per-entry limit', () => {
    const zip = buildZip([{ path: 'edge.bin', data: 'tiny', uncompressedSizeOverride: 50 * MIB }]);
    expect(readZipEntries(zip)).toHaveLength(1);
  });

  it('rejects an archive whose summed uncompressed sizes exceed the total limit', () => {
    // Three entries stay under the per-entry ceiling but overflow the total.
    const zip = buildZip([
      { path: 'a.bin', data: 'x', uncompressedSizeOverride: 40 * MIB },
      { path: 'b.bin', data: 'x', uncompressedSizeOverride: 40 * MIB },
      { path: 'c.bin', data: 'x', uncompressedSizeOverride: 40 * MIB },
    ]);
    expect(() => readZipEntries(zip)).toThrow(/exceeds the 100 MiB total uncompressed size limit/);
  });

  it('rejects archives declaring more entries than the entry-count cap', () => {
    const zip = buildZip([{ path: 'a.txt', data: 'x' }], { totalEntriesOverride: 2001 });
    expect(() => readZipEntries(zip)).toThrow(/too many entries \(2001 > 2000\)/);
  });

  it('rejects duplicate entry paths at parse time', () => {
    const zip = buildZip([
      { path: 'dup.txt', data: 'first' },
      { path: 'dup.txt', data: 'second' },
    ]);
    expect(() => readZipEntries(zip)).toThrow(/Duplicate zip entry for path: dup\.txt/);
  });

  it('treats a file and a directory of the same name as duplicates', () => {
    const zip = buildZip([{ path: 'x/' }, { path: 'x', data: 'y' }]);
    expect(() => readZipEntries(zip)).toThrow(/Duplicate zip entry for path: x/);
  });
});

describe('extractZipTo — extraction behaviour', () => {
  let root: string;
  let dest: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qianwen-zipread-'));
    dest = path.join(root, 'dest');
    mkdirSync(dest);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes store and deflate entries with exact payloads', () => {
    const zip = buildZip([
      { path: 'plain.txt', data: 'stored bytes', method: 0 },
      { path: 'packed.txt', data: 'deflated bytes '.repeat(20), method: 8 },
    ]);

    extractZipTo(zip, dest);

    expect(readFileSync(path.join(dest, 'plain.txt'), 'utf8')).toBe('stored bytes');
    expect(readFileSync(path.join(dest, 'packed.txt'), 'utf8')).toBe('deflated bytes '.repeat(20));
  });

  it('creates parent directories for nested paths without directory entries', () => {
    const zip = buildZip([{ path: 'a/b/c/deep.txt', data: 'nested', method: 8 }]);

    extractZipTo(zip, dest);

    expect(readFileSync(path.join(dest, 'a', 'b', 'c', 'deep.txt'), 'utf8')).toBe('nested');
  });

  it('materializes explicit directory entries', () => {
    const zip = buildZip([{ path: 'only-dir/' }]);

    extractZipTo(zip, dest);

    expect(readdirSync(path.join(dest, 'only-dir'))).toEqual([]);
  });

  it('extracts data-descriptor archives end to end', () => {
    const zip = buildZip([
      { path: 'dd/a.txt', data: 'first', method: 8, useDataDescriptor: true },
      { path: 'dd/b.txt', data: 'second', method: 0, useDataDescriptor: true },
    ]);

    extractZipTo(zip, dest);

    expect(readFileSync(path.join(dest, 'dd', 'a.txt'), 'utf8')).toBe('first');
    expect(readFileSync(path.join(dest, 'dd', 'b.txt'), 'utf8')).toBe('second');
  });

  it('rejects the archive before writing anything when one entry is malicious', () => {
    const zip = buildZip([
      { path: 'ok.txt', data: 'fine' },
      { path: '../evil.txt', data: 'bad' },
    ]);

    expect(() => extractZipTo(zip, dest)).toThrow(ZipReadError);
    expect(existsSync(path.join(dest, 'ok.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'evil.txt'))).toBe(false);
  });

  it('blocks writes through a pre-existing symlinked directory (realpath probe)', () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(dest, 'link'));
    const zip = buildZip([{ path: 'link/evil.txt', data: 'escape' }]);

    expect(() => extractZipTo(zip, dest)).toThrow(/escapes the extraction root/);
    expect(existsSync(path.join(outside, 'evil.txt'))).toBe(false);
  });

  it('fails on a CRC mismatch against the Central Directory', () => {
    const zip = buildZip([{ path: 'bad-crc.txt', data: 'payload', crcOverride: 0xdeadbeef }]);

    expect(() => extractZipTo(zip, dest)).toThrow(/CRC mismatch/);
  });

  it('fails on a size mismatch against the Central Directory', () => {
    const zip = buildZip([{ path: 'bad-size.txt', data: 'payload', uncompressedSizeOverride: 3 }]);

    expect(() => extractZipTo(zip, dest)).toThrow(/size mismatch/);
  });

  it('fails when deflate data inflates beyond its declared size', () => {
    const zip = buildZip([
      {
        path: 'lying.bin',
        data: 'inflates way past what the directory claims',
        method: 8,
        uncompressedSizeOverride: 3,
      },
    ]);

    expect(() => extractZipTo(zip, dest)).toThrow(/inflates beyond its declared size/);
  });

  it('refuses to write through a pre-existing symlink even when it stays inside the root', () => {
    // A symlink resolving inside the destination passes the realpath probe;
    // the write layer itself must still refuse to follow it.
    writeFileSync(path.join(dest, 'inside.txt'), 'original');
    symlinkSync(path.join(dest, 'inside.txt'), path.join(dest, 'link.txt'));
    const zip = buildZip([{ path: 'link.txt', data: 'overwrite attempt' }]);

    expect(() => extractZipTo(zip, dest)).toThrow(/Refusing to write through a symlink/);
    expect(readFileSync(path.join(dest, 'inside.txt'), 'utf8')).toBe('original');
  });

  it('reports a duplicate-path error when the target file already exists', () => {
    writeFileSync(path.join(dest, 'exists.txt'), 'already here');
    const zip = buildZip([{ path: 'exists.txt', data: 'clobber attempt' }]);

    expect(() => extractZipTo(zip, dest)).toThrow(/Duplicate zip entry for path: exists\.txt/);
    expect(readFileSync(path.join(dest, 'exists.txt'), 'utf8')).toBe('already here');
  });

  it('extracts a DEFLATE 0-byte file without errors', () => {
    const zip = buildZip([{ path: 'pkg/__init__.py', data: Buffer.alloc(0), method: 8 }]);

    extractZipTo(zip, dest);

    const out = readFileSync(path.join(dest, 'pkg', '__init__.py'));
    expect(out.length).toBe(0);
  });

  it('extracts a STORE 0-byte file without errors', () => {
    const zip = buildZip([{ path: 'empty.txt', data: Buffer.alloc(0), method: 0 }]);

    extractZipTo(zip, dest);

    const out = readFileSync(path.join(dest, 'empty.txt'));
    expect(out.length).toBe(0);
  });

  it('extracts a mixed archive with 0-byte and normal files', () => {
    const zip = buildZip([
      { path: 'src/__init__.py', data: Buffer.alloc(0), method: 8 },
      { path: 'src/main.py', data: 'print("hello")', method: 8 },
    ]);

    extractZipTo(zip, dest);

    const empty = readFileSync(path.join(dest, 'src', '__init__.py'));
    expect(empty.length).toBe(0);
    expect(readFileSync(path.join(dest, 'src', 'main.py'), 'utf8')).toBe('print("hello")');
  });

  it('fails on undecompressable deflate data', () => {
    const zip = buildZip([{ path: 'junk.bin', data: 'not really deflate' }]);
    // Flip the method to deflate after building: raw stored bytes are not a
    // valid deflate stream, so inflateRawSync must fail.
    const cdPos = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(8, cdPos + 10);

    expect(() => extractZipTo(zip, dest)).toThrow(/Failed to decompress zip entry/);
  });
});
