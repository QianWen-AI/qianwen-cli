/**
 * Tests for SkillsInstallService — orchestration of the install pipeline:
 * tri-state outcomes, deferred metadata write, staging cleanup, rollback on
 * failure and the unmanaged-conflict zero-change guarantee.
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
import { skillMetaPath, writeSkillMeta } from '../../../src/services/skills-state-manager.js';
import type { FullSlug } from '../../../src/utils/skills-security.js';
import type { SkillDetail, SkillMetadataV1 } from '../../../src/types/skills.js';
import { buildZip } from '../../fixtures/zip-builder.js';

const SLUG = 'pdf-extractor';
const NS = '@qianwen-ai';
const FULL_SLUG = `${NS}/${SLUG}`;

function makeDetail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    slug: SLUG,
    displayName: 'PDF Extractor',
    description: 'Extract text from PDFs',
    securityStatus: 'safe',
    auditStatus: 'safe',
    auditTime: '2026-07-01T00:00:00Z',
    latestVersion: '1.2.0',
    versions: [
      { version: '1.2.0', publishedAt: '', changelog: '', isLatest: true },
      { version: '1.0.0', publishedAt: '', changelog: '', isLatest: false },
    ],
    provider: '',
    ...overrides,
  };
}

interface HubCalls {
  detail: number;
  download: number;
  downloadArgs?: { skillName?: string; version?: string; provider?: string };
}

function makeHub(detail: SkillDetail, calls: HubCalls, downloadSha256?: string): SkillsHubService {
  const hub = {
    getSkillDetail: async () => {
      calls.detail += 1;
      return detail;
    },
    getSkillDownload: async (skillName?: string, version?: string, provider?: string) => {
      calls.download += 1;
      calls.downloadArgs = { skillName, version, provider };
      return {
        ossUrl: 'https://oss.test.qianwenai.com/pkg.zip',
        expiresAt: '',
        ...(downloadSha256 !== undefined ? { sha256: downloadSha256 } : {}),
      };
    },
  };
  return hub as unknown as SkillsHubService;
}

function makeFetch(zip: Buffer, counter: { count: number }): typeof fetch {
  const impl = async () => {
    counter.count += 1;
    return new Response(new Uint8Array(zip));
  };
  return impl as typeof fetch;
}

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function meta(overrides: Partial<SkillMetadataV1> = {}): SkillMetadataV1 {
  return {
    schemaVersion: 1,
    slug: SLUG,
    version: '1.2.0',
    sha256: 'aa'.repeat(32),
    installMethod: 'copy',
    installedAt: '2026-07-01T00:00:00.000Z',
    clientVersion: '1.3.0',
    ...overrides,
  };
}

/** No staging leftovers: only the expected names remain in the base dir. */
function assertNoStagingLeftover(baseDir: string): void {
  const leftovers = readdirSync(baseDir).filter((name) => name.includes('staging'));
  expect(leftovers).toEqual([]);
}

let baseDir: string;
let targetDir: string;
let calls: HubCalls;
let fetchCount: { count: number };

const goodZip = () =>
  buildZip([
    { path: 'SKILL.md', data: '# Skill', method: 8, useDataDescriptor: true },
    { path: 'scripts/run.js', data: 'console.log(1)', method: 8 },
  ]);

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'qianwen-install-'));
  targetDir = path.join(baseDir, SLUG);
  calls = { detail: 0, download: 0 };
  fetchCount = { count: 0 };
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeService(
  detail = makeDetail(),
  zip = goodZip(),
  // undefined → matching hash (happy path); null → server omits the field.
  downloadSha256?: string | null,
): SkillsInstallService {
  const sha256 = downloadSha256 === null ? undefined : (downloadSha256 ?? sha256Of(zip));
  return new SkillsInstallService(makeHub(detail, calls, sha256), {
    fetchImpl: makeFetch(zip, fetchCount),
  });
}

