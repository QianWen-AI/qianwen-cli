/**
 * Tests for the metadata-write-failure rollback path of SkillsInstallService:
 * the freshly deployed (metadata-less) directory must be parked into staging
 * and swept by the guarded cleanup, the previous version restored, and no
 * staging leftovers remain. writeSkillMeta failure is injected via vi.mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsInstallService } from '../../../src/services/skills-install-service.js';
import type { SkillsHubService } from '../../../src/services/skills-hub-service.js';
import { skillMetaPath } from '../../../src/services/skills-state-manager.js';
import type { SkillDetail, SkillMetadataV1 } from '../../../src/types/skills.js';
import { buildZip } from '../../fixtures/zip-builder.js';

const SLUG = 'pdf-extractor';

const metaWriteControl = vi.hoisted(() => ({ failNext: false }));

vi.mock('../../../src/services/skills-state-manager.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/skills-state-manager.js')>();
  const writeSkillMeta: typeof actual.writeSkillMeta = (dir, meta) => {
    if (metaWriteControl.failNext) {
      metaWriteControl.failNext = false;
      throw new Error('disk full');
    }
    actual.writeSkillMeta(dir, meta);
  };
  return { ...actual, writeSkillMeta };
});

function makeDetail(): SkillDetail {
  return {
    slug: SLUG,
    displayName: 'PDF Extractor',
    description: 'Extract text from PDFs',
    securityStatus: 'safe',
    auditStatus: 'safe',
    auditTime: '2026-07-01T00:00:00Z',
    latestVersion: '1.2.0',
    versions: [{ version: '1.2.0', publishedAt: '', changelog: '', isLatest: true }],
  };
}

function makeService(zip: Buffer): SkillsInstallService {
  const hub = {
    getSkillDetail: async () => makeDetail(),
    getSkillDownload: async () => ({
      ossUrl: 'https://oss.test.qianwenai.com/pkg.zip',
      expiresAt: '',
      // Matching hash so the integrity gate passes and the metadata-write
      // failure path under test is actually reached.
      sha256: createHash('sha256').update(zip).digest('hex'),
    }),
  };
  const fetchImpl = (async () => new Response(new Uint8Array(zip))) as typeof fetch;
  return new SkillsInstallService(hub as unknown as SkillsHubService, { fetchImpl });
}

function writeMetaFile(targetDir: string, meta: SkillMetadataV1): void {
  writeFileSync(skillMetaPath(targetDir), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

const goodZip = () => buildZip([{ path: 'SKILL.md', data: '# Skill', method: 8 }]);

let baseDir: string;
let targetDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'qianwen-rollback-'));
  targetDir = path.join(baseDir, SLUG);
  metaWriteControl.failNext = false;
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('SkillsInstallService — rollback on metadata write failure', () => {
  it('removes the metadata-less deployment on a fresh install with no staging leftovers', async () => {
    metaWriteControl.failNext = true;
    const svc = makeService(goodZip());

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
    });
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it('restores the previous content and metadata when an update fails', async () => {
    mkdirSync(targetDir);
    writeMetaFile(targetDir, {
      schemaVersion: 1,
      slug: SLUG,
      version: '1.0.0',
      sha256: 'aa'.repeat(32),
      installMethod: 'copy',
      installedAt: '2026-07-01T00:00:00.000Z',
      clientVersion: '1.3.0',
    });
    writeFileSync(path.join(targetDir, 'legacy.txt'), 'old content');
    metaWriteControl.failNext = true;
    const svc = makeService(goodZip());

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
    expect(readFileSync(path.join(targetDir, 'legacy.txt'), 'utf8')).toBe('old content');
    const kept = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(kept.version).toBe('1.0.0');
    expect(readdirSync(baseDir)).toEqual([SLUG]);
  });
});
