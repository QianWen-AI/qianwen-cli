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

import { chmodSync } from 'node:fs';

const SLUG = 'pdf-extractor';
const FULL_SLUG = '@qianwen-ai/pdf-extractor';

const metaWriteControl = vi.hoisted(() => ({ failNext: false, sabotageRollback: false }));

vi.mock('../../../src/services/skills-state-manager.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/skills-state-manager.js')>();
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const writeSkillMeta: typeof actual.writeSkillMeta = (dir, meta) => {
    if (metaWriteControl.failNext) {
      metaWriteControl.failNext = false;
      if (metaWriteControl.sabotageRollback) {
        metaWriteControl.sabotageRollback = false;
        // Search parent and grandparent for staging dirs (handles full slug paths)
        const parents = new Set([nodePath.dirname(dir)]);
        const grandparent = nodePath.dirname(nodePath.dirname(dir));
        parents.add(grandparent);
        for (const searchDir of parents) {
          for (const entry of nodeFs.readdirSync(searchDir)) {
            if (entry.includes('staging')) {
              nodeFs.chmodSync(nodePath.join(searchDir, entry), 0o444);
            }
          }
        }
      }
      throw new Error('disk full');
    }
    actual.writeSkillMeta(dir, meta);
  };
  return { ...actual, writeSkillMeta };
});

function makeDetail(slug = SLUG): SkillDetail {
  return {
    slug,
    displayName: 'PDF Extractor',
    description: 'Extract text from PDFs',
    securityStatus: 'safe',
    auditStatus: 'safe',
    auditTime: '2026-07-01T00:00:00Z',
    latestVersion: '1.2.0',
    versions: [{ version: '1.2.0', publishedAt: '', changelog: '', isLatest: true }],
    provider: '',
  };
}

function makeService(zip: Buffer, slug = SLUG): SkillsInstallService {
  const hub = {
    getSkillDetail: async () => makeDetail(slug),
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
  metaWriteControl.sabotageRollback = false;
});

afterEach(() => {
  for (const entry of readdirSync(baseDir)) {
    if (entry.includes('staging')) {
      try {
        chmodSync(path.join(baseDir, entry), 0o755);
      } catch {}
    }
  }
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

describe('SkillsInstallService — rollback failure preserves staging', () => {
  it('throws with Unexpected error and preserves the staging directory when rollback rename fails', async () => {
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
    metaWriteControl.sabotageRollback = true;
    const svc = makeService(goodZip());

    const error = await svc.install({ slug: SLUG, baseDir }).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
      message: expect.stringContaining('Unexpected error while installing'),
    });
    expect((error as { message: string }).message).toContain('preserved in');
    expect((error as { message: string }).message).toMatch(/staging/);

    const stagingDirs = readdirSync(baseDir).filter((name) => name.includes('staging'));
    expect(stagingDirs.length).toBe(1);
  });
});