function fullSlugTarget(): string {
  return path.join(baseDir, SLUG);
}

describe('SkillsInstallService — fresh install', () => {
  it('deploys the content, records SHA256 and returns outcome installed', async () => {
    const zip = goodZip();
    const svc = makeService(makeDetail(), zip);

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result).toMatchObject({
      slug: SLUG,
      version: '1.2.0',
      outcome: 'installed',
      targetDir,
      securityStatus: 'safe',
      sha256: sha256Of(zip),
    });
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Skill');
    expect(readFileSync(path.join(targetDir, 'scripts', 'run.js'), 'utf8')).toBe('console.log(1)');

    const written = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(written).toMatchObject({
      schemaVersion: 1,
      slug: SLUG,
      version: '1.2.0',
      sha256: sha256Of(zip),
      installMethod: 'copy',
    });
    expect(typeof written.installedAt).toBe('string');
    expect(typeof written.clientVersion).toBe('string');
    assertNoStagingLeftover(baseDir);
  });

  it('fails with exit 1 when no published version exists', async () => {
    const svc = makeService(makeDetail({ latestVersion: '', versions: [] }));

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
    });
    expect(calls.download).toBe(0);
  });

  it('fails with exit 1 when the base directory does not exist', async () => {
    const svc = makeService();

    await expect(
      svc.install({ slug: SLUG, baseDir: path.join(baseDir, 'missing') }),
    ).rejects.toMatchObject({ code: 'INSTALL_FAILED', exitCode: 1 });
    expect(calls.detail).toBe(0);
  });
});

describe('SkillsInstallService — tri-state noop / updated', () => {
  it('returns noop for the same version without downloading or writing', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ version: '1.2.0' }));
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'existing');
    const before = readdirSync(targetDir).sort();
    const svc = makeService();

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('noop');
    // SHA256 echoes the recorded value; no download, zero write operations.
    expect(result.sha256).toBe('aa'.repeat(32));
    expect(calls.download).toBe(0);
    expect(fetchCount.count).toBe(0);
    expect(readdirSync(targetDir).sort()).toEqual(before);
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('existing');
  });

  it('replaces an older version and updates the metadata (outcome updated)', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ version: '1.0.0' }));
    writeFileSync(path.join(targetDir, 'legacy.txt'), 'old content');
    const zip = goodZip();
    const svc = makeService(makeDetail(), zip);

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('updated');
    expect(result.sha256).toBe(sha256Of(zip));
    // A regular upgrade never carries the downgrade marker.
    expect(result.downgrade).toBeUndefined();
    // Old content is fully replaced, not merged.
    expect(existsSync(path.join(targetDir, 'legacy.txt'))).toBe(false);
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Skill');
    const written = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(written.version).toBe('1.2.0');
    assertNoStagingLeftover(baseDir);
  });
});

describe('SkillsInstallService — downgrade warning marker', () => {
  it('carries downgrade { from, to } when the installed version is semver-newer', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ version: '2.0.0' }));
    const svc = makeService();

    const result = await svc.install({ slug: SLUG, baseDir });

    // The update itself proceeds unchanged — only the marker is added.
    expect(result.outcome).toBe('updated');
    expect(result.downgrade).toEqual({ from: '2.0.0', to: '1.2.0' });
    const written = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(written.version).toBe('1.2.0');
    assertNoStagingLeftover(baseDir);
  });

  it('stays silent when the installed version string is not semver-parsable', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ version: 'release-2026' }));
    const svc = makeService();

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('updated');
    expect(result.downgrade).toBeUndefined();
  });

  it('stays silent when the hub version string is not semver-parsable', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ version: '2.0.0' }));
    const svc = makeService(makeDetail({ latestVersion: 'nightly' }));

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('updated');
    expect(result.downgrade).toBeUndefined();
  });

  it('never marks a fresh install even for a semver hub version', async () => {
    const svc = makeService();

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('installed');
    expect(result.downgrade).toBeUndefined();
  });
});

