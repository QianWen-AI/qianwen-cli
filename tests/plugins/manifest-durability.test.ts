import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readInstalledManifest, writeInstalledManifest } from '../../src/plugins/manifest.js';

let root: string;
let file: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.manifest-durability-'));
  file = path.join(root, 'plugins.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('manifest durability boundaries', () => {
  it.each(['EACCES', 'EIO'])('read failure %s must not masquerade as an empty manifest', (code) => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('read failed'), { code });
    });
    expect(() => readInstalledManifest(file)).toThrow(
      expect.objectContaining({ code: 'CONFIG_ERROR', exitCode: 4 }),
    );
  });

  it('syncs the complete temporary file before rename and directory after rename', () => {
    const events: string[] = [];
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      events.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
      sync(fd);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      events.push('rename');
      rename(from, to);
    });
    writeInstalledManifest(file, { plugins: [] });
    expect(events).toEqual(['file', 'rename', 'directory']);
    expect(readInstalledManifest(file).plugins).toEqual([]);
  });

  it('file fsync failure preserves the original manifest and another writer temporary file', () => {
    const original = JSON.stringify({ plugins: [], disabledDefaults: ['demo'] });
    fs.writeFileSync(file, original);
    fs.writeFileSync(`${file}.tmp`, 'another writer');
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    });
    expect(() => writeInstalledManifest(file, { plugins: [] })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readFileSync(`${file}.tmp`, 'utf8')).toBe('another writer');
    expect(fs.readdirSync(root).sort()).toEqual(['plugins.json', 'plugins.json.tmp']);
  });

  it.each(['EINVAL', 'EIO'])(
    'directory sync %s reports a warning while retaining the committed manifest',
    (code) => {
      const sync = fs.fsyncSync;
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory())
          throw Object.assign(new Error('unsupported directory sync'), { code });
        sync(fd);
      });
      expect(() =>
        writeInstalledManifest(file, { plugins: [], disabledDefaults: ['demo'] }),
      ).not.toThrow();
      expect(readInstalledManifest(file).disabledDefaults).toEqual(['demo']);
      expect(stderr).toHaveBeenCalled();
    },
  );
});
