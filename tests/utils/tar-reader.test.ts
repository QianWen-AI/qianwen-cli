import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readTarEntries, extractTarballTo, TarReadError } from '../../src/utils/tar-reader.js';
import { buildTarball } from '../fixtures/tar-builder.js';

describe('readTarEntries — parsing happy paths', () => {
  it('parses file entries and strips the npm package/ prefix', () => {
    const tgz = buildTarball([
      { name: 'package/index.js', data: 'export default 1;' },
      { name: 'package/lib/util.js', data: 'export const x = 2;' },
    ]);

    const { entries } = readTarEntries(tgz);

    expect(entries.map((e) => e.path)).toEqual(['index.js', 'lib/util.js']);
    expect(entries[0].size).toBe('export default 1;'.length);
    expect(entries[0].isDirectory).toBe(false);
  });

  it('flags directory entries and drops the bare package/ prefix directory', () => {
    const tgz = buildTarball([
      { name: 'package/' },
      { name: 'package/src/' },
      { name: 'package/src/a.js', data: 'a' },
    ]);

    const { entries } = readTarEntries(tgz);

    // The bare `package/` prefix directory yields no entry.
    expect(entries.map((e) => e.path)).toEqual(['src', 'src/a.js']);
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].isDirectory).toBe(false);
  });

  it('reads octal size fields with space or NUL padding', () => {
    const tgz = buildTarball([{ name: 'package/big.txt', data: 'x'.repeat(300) }]);
    const { entries } = readTarEntries(tgz);
    expect(entries[0].size).toBe(300);
  });
});

describe('readTarEntries — malicious sample rejection', () => {
  it('rejects symlink entries', () => {
    const tgz = buildTarball([{ name: 'package/link', typeflag: '2', data: '/etc/passwd' }]);
    expect(() => readTarEntries(tgz)).toThrow(/Unsupported tar entry type/);
  });

  it('rejects hardlink entries', () => {
    const tgz = buildTarball([{ name: 'package/hard', typeflag: '1', data: 'package/index.js' }]);
    expect(() => readTarEntries(tgz)).toThrow(/Unsupported tar entry type/);
  });

  it('rejects character-device entries', () => {
    const tgz = buildTarball([{ name: 'package/dev', typeflag: '3' }]);
    expect(() => readTarEntries(tgz)).toThrow(/Unsupported tar entry type/);
  });

  it('rejects GNU long-name extension headers', () => {
    const tgz = buildTarball([{ name: 'package/././@LongLink', typeflag: 'L', data: 'x' }]);
    expect(() => readTarEntries(tgz)).toThrow(/Unsupported tar entry type/);
  });

  it('rejects entries outside the package/ prefix', () => {
    const tgz = buildTarball([{ name: 'evil/index.js', data: 'x' }]);
    expect(() => readTarEntries(tgz)).toThrow(/outside the npm 'package\/' prefix/);
  });

  it('rejects traversal paths under the prefix', () => {
    const tgz = buildTarball([{ name: 'package/../escape.js', data: 'x' }]);
    expect(() => readTarEntries(tgz)).toThrow(/Unsafe tar entry path rejected/);
  });

  it('rejects absolute paths', () => {
    const tgz = buildTarball([{ name: '/package/abs.js', data: 'x' }]);
    // A leading slash means the path is not under the package/ prefix.
    expect(() => readTarEntries(tgz)).toThrow(/outside the npm 'package\/' prefix/);
  });

  it('rejects a missing ustar magic', () => {
    const tgz = buildTarball([{ name: 'package/a.js', data: 'x', magicOverride: 'xxxxx\0' }]);
    expect(() => readTarEntries(tgz)).toThrow(/missing ustar magic/);
  });

  it('rejects a non-octal size field', () => {
    const tgz = buildTarball([{ name: 'package/a.js', data: 'x', sizeFieldOverride: 'ZZZZ\0' }]);
    expect(() => readTarEntries(tgz)).toThrow(/Invalid tar octal field/);
  });

  it('rejects an entry whose declared size runs past the buffer', () => {
    const tgz = buildTarball([{ name: 'package/a.js', data: 'x', sizeOverride: 100_000 }]);
    expect(() => readTarEntries(tgz)).toThrow(/out of bounds/);
  });

  it('rejects a per-entry decompression bomb', () => {
    const tgz = buildTarball([{ name: 'package/a.js', data: 'x', sizeOverride: 60 * 1024 * 1024 }]);
    expect(() => readTarEntries(tgz)).toThrow(/uncompressed size limit/);
  });

  it('rejects a total-size decompression bomb accumulated across entries', () => {
    // Each entry stays under the 50 MiB per-entry ceiling and is backed by
    // real data so the bounds check passes; their sum (120 MiB) crosses the
    // 100 MiB total ceiling on the third header, before its data is read.
    const chunk = 40 * 1024 * 1024;
    const entries = Array.from({ length: 3 }, (_, i) => ({
      name: `package/f${i}.js`,
      data: Buffer.alloc(chunk, 0x41),
    }));
    const tgz = buildTarball(entries);
    expect(() => readTarEntries(tgz)).toThrow(/total uncompressed size limit/);
  });

  // Building and inflating a 120 MiB fixture needs a longer timeout under load.
  it('rejects an oversized gunzip payload', () => {
    // A single valid file entry padded far beyond the total ceiling; the gzip
    // layer inflates past MAX_GUNZIP_OUTPUT_BYTES and fails during inflation.
    const tgz = buildTarball([{ name: 'package/big.js', data: 'A'.repeat(120 * 1024 * 1024) }]);
    expect(() => readTarEntries(tgz)).toThrow(/inflates beyond|total uncompressed size limit/);
  }, 20_000);

  it('rejects non-gzip input', () => {
    const notGzip = Buffer.from('this is definitely not a gzip stream');
    expect(() => readTarEntries(notGzip)).toThrow(/Failed to gunzip/);
  });

  it('rejects duplicate entry paths', () => {
    const tgz = buildTarball([
      { name: 'package/dup.js', data: 'a' },
      { name: 'package/dup.js', data: 'b' },
    ]);
    expect(() => readTarEntries(tgz)).toThrow(/Duplicate tar entry/);
  });
});