describe('SkillsInstallService — unmanaged conflict (zero change)', () => {
  it('aborts before any download when the directory is not CLI-managed', async () => {
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, 'user-file.txt'), 'precious');
    const before = readdirSync(targetDir).sort();
    const svc = makeService();

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'UNMANAGED_CONFLICT',
      exitCode: 1,
    });
    expect(calls.download).toBe(0);
    expect(fetchCount.count).toBe(0);
    expect(readdirSync(targetDir).sort()).toEqual(before);
    expect(readFileSync(path.join(targetDir, 'user-file.txt'), 'utf8')).toBe('precious');
    assertNoStagingLeftover(baseDir);
  });

  it('suggests upgrading the CLI for a newer metadata schema', async () => {
    mkdirSync(targetDir);
    writeFileSync(skillMetaPath(targetDir), JSON.stringify({ ...meta(), schemaVersion: 99 }));
    const svc = makeService();

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'UNMANAGED_CONFLICT',
      message: expect.stringContaining('newer CLI version'),
    });
  });

  it('keeps the conflict message in English and mentions zero changes', async () => {
    mkdirSync(targetDir);
    const svc = makeService();

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      message: expect.stringContaining('No changes were made this time.'),
    });
  });
});

describe('SkillsInstallService — server-declared SHA256 verification', () => {
  it('installs when the server hash matches the locally computed one', async () => {
    const zip = goodZip();
    const svc = makeService(makeDetail(), zip, sha256Of(zip));

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('installed');
    expect(result.sha256).toBe(sha256Of(zip));
    expect(existsSync(skillMetaPath(targetDir))).toBe(true);
    assertNoStagingLeftover(baseDir);
  });

  it('matches case-insensitively and ignores surrounding whitespace', async () => {
    const zip = goodZip();
    const svc = makeService(makeDetail(), zip, `  ${sha256Of(zip).toUpperCase()} `);

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('installed');
    assertNoStagingLeftover(baseDir);
  });

  it('rejects a mismatch: zip removed, no deployment, no metadata', async () => {
    const svc = makeService(makeDetail(), goodZip(), 'ff'.repeat(32));

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
      message: expect.stringContaining('SHA256 mismatch'),
    });
    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      message: expect.stringContaining('Existing files were not changed.'),
    });
    // Nothing survives: no target, no metadata, no zip, no staging leftovers.
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it('fails when the server omits the hash: zip removed, nothing deployed', async () => {
    const svc = makeService(makeDetail(), goodZip(), null);

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
      message: expect.stringContaining('Download verification failed'),
    });
    // Nothing survives: no target, no metadata, no zip, no staging leftovers.
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it('treats a whitespace-only hash as missing and fails the same way', async () => {
    const svc = makeService(makeDetail(), goodZip(), '   ');

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
      message: expect.stringContaining('Download verification failed'),
    });
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(baseDir)).toEqual([]);
  });
});

