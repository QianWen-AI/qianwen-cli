/**
 * Unit tests for ImageDownloader — turns a remote image URL into a local file.
 *
 * All filesystem and network effects are injected; the naming and routing
 * logic runs for real.
 */
import { describe, it, expect, vi } from 'vitest';
import { ImageDownloader, type ImageDownloaderDeps } from '../../src/services/image-downloader.js';

function makeDeps(overrides: Partial<ImageDownloaderDeps> = {}): {
  deps: ImageDownloaderDeps;
  writes: Array<{ path: string; bytes: Uint8Array }>;
  dirs: string[];
} {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const dirs: string[] = [];
  const deps: ImageDownloaderDeps = {
    fetchBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    writeFile: vi.fn((path: string, bytes: Uint8Array) => {
      writes.push({ path, bytes });
    }),
    ensureDir: vi.fn((dir: string) => {
      dirs.push(dir);
    }),
    fileExists: vi.fn(() => false),
    isDirectory: vi.fn(() => false),
    ...overrides,
  };
  return { deps, writes, dirs };
}

describe('ImageDownloader.inferFileName', () => {
  it('derives the file name from the URL last segment', () => {
    const { deps } = makeDeps();
    expect(
      new ImageDownloader(deps).inferFileName('https://mock-api.test.qianwenai.com/a.png', 0),
    ).toBe('a.png');
  });

  it('strips a query string before taking the extension', () => {
    const { deps } = makeDeps();
    expect(
      new ImageDownloader(deps).inferFileName(
        'https://mock-api.test.qianwenai.com/b.jpg?sig=xyz',
        0,
      ),
    ).toBe('b.jpg');
  });

  it('falls back to a png name using the index when the URL has no file segment', () => {
    const { deps } = makeDeps();
    expect(new ImageDownloader(deps).inferFileName('https://mock-api.test.qianwenai.com/', 2)).toBe(
      'image-2.png',
    );
  });

  it('uses the caller fallback extension when the URL has no file segment', () => {
    const { deps } = makeDeps();
    const dl = new ImageDownloader(deps);
    expect(dl.inferFileName('https://mock-api.test.qianwenai.com/', 0, 'mp3')).toBe('file-0.mp3');
    expect(dl.inferFileName('https://mock-api.test.qianwenai.com/task/abc', 1, 'mp4')).toBe(
      'file-1.mp4',
    );
    expect(dl.inferFileName('https://mock-api.test.qianwenai.com/x', 0, '.GLB')).toBe('file-0.glb');
  });

  it('prefers a real URL extension over the fallback', () => {
    const { deps } = makeDeps();
    expect(
      new ImageDownloader(deps).inferFileName(
        'https://mock-api.test.qianwenai.com/song.wav',
        0,
        'mp3',
      ),
    ).toBe('song.wav');
  });
});

describe('ImageDownloader.download', () => {
  it('fetches the URL bytes and writes them to disk', async () => {
    const { deps, writes } = makeDeps();

    await new ImageDownloader(deps).download('https://mock-api.test.qianwenai.com/a.png', 0);

    expect(deps.fetchBytes).toHaveBeenCalledWith('https://mock-api.test.qianwenai.com/a.png');
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([1, 2, 3]);
  });

  it('returns a path ending with the inferred file name when no out is given', async () => {
    const { deps } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/a.png',
      0,
    );

    expect(path.endsWith('a.png')).toBe(true);
  });

  it('treats an out ending with a separator as a target directory', async () => {
    const { deps, dirs } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/a.png',
      0,
      'out/',
    );

    expect(dirs).toContain('out');
    expect(path).toBe('out/a.png');
  });

  it('treats an out pointing at an existing directory as a target directory', async () => {
    const { deps, dirs } = makeDeps({ isDirectory: vi.fn((p: string) => p === 'pics') });

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/a.png',
      0,
      'pics',
    );

    expect(dirs).toContain('pics');
    expect(path).toBe('pics/a.png');
  });

  it('uses an out file path verbatim for a single image', async () => {
    const { deps } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/a.png',
      0,
      'result.png',
    );

    expect(path).toBe('result.png');
  });

  it('appends the fallback extension when an out file path has none', async () => {
    const { deps } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/tripo.glb?auth_key=x',
      0,
      'd_3d_chair',
      'glb',
    );

    expect(path).toBe('d_3d_chair.glb');
  });

  it('suffixes the index before an appended fallback extension', async () => {
    const { deps } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/tripo.glb?auth_key=x',
      1,
      'd_3d_chair',
      'glb',
    );

    expect(path).toBe('d_3d_chair-1.glb');
  });

  it('rewrites the extension for a later asset when out carries a different one', async () => {
    const { deps } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/legacy_mesh.webp?auth_key=x',
      1,
      'chair.glb',
      'webp',
    );

    expect(path).toBe('chair-1.webp');
  });

  it('suffixes the out file base name with the index for a later image', async () => {
    const { deps } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/a.png',
      1,
      'result.png',
    );

    expect(path).toBe('result-1.png');
  });

  it('ensures the parent directory when out is a nested file path', async () => {
    const { deps, dirs } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/a.png',
      0,
      'nested/dir/result.png',
    );

    expect(dirs).toContain('nested/dir');
    expect(path).toBe('nested/dir/result.png');
  });

  it('does not ensure a directory for a bare file name', async () => {
    const { deps, dirs } = makeDeps();

    const path = await new ImageDownloader(deps).download(
      'https://mock-api.test.qianwenai.com/a.png',
      0,
      'result.png',
    );

    expect(dirs).toHaveLength(0);
    expect(path).toBe('result.png');
  });
});

describe('ImageDownloader.writeBytes', () => {
  it('writes materialized bytes to a fallback-named file when no --out is given', () => {
    const { deps, writes } = makeDeps();
    const bytes = new Uint8Array([9, 8, 7]);

    const path = new ImageDownloader(deps).writeBytes(bytes, 0, undefined, 'mp3');

    expect(path).toBe('file-0.mp3');
    expect(writes[0]!.path).toBe('file-0.mp3');
    expect(writes[0]!.bytes).toBe(bytes);
  });

  it('honours an explicit --out file path', () => {
    const { deps, writes } = makeDeps();

    const path = new ImageDownloader(deps).writeBytes(new Uint8Array([1]), 0, 'song.mp3', 'mp3');

    expect(path).toBe('song.mp3');
    expect(writes[0]!.path).toBe('song.mp3');
  });

  it('writes into an --out directory with the fallback file name', () => {
    const { deps, writes, dirs } = makeDeps({ isDirectory: vi.fn(() => true) });

    const path = new ImageDownloader(deps).writeBytes(new Uint8Array([1]), 0, 'out/', 'mp3');

    expect(path).toBe('out/file-0.mp3');
    expect(dirs).toContain('out');
    expect(writes[0]!.path).toBe('out/file-0.mp3');
  });
});