describe('extractTarballTo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tar-reader-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('materializes files and directories with the prefix stripped', () => {
    const dest = path.join(dir, 'out');
    mkdirSync(dest);
    const tgz = buildTarball([
      { name: 'package/index.js', data: 'main' },
      { name: 'package/lib/' },
      { name: 'package/lib/util.js', data: 'util' },
    ]);

    extractTarballTo(tgz, dest);

    expect(readFileSync(path.join(dest, 'index.js'), 'utf8')).toBe('main');
    expect(readFileSync(path.join(dest, 'lib', 'util.js'), 'utf8')).toBe('util');
    expect(readdirSync(dest).sort()).toEqual(['index.js', 'lib']);
  });

  it('refuses to write through a pre-existing symlink target', () => {
    const dest = path.join(dir, 'out');
    mkdirSync(dest);
    const outside = path.join(dir, 'outside.txt');
    symlinkSync(outside, path.join(dest, 'index.js'));

    const tgz = buildTarball([{ name: 'package/index.js', data: 'payload' }]);

    expect(() => extractTarballTo(tgz, dest)).toThrow(TarReadError);
    expect(existsSync(outside)).toBe(false);
  });

  it('refuses extraction when an intermediate directory is a symlink escaping the root', () => {
    const dest = path.join(dir, 'out');
    mkdirSync(dest);
    const escapeTarget = path.join(dir, 'escape');
    mkdirSync(escapeTarget);
    symlinkSync(escapeTarget, path.join(dest, 'lib'));

    const tgz = buildTarball([{ name: 'package/lib/evil.js', data: 'x' }]);

    expect(() => extractTarballTo(tgz, dest)).toThrow(TarReadError);
    expect(existsSync(path.join(escapeTarget, 'evil.js'))).toBe(false);
  });
});