describe('SkillsInstallService — failure cleanup and rollback', () => {
  it('cleans up staging and leaves no target on a failed download', async () => {
    const failingFetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
    const svc = new SkillsInstallService(makeHub(makeDetail(), calls), {
      fetchImpl: failingFetch,
    });

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      exitCode: 1,
    });
    expect(existsSync(targetDir)).toBe(false);
    assertNoStagingLeftover(baseDir);
  });

  it('reports a timeout distinctly when the download aborts', async () => {
    const abortingFetch = (async () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;
    const svc = new SkillsInstallService(makeHub(makeDetail(), calls), {
      fetchImpl: abortingFetch,
    });

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringContaining('timed out'),
    });
    assertNoStagingLeftover(baseDir);
  });

  it('refuses a malicious archive and leaves no partial deployment', async () => {
    const evilZip = buildZip([
      { path: 'ok.txt', data: 'fine' },
      { path: '../escape.txt', data: 'evil' },
    ]);
    const svc = makeService(makeDetail(), evilZip);

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      message: expect.stringContaining(`Refusing to install '${SLUG}'`),
    });
    // Deferred metadata write: nothing on disk, no target, no staging.
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it('keeps the previous version intact when an update fails mid-pipeline', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ version: '1.0.0' }));
    writeFileSync(path.join(targetDir, 'legacy.txt'), 'old content');
    const corruptZip = buildZip([{ path: 'x.txt', data: 'payload', crcOverride: 0xbad }]);
    const svc = makeService(makeDetail(), corruptZip);

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
    // Rollback: previous deployment and metadata untouched.
    expect(readFileSync(path.join(targetDir, 'legacy.txt'), 'utf8')).toBe('old content');
    const kept = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(kept.version).toBe('1.0.0');
    assertNoStagingLeftover(baseDir);
  });
});

describe('SkillsInstallService — SKILL.md existence check', () => {
  it('rejects a zip without SKILL.md on the single-install path', async () => {
    const noSkillMdZip = buildZip([{ path: 'scripts/run.js', data: 'console.log(1)', method: 8 }]);
    const svc = makeService(makeDetail(), noSkillMdZip);

    await expect(svc.install({ slug: SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
      message: expect.stringContaining('SKILL.md was not found'),
    });
    expect(existsSync(targetDir)).toBe(false);
    assertNoStagingLeftover(baseDir);
  });

  it('rejects a full-slug zip without SKILL.md on the single-install path', async () => {
    const noSkillMdZip = buildZip([{ path: 'scripts/run.js', data: 'console.log(1)', method: 8 }]);
    const svc = makeService(makeDetail(), noSkillMdZip);

    await expect(svc.install({ slug: FULL_SLUG, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      exitCode: 1,
      message: expect.stringContaining('SKILL.md was not found'),
    });
    expect(existsSync(fullSlugTarget())).toBe(false);
    assertNoStagingLeftover(baseDir);
  });

  it('accepts a zip containing SKILL.md on the single-install path', async () => {
    const svc = makeService();

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.outcome).toBe('installed');
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Skill');
  });
});

describe('SkillsInstallService — full-slug flat install path', () => {
  it('installs into baseDir/slug/ (flat, same as bare slug)', async () => {
    const svc = makeService();

    const result = await svc.install({ slug: FULL_SLUG, baseDir });

    expect(result.outcome).toBe('installed');
    expect(result.targetDir).toBe(fullSlugTarget());
    expect(readFileSync(path.join(fullSlugTarget(), 'SKILL.md'), 'utf8')).toBe('# Skill');
    expect(readFileSync(path.join(fullSlugTarget(), 'scripts', 'run.js'), 'utf8')).toBe(
      'console.log(1)',
    );
    assertNoStagingLeftover(baseDir);
  });

  it('writes metadata carrying the full slug and the provider field', async () => {
    const svc = makeService();

    await svc.install({ slug: FULL_SLUG, baseDir });

    const written = JSON.parse(readFileSync(skillMetaPath(fullSlugTarget()), 'utf8'));
    expect(written.slug).toBe(FULL_SLUG);
    expect(written.provider).toBe(NS);
    expect(written.schemaVersion).toBe(1);
  });

  it('requests the bare skill name plus provider from the hub download API', async () => {
    const svc = makeService();

    await svc.install({ slug: FULL_SLUG, baseDir });

    expect(calls.downloadArgs).toEqual({ skillName: SLUG, version: '1.2.0', provider: NS });
  });

  it('reuses a pre-parsed slug instead of re-parsing the raw input', async () => {
    const svc = makeService();
    const parsedSlug: FullSlug = { provider: NS, skillName: SLUG, raw: FULL_SLUG };

    const result = await svc.install({
      slug: '@wrong-ns/pdf-extractor',
      baseDir,
      parsedSlug,
    });

    expect(result.targetDir).toBe(fullSlugTarget());
    expect(calls.downloadArgs?.provider).toBe(NS);
  });

  it('echoes the full slug in the result', async () => {
    const svc = makeService();

    const result = await svc.install({ slug: FULL_SLUG, baseDir });

    expect(result.slug).toBe(FULL_SLUG);
  });
});

describe('SkillsInstallService — bare-slug regression (single-level path)', () => {
  it('keeps installing bare slugs into baseDir/slug/ when server has no provider', async () => {
    const svc = makeService();

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.slug).toBe(SLUG);
    expect(result.targetDir).toBe(path.join(baseDir, SLUG));
  });

  it('omits the provider key in metadata for bare-slug installs when server has no provider', async () => {
    const svc = makeService();

    await svc.install({ slug: SLUG, baseDir });

    const written = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect('provider' in written).toBe(false);
  });
});

