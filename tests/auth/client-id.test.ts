import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

let tmpDir: string;

vi.mock('../../src/config/paths.js', () => ({
  getConfigDir: () => tmpDir,
}));

const { getOrCreateClientId } = await import('../../src/auth/client-id.js');

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `${s.cliName}-clientid-`));
});

function cleanup() {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('getOrCreateClientId', () => {
  it('creates a new device file with UUID and 0o600 permissions when missing', () => {
    const id = getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const filePath = join(tmpDir, 'device');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8').trim()).toBe(id);

    if (process.platform !== 'win32') {
      const mode = statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    cleanup();
  });

  it('reads existing device file and returns the same id', () => {
    const filePath = join(tmpDir, 'device');
    writeFileSync(filePath, 'existing-device-id-12345\n');

    const id = getOrCreateClientId();
    expect(id).toBe('existing-device-id-12345');
    cleanup();
  });

  it('strips surrounding whitespace from the existing file', () => {
    const filePath = join(tmpDir, 'device');
    writeFileSync(filePath, '   abc-123   \n\n');

    const id = getOrCreateClientId();
    expect(id).toBe('abc-123');
    cleanup();
  });

  it('regenerates when existing file is empty', () => {
    const filePath = join(tmpDir, 'device');
    writeFileSync(filePath, '');

    const id = getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(filePath, 'utf-8').trim()).toBe(id);
    cleanup();
  });

  it('returns stable id across multiple calls', () => {
    const id1 = getOrCreateClientId();
    const id2 = getOrCreateClientId();
    const id3 = getOrCreateClientId();
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
    cleanup();
  });

  it('creates parent config dir if missing', () => {
    // Remove tmpDir so we test mkdir branch
    rmSync(tmpDir, { recursive: true, force: true });
    expect(existsSync(tmpDir)).toBe(false);

    const id = getOrCreateClientId();
    expect(existsSync(tmpDir)).toBe(true);
    expect(existsSync(join(tmpDir, 'device'))).toBe(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    cleanup();
  });
});