describe('SkillsInstallService — full slug rollback', () => {
  it('rolls back a fresh install with full slug when writeSkillMeta fails', async () => {
    metaWriteControl.failNext = true;
    const svc = makeService(goodZip(), FULL_SLUG);

    await expect(svc.install({ slug: FULL_SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
    });

    const fullTargetDir = path.join(baseDir, 'pdf-extractor');
    expect(existsSync(fullTargetDir)).toBe(false);
    const stagingDirs = readdirSync(baseDir).filter((name) => name.includes('staging'));
    expect(stagingDirs).toEqual([]);
  });

  it('restores the previous version with full slug when update fails', async () => {
    const fullTargetDir = path.join(baseDir, 'pdf-extractor');
    mkdirSync(fullTargetDir);
    writeMetaFile(fullTargetDir, {
      schemaVersion: 1,
      slug: FULL_SLUG,
      provider: '@qianwen-ai',
      version: '1.0.0',
      sha256: 'aa'.repeat(32),
      installMethod: 'copy',
      installedAt: '2026-07-01T00:00:00.000Z',
      clientVersion: '1.3.0',
    });
    writeFileSync(path.join(fullTargetDir, 'legacy.txt'), 'old content');
    metaWriteControl.failNext = true;
    const svc = makeService(goodZip(), FULL_SLUG);

    await expect(svc.install({ slug: FULL_SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });

    expect(readFileSync(path.join(fullTargetDir, 'legacy.txt'), 'utf8')).toBe('old content');
    const kept = JSON.parse(readFileSync(skillMetaPath(fullTargetDir), 'utf8'));
    expect(kept.version).toBe('1.0.0');
    const stagingDirs = readdirSync(baseDir).filter((name) => name.includes('staging'));
    expect(stagingDirs).toEqual([]);
  });

  it('preserves staging on full slug rollback failure (disaster recovery)', async () => {
    const fullTargetDir = path.join(baseDir, 'pdf-extractor');
    mkdirSync(fullTargetDir);
    writeMetaFile(fullTargetDir, {
      schemaVersion: 1,
      slug: FULL_SLUG,
      provider: '@qianwen-ai',
      version: '1.0.0',
      sha256: 'aa'.repeat(32),
      installMethod: 'copy',
      installedAt: '2026-07-01T00:00:00.000Z',
      clientVersion: '1.3.0',
    });
    writeFileSync(path.join(fullTargetDir, 'legacy.txt'), 'old content');
    metaWriteControl.failNext = true;
    metaWriteControl.sabotageRollback = true;
    const svc = makeService(goodZip(), FULL_SLUG);

    const error = await svc.install({ slug: FULL_SLUG, baseDir }).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
      message: expect.stringContaining('Unexpected error while installing'),
    });

    const stagingDirs = readdirSync(baseDir).filter((name) => name.includes('staging'));
    expect(stagingDirs.length).toBe(1);
  });
});

describe('SkillsInstallService — TOCTOU guard', () => {
  it('rejects when an unmanaged directory appears during download (TOCTOU window)', async () => {
    // targetDir does NOT exist initially — assessSkillDir returns 'absent'
    const zip = goodZip();
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const hub = {
      getSkillDetail: async () => makeDetail(),
      getSkillDownload: async () => ({
        ossUrl: 'https://oss.test.qianwenai.com/pkg.zip',
        expiresAt: '',
        sha256,
      }),
    };
    // During the download, an external process creates an unmanaged directory
    const fetchImpl = (async () => {
      mkdirSync(targetDir);
      writeFileSync(path.join(targetDir, 'user-file.txt'), 'user data');
      return new Response(new Uint8Array(zip));
    }) as typeof fetch;
    const svc = new SkillsInstallService(hub as unknown as SkillsHubService, { fetchImpl });

    const error = await svc.install({ slug: SLUG, baseDir }).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'UNMANAGED_CONFLICT',
      exitCode: 1,
    });
    expect((error as { message: string }).message).toContain('appeared at');
    expect((error as { message: string }).message).toContain('not managed by this CLI');

    // The user directory remains untouched
    expect(existsSync(path.join(targetDir, 'user-file.txt'))).toBe(true);
    expect(readFileSync(path.join(targetDir, 'user-file.txt'), 'utf8')).toBe('user data');
  });

  it('proceeds normally when the existing directory is CLI-managed (update path)', async () => {
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
    writeFileSync(path.join(targetDir, 'SKILL.md'), '# Old');

    const svc = makeService(goodZip());
    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('updated');
    expect(existsSync(targetDir)).toBe(true);
  });

  it('rejects installMember when an unmanaged directory exists at targetDir', async () => {
    const memberTargetDir = path.join(baseDir, 'pdf-extractor');
    mkdirSync(memberTargetDir);
    writeFileSync(path.join(memberTargetDir, 'user-file.txt'), 'user data');

    const svc = makeService(goodZip(), FULL_SLUG);

    await expect(
      svc.installMember({
        provider: '@qianwen-ai',
        skillName: 'pdf-extractor',
        version: '1.2.0',
        zipBuffer: goodZip(),
        baseDir,
      }),
    ).rejects.toMatchObject({
      code: 'UNMANAGED_CONFLICT',
      exitCode: 1,
    });

    expect(existsSync(path.join(memberTargetDir, 'user-file.txt'))).toBe(true);
    expect(readFileSync(path.join(memberTargetDir, 'user-file.txt'), 'utf8')).toBe('user data');
  });
});