describe('SkillsInstallService — bare-slug canonical full slug normalization', () => {
  it('canonicalizes bare slug to full slug when the server provides a provider', async () => {
    const zip = goodZip();
    const svc = makeService(makeDetail({ provider: NS }), zip);

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.slug).toBe(FULL_SLUG);
    expect(result.targetDir).toBe(path.join(baseDir, SLUG));
  });

  it('writes canonical full slug and provider in metadata when server provides provider', async () => {
    const zip = goodZip();
    const svc = makeService(makeDetail({ provider: NS }), zip);

    await svc.install({ slug: SLUG, baseDir });

    const written = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(written.slug).toBe(FULL_SLUG);
    expect(written.provider).toBe(NS);
  });

  it('preserves full slug from user input even when server returns a different provider', async () => {
    const zip = goodZip();
    const svc = makeService(makeDetail({ provider: '@other-provider' }), zip);

    const result = await svc.install({ slug: FULL_SLUG, baseDir });

    // User-provided provider takes precedence.
    expect(result.slug).toBe(FULL_SLUG);
  });

  it('falls back to bare slug when server has no provider and user provides bare slug', async () => {
    const svc = makeService();

    const result = await svc.install({ slug: SLUG, baseDir });

    expect(result.slug).toBe(SLUG);
  });
});

describe('SkillsInstallService — full-slug noop / updated', () => {
  it('returns noop for the same version at the flat path without downloading', async () => {
    mkdirSync(fullSlugTarget(), { recursive: true });
    writeSkillMeta(fullSlugTarget(), meta({ slug: FULL_SLUG, provider: NS, version: '1.2.0' }));
    writeFileSync(path.join(fullSlugTarget(), 'SKILL.md'), 'existing');
    const svc = makeService();

    const result = await svc.install({ slug: FULL_SLUG, baseDir });

    expect(result.outcome).toBe('noop');
    expect(result.slug).toBe(FULL_SLUG);
    expect(result.sha256).toBe('aa'.repeat(32));
    expect(calls.download).toBe(0);
    expect(fetchCount.count).toBe(0);
    expect(readFileSync(path.join(fullSlugTarget(), 'SKILL.md'), 'utf8')).toBe('existing');
  });

  it('replaces an older version at the flat path (outcome updated)', async () => {
    mkdirSync(fullSlugTarget(), { recursive: true });
    writeSkillMeta(fullSlugTarget(), meta({ slug: FULL_SLUG, provider: NS, version: '1.0.0' }));
    writeFileSync(path.join(fullSlugTarget(), 'legacy.txt'), 'old content');
    const svc = makeService();

    const result = await svc.install({ slug: FULL_SLUG, baseDir });

    expect(result.outcome).toBe('updated');
    expect(existsSync(path.join(fullSlugTarget(), 'legacy.txt'))).toBe(false);
    expect(readFileSync(path.join(fullSlugTarget(), 'SKILL.md'), 'utf8')).toBe('# Skill');
    const written = JSON.parse(readFileSync(skillMetaPath(fullSlugTarget()), 'utf8'));
    expect(written.version).toBe('1.2.0');
    assertNoStagingLeftover(baseDir);
  });
});

