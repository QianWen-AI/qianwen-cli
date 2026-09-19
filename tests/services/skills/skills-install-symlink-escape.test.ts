/**
 * Symlink-escape defense for skills installation.
 *
 * Verifies that baseDir itself is allowed to be a symlink (dotfiles scenario)
 * and that full-slug installs land in flat paths.  Both install() and
 * installMember() paths are exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsInstallService } from '../../../src/services/skills-install-service.js';
import type { SkillsHubService } from '../../../src/services/skills-hub-service.js';
import { skillMetaPath } from '../../../src/services/skills-state-manager.js';
import type { SkillDetail } from '../../../src/types/skills.js';
import { buildZip } from '../../fixtures/zip-builder.js';

const SLUG = 'test-skill';
const NS = '@test-provider';
const FULL_SLUG = `${NS}/${SLUG}`;

function makeDetail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    slug: SLUG,
    displayName: 'Test Skill',
    description: 'A test skill',
    securityStatus: 'safe',
    auditStatus: 'safe',
    auditTime: '2026-07-01T00:00:00Z',
    latestVersion: '1.0.0',
    versions: [{ version: '1.0.0', publishedAt: '', changelog: '', isLatest: true }],
    provider: '',
    ...overrides,
  };
}

const goodZip = () =>
  buildZip([
    { path: 'SKILL.md', data: '# Skill', method: 8, useDataDescriptor: true },
    { path: 'run.js', data: 'console.log(1)', method: 8 },
  ]);

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface HubCalls {
  detail: number;
  download: number;
}

function makeHub(detail: SkillDetail, calls: HubCalls, downloadSha256?: string): SkillsHubService {
  const hub = {
    getSkillDetail: async () => {
      calls.detail += 1;
      return detail;
    },
    getSkillDownload: async () => {
      calls.download += 1;
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

/** Directories used across tests; cleaned up in afterEach. */
let realBase: string;
let outsideDir: string;

beforeEach(() => {
  realBase = mkdtempSync(path.join(tmpdir(), 'qw-symlink-base-'));
  outsideDir = mkdtempSync(path.join(tmpdir(), 'qw-symlink-outside-'));
});

afterEach(() => {
  rmSync(realBase, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function makeService(
  zip = goodZip(),
  detail = makeDetail(),
): { svc: SkillsInstallService; calls: HubCalls; fetchCount: { count: number } } {
  const calls: HubCalls = { detail: 0, download: 0 };
  const fetchCount = { count: 0 };
  const sha = sha256Of(zip);
  const svc = new SkillsInstallService(makeHub(detail, calls, sha), {
    fetchImpl: makeFetch(zip, fetchCount),
  });
  return { svc, calls, fetchCount };
}

function assertNothingWrittenOutside(): void {
  const entries = readdirSync(outsideDir);
  expect(entries).toEqual([]);
}

describe('Symlink escape — install() path', () => {
  it('allows baseDir itself to be a symlink (dotfiles scenario)', async () => {
    // symlinkedBase -> realBase (simulates ~/.qianwen being a symlink)
    const symlinkedBase = path.join(
      mkdtempSync(path.join(tmpdir(), 'qw-symlink-dotfiles-')),
      'link',
    );
    symlinkSync(realBase, symlinkedBase);

    const { svc } = makeService();

    const result = await svc.install({ slug: FULL_SLUG, baseDir: symlinkedBase });

    expect(result.outcome).toBe('installed');
    expect(result.targetDir).toBe(path.join(symlinkedBase, SLUG));
    expect(readFileSync(path.join(realBase, SLUG, 'SKILL.md'), 'utf8')).toBe('# Skill');

    // Cleanup the extra temp dir
    rmSync(path.dirname(symlinkedBase), { recursive: true, force: true });
  });

  it('allows bare-slug install without provider directory check', async () => {
    const { svc } = makeService();

    const result = await svc.install({ slug: SLUG, baseDir: realBase });

    expect(result.outcome).toBe('installed');
    expect(result.targetDir).toBe(path.join(realBase, SLUG));
    expect(readFileSync(path.join(realBase, SLUG, 'SKILL.md'), 'utf8')).toBe('# Skill');
  });

  it('allows normal full-slug install (flat)', async () => {
    const { svc } = makeService();

    const result = await svc.install({ slug: FULL_SLUG, baseDir: realBase });

    expect(result.outcome).toBe('installed');
    expect(result.targetDir).toBe(path.join(realBase, SLUG));
    expect(readFileSync(path.join(realBase, SLUG, 'SKILL.md'), 'utf8')).toBe('# Skill');
  });
});

describe('Symlink escape — installMember() path', () => {
  it('allows baseDir itself to be a symlink (dotfiles scenario)', async () => {
    const symlinkedBase = path.join(
      mkdtempSync(path.join(tmpdir(), 'qw-symlink-dotfiles-')),
      'link',
    );
    symlinkSync(realBase, symlinkedBase);

    const { svc } = makeService();

    const result = await svc.installMember({
      provider: NS,
      skillName: SLUG,
      version: '1.0.0',
      zipBuffer: goodZip(),
      baseDir: symlinkedBase,
    });

    expect(result.targetDir).toBe(path.join(symlinkedBase, SLUG));
    expect(readFileSync(path.join(realBase, SLUG, 'SKILL.md'), 'utf8')).toBe('# Skill');

    rmSync(path.dirname(symlinkedBase), { recursive: true, force: true });
  });

  it('allows normal member install (flat)', async () => {
    const { svc } = makeService();

    const result = await svc.installMember({
      provider: NS,
      skillName: SLUG,
      version: '1.0.0',
      zipBuffer: goodZip(),
      baseDir: realBase,
    });

    expect(result.targetDir).toBe(path.join(realBase, SLUG));
    expect(readFileSync(path.join(realBase, SLUG, 'SKILL.md'), 'utf8')).toBe('# Skill');
  });
});