describe('SkillsInstallService — unmanaged conflict at the flat path', () => {
  it('aborts with UNMANAGED_CONFLICT before any download for an unmanaged full-slug directory', async () => {
    const target = fullSlugTarget();
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'user-file.txt'), 'precious');
    const svc = makeService();

    await expect(svc.install({ slug: FULL_SLUG, baseDir })).rejects.toMatchObject({
      code: 'UNMANAGED_CONFLICT',
      exitCode: 1,
    });

    expect(calls.download).toBe(0);
    expect(fetchCount.count).toBe(0);
    expect(readFileSync(path.join(target, 'user-file.txt'), 'utf8')).toBe('precious');
    assertNoStagingLeftover(baseDir);
  });
});

describe('SkillsInstallService — §10 slug conflict detection', () => {
  it('precheckSlugConflict returns null when the target directory is absent', () => {
    const svc = makeService();

    const conflict = svc.precheckSlugConflict(FULL_SLUG, baseDir);

    expect(conflict).toBeNull();
  });

  it('precheckSlugConflict returns null when the target directory has the same slug', () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ slug: FULL_SLUG, provider: NS }));
    const svc = makeService();

    const conflict = svc.precheckSlugConflict(FULL_SLUG, baseDir);

    expect(conflict).toBeNull();
  });

  it('precheckSlugConflict returns conflict info when target dir has a different slug', () => {
    mkdirSync(targetDir);
    writeSkillMeta(
      targetDir,
      meta({ slug: '@other/pdf-extractor', provider: '@other', version: '0.5.0' }),
    );
    const svc = makeService();

    const conflict = svc.precheckSlugConflict(FULL_SLUG, baseDir);

    expect(conflict).not.toBeNull();
    expect(conflict).toMatchObject({
      existingSlug: '@other/pdf-extractor',
      existingVersion: '0.5.0',
      targetDir,
    });
  });

  it('install() with allowSlugOverwrite succeeds and returns overwrite info', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(
      targetDir,
      meta({ slug: '@other/pdf-extractor', provider: '@other', version: '0.5.0' }),
    );
    const zip = goodZip();
    const svc = makeService(makeDetail(), zip);

    const result = await svc.install({ slug: FULL_SLUG, baseDir, allowSlugOverwrite: true });

    expect(result.outcome).toBe('installed');
    expect(result.overwritten).toBe(true);
    expect(result.previousSlug).toBe('@other/pdf-extractor');
    expect(result.previousVersion).toBe('0.5.0');
    expect(result.slug).toBe(FULL_SLUG);
    assertNoStagingLeftover(baseDir);
  });

  it('install() without allowSlugOverwrite throws SLUG_CONFLICT when conflict exists', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(
      targetDir,
      meta({ slug: '@other/pdf-extractor', provider: '@other', version: '0.5.0' }),
    );
    const svc = makeService();

    await expect(svc.install({ slug: FULL_SLUG, baseDir })).rejects.toMatchObject({
      code: 'SLUG_CONFLICT',
      exitCode: 1,
    });
    assertNoStagingLeftover(baseDir);
  });

  it('installMember() with allowSlugOverwrite succeeds when conflict exists', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(
      targetDir,
      meta({ slug: '@other/pdf-extractor', provider: '@other', version: '0.5.0' }),
    );
    const zip = goodZip();
    const svc = makeService(makeDetail(), zip);

    const result = await svc.installMember({
      provider: NS,
      skillName: SLUG,
      version: '1.2.0',
      zipBuffer: zip,
      baseDir,
      allowSlugOverwrite: true,
    });

    expect(result.targetDir).toBe(targetDir);
    assertNoStagingLeftover(baseDir);
  });

  it('installMember() without allowSlugOverwrite throws SLUG_CONFLICT when conflict exists', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(
      targetDir,
      meta({ slug: '@other/pdf-extractor', provider: '@other', version: '0.5.0' }),
    );
    const svc = makeService();

    await expect(
      svc.installMember({
        provider: NS,
        skillName: SLUG,
        version: '1.2.0',
        zipBuffer: goodZip(),
        baseDir,
      }),
    ).rejects.toMatchObject({
      code: 'SLUG_CONFLICT',
      exitCode: 1,
    });
    assertNoStagingLeftover(baseDir);
  });
});

describe('SkillsInstallService — bare-to-full slug upgrade equivalence', () => {
  it('precheckSlugConflict returns null when existing meta has bare slug and new install uses full slug', () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ slug: SLUG, version: '1.0.0' }));
    const svc = makeService();

    const conflict = svc.precheckSlugConflict(FULL_SLUG, baseDir);

    expect(conflict).toBeNull();
  });

  it('precheckSlugConflict returns null when existing meta has full slug and new install uses bare slug with server provider', () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ slug: FULL_SLUG, provider: NS, version: '1.0.0' }));
    const svc = makeService();

    const conflict = svc.precheckSlugConflict(SLUG, baseDir, NS);

    expect(conflict).toBeNull();
  });

  it('precheckSlugConflict still returns conflict for truly different skills sharing a directory name', () => {
    mkdirSync(targetDir);
    writeSkillMeta(
      targetDir,
      meta({ slug: '@other/totally-different', provider: '@other', version: '0.5.0' }),
    );
    const svc = makeService();

    const conflict = svc.precheckSlugConflict(FULL_SLUG, baseDir);

    expect(conflict).not.toBeNull();
    expect(conflict).toMatchObject({
      existingSlug: '@other/totally-different',
    });
  });

  it('install() upgrades bare slug meta to full slug (outcome updated, meta migrated)', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ slug: SLUG, version: '1.0.0' }));
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'old');
    const zip = goodZip();
    const svc = makeService(makeDetail({ provider: NS }), zip);

    const result = await svc.install({ slug: FULL_SLUG, baseDir });

    expect(result.outcome).toBe('updated');
    expect(result.slug).toBe(FULL_SLUG);
    expect(result.overwritten).toBeUndefined();
    // Meta should now carry the canonical full slug and provider.
    const written = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(written.slug).toBe(FULL_SLUG);
    expect(written.provider).toBe(NS);
    expect(written.version).toBe('1.2.0');
    assertNoStagingLeftover(baseDir);
  });

  it('install() returns noop when bare slug meta has the same version as the hub', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ slug: SLUG, version: '1.2.0' }));
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'existing');
    const svc = makeService(makeDetail({ provider: NS }));

    const result = await svc.install({ slug: FULL_SLUG, baseDir });

    // Same version but different slug form: noop because version matches.
    expect(result.outcome).toBe('noop');
    expect(calls.download).toBe(0);
  });

  it('installMember() succeeds without conflict when existing meta has bare slug', async () => {
    mkdirSync(targetDir);
    writeSkillMeta(targetDir, meta({ slug: SLUG, version: '1.0.0' }));
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'old');
    const zip = goodZip();
    const svc = makeService(makeDetail({ provider: NS }), zip);

    const result = await svc.installMember({
      provider: NS,
      skillName: SLUG,
      version: '1.2.0',
      zipBuffer: zip,
      baseDir,
    });

    expect(result.targetDir).toBe(targetDir);
    // Meta should be migrated to full slug.
    const written = JSON.parse(readFileSync(skillMetaPath(targetDir), 'utf8'));
    expect(written.slug).toBe(FULL_SLUG);
    expect(written.provider).toBe(NS);
    assertNoStagingLeftover(baseDir);
  });
});
