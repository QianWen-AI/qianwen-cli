/**
 * Tests for SkillsPackService — pack-install orchestration: manifest member
 * normalization, local-state precheck (install/noop/change/unmanaged), the
 * confirmation contract (USER_CANCELLED), whole-pack download with the three
 * single re-fetch paths (expiry / 403 / SHA256 mismatch), serial member
 * installation via installMember, member-level error pass-through, summary
 * tri-state, staging cleanup and the signed-URL non-disclosure guarantee.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsPackService, USER_CANCELLED_CODE } from '../../src/services/skills-pack-service.js';
import type { SkillsHubService } from '../../src/services/skills-hub-service.js';
import type {
  SkillsInstallService,
  SkillMemberInstallOptions,
  SkillMemberInstallResult,
} from '../../src/services/skills-install-service.js';
import { writeSkillMeta } from '../../src/services/skills-state-manager.js';
import { CliError } from '../../src/utils/errors.js';
import type { SkillMetadataV1, PackDownload, PackManifest } from '../../src/types/skills.js';
import { buildZip } from '../fixtures/zip-builder.js';

const PACK = 'qianwen-pack';
const PROVIDER = '@qianwen-ai';
const OTHER_PROVIDER = '@other-provider';

const OSS_URL = 'https://oss.test.qianwenai.com/pack.zip?Signature=abc';

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const memberZip = (body = '# Skill') =>
  buildZip([{ path: 'SKILL.md', data: body, method: 8, useDataDescriptor: true }]);

function packZipOf(skillNames: string[]): Buffer {
  return buildZip([
    { path: 'manifest.json', data: '{}', method: 8 },
    ...skillNames.map((name) => ({
      path: `skills/${name}.zip`,
      data: memberZip(`# ${name}`),
      method: 8,
    })),
  ]);
}

function manifestOf(
  skills: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { PackName: PACK, DisplayName: 'Qianwen Official Pack', Skills: skills, ...extra };
}

function skillEntry(
  provider: string,
  skillName: string,
  version?: string,
): Record<string, unknown> {
  return {
    Provider: provider,
    SkillName: skillName,
    ...(version !== undefined ? { Version: version } : {}),
  };
}

function packDownloadOf(
  manifest: unknown,
  zip: Buffer,
  overrides: Partial<PackDownload> = {},
): PackDownload {
  return {
    ossUrl: OSS_URL,
    sha256: sha256Of(zip),
    expiresAt: '',
    manifest: manifest as PackManifest,
    ...overrides,
  };
}

function memberMeta(slug: string, version: string): SkillMetadataV1 {
  return {
    schemaVersion: 1,
    slug,
    version,
    sha256: 'aa'.repeat(32),
    installMethod: 'copy',
    installedAt: '2026-07-01T00:00:00.000Z',
    clientVersion: '1.3.0',
  };
}

function seedManaged(targetDir: string, slug: string, version: string): void {
  mkdirSync(targetDir, { recursive: true });
  writeSkillMeta(targetDir, memberMeta(slug, version));
}

// ── Mocks ────────────────────────────────────────────────────────────────────

interface HubState {
  calls: number;
  names: string[];
}

function makeHub(returns: PackDownload[]): { hub: SkillsHubService; state: HubState } {
  const state: HubState = { calls: 0, names: [] };
  const hub = {
    getPackDownload: async (name: string): Promise<PackDownload> => {
      state.names.push(name);
      const idx = Math.min(state.calls, returns.length - 1);
      state.calls += 1;
      return returns[idx];
    },
  };
  return { hub: hub as unknown as SkillsHubService, state };
}

type FetchHandler = (url: string) => Promise<Response>;

interface FetchState {
  calls: number;
  urls: string[];
}

function makeFetch(handlers: FetchHandler[]): { fetchImpl: typeof fetch; state: FetchState } {
  const state: FetchState = { calls: 0, urls: [] };
  const impl = async (input: unknown): Promise<Response> => {
    const url = String(input);
    state.urls.push(url);
    const idx = Math.min(state.calls, handlers.length - 1);
    state.calls += 1;
    return handlers[idx](url);
  };
  return { fetchImpl: impl as unknown as typeof fetch, state };
}

const respondWith =
  (buf: Buffer): FetchHandler =>
  async () =>
    new Response(new Uint8Array(buf));

const respond403: FetchHandler = async () => new Response('forbidden', { status: 403 });

const failNetwork: FetchHandler = async () => {
  throw new Error('connect ECONNREFUSED 192.0.2.1:443');
};

interface InstallState {
  calls: Array<{
    provider: string;
    skillName: string;
    version: string;
    zipBuffer: Buffer;
    baseDir: string;
  }>;
  failFor: Record<string, unknown>;
}

function makeInstallState(): InstallState {
  return { calls: [], failFor: {} };
}

function makeInstallService(state: InstallState): SkillsInstallService {
  const svc = {
    installMember: async (opts: SkillMemberInstallOptions): Promise<SkillMemberInstallResult> => {
      state.calls.push(opts);
      const failure = state.failFor[opts.skillName];
      if (failure !== undefined) throw failure;
      return {
        targetDir: path.join(opts.baseDir, opts.skillName),
        sha256: sha256Of(opts.zipBuffer),
      };
    },
  };
  return svc as unknown as SkillsInstallService;
}

// ── Harness ──────────────────────────────────────────────────────────────────

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'qianwen-pack-install-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function assertNoStagingLeftover(): void {
  const leftovers = readdirSync(baseDir).filter((name) => name.includes('staging'));
  expect(leftovers).toEqual([]);
}

interface Harness {
  svc: SkillsPackService;
  hub: HubState;
  fetches: FetchState;
  installState: InstallState;
}

function harness(
  downloads: PackDownload[],
  handlers: FetchHandler[],
  installState = makeInstallState(),
): Harness {
  const hub = makeHub(downloads);
  const fetch = makeFetch(handlers);
  const svc = new SkillsPackService(hub.hub, makeInstallService(installState), {
    fetchImpl: fetch.fetchImpl,
  });
  return { svc, hub: hub.state, fetches: fetch.state, installState };
}

/** Two absent members — the baseline happy path. */
function defaultHarness(): Harness {
  const manifest = manifestOf([
    skillEntry(PROVIDER, 'skill-a', '1.2.0'),
    skillEntry(PROVIDER, 'skill-b', '0.9.0'),
  ]);
  const zip = packZipOf(['skill-a', 'skill-b']);
  return harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);
}

// ── §2.1 Manifest fetch and member normalization ────────────────────────────

describe('SkillsPackService — manifest fetch and member normalization', () => {
  it('calls hubService.getPackDownload once with the pack name', async () => {
    const h = defaultHarness();

    await h.svc.installPack({ packName: PACK, baseDir });

    expect(h.hub.calls).toBe(1);
    expect(h.hub.names).toEqual([PACK]);
  });

  it('returns one item per manifest member (object manifest form)', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.fullSlug)).toEqual([
      `${PROVIDER}/skill-a`,
      `${PROVIDER}/skill-b`,
    ]);
  });

  it('reads camelCase member spellings (provider/skillName/version)', async () => {
    const manifest = {
      packName: PACK,
      displayName: 'Qianwen Official Pack',
      skills: [{ provider: PROVIDER, skillName: 'skill-a', version: '1.2.0' }],
    };
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0]).toMatchObject({
      fullSlug: `${PROVIDER}/skill-a`,
      outcome: 'installed',
      version: '1.2.0',
      targetDir: path.join(baseDir, 'skill-a'),
    });
  });

  it('tolerates the legacy top-level type field (pre 09-07 format)', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')], { type: '技能包' });
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0].outcome).toBe('installed');
  });

  it('throws PACK_EMPTY when manifest.skills is an empty array', async () => {
    const manifest = manifestOf([]);
    const zip = packZipOf([]);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toMatchObject({
      code: 'PACK_EMPTY',
      message: expect.stringContaining(PACK),
      exitCode: 1,
    });
    expect(h.fetches.calls).toBe(0);
  });

  it('throws PACK_EMPTY when manifest.skills is missing or null', async () => {
    const manifest = { PackName: PACK, DisplayName: 'Qianwen Official Pack' };
    const zip = packZipOf([]);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toMatchObject({
      code: 'PACK_EMPTY',
      exitCode: 1,
    });
  });

  it('returns a single missing-version member as a failed result item', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a')]);
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('failed');
    expect(result.summary).toEqual({ installed: 0, changed: 0, skipped: 0, failed: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      fullSlug: `${PROVIDER}/skill-a`,
      outcome: 'failed',
      error: {
        code: 'INSTALL_FAILED',
        message: `Skill '${PROVIDER}/skill-a' has invalid manifest data and was skipped.`,
      },
    });
    expect(h.fetches.calls).toBe(0);
    expect(h.installState.calls).toHaveLength(0);
  });

  it('reports a missing-version member as failed alongside a valid member', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-b'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('partial');
    expect(result.summary).toEqual({ installed: 1, changed: 0, skipped: 0, failed: 1 });
    expect(result.items[0]).toMatchObject({
      fullSlug: `${PROVIDER}/skill-a`,
      outcome: 'installed',
      version: '1.2.0',
    });
    expect(result.items[1]).toMatchObject({
      fullSlug: `${PROVIDER}/skill-b`,
      outcome: 'failed',
      error: {
        code: 'INSTALL_FAILED',
        message: `Skill '${PROVIDER}/skill-b' has invalid manifest data and was skipped.`,
      },
    });
  });

  it('returns all-failed result when every member lacks version', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a'), skillEntry(PROVIDER, 'skill-b')]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('failed');
    expect(result.summary).toEqual({ installed: 0, changed: 0, skipped: 0, failed: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      fullSlug: `${PROVIDER}/skill-a`,
      outcome: 'failed',
      error: { code: 'INSTALL_FAILED' },
    });
    expect(result.items[1]).toMatchObject({
      fullSlug: `${PROVIDER}/skill-b`,
      outcome: 'failed',
      error: { code: 'INSTALL_FAILED' },
    });
    expect(h.fetches.calls).toBe(0);
  });
});

// ── §2.1b Manifest member validation (malicious provider / skillName) ────────

describe('SkillsPackService — manifest member validation', () => {
  it.each([
    '../../../tmp',
    '@valid/../escape',
    '../../../../.ssh',
    'no-at-prefix',
    '@has.dot',
    '',
    '@' + 'a'.repeat(65),
  ])('reports members with malicious or invalid provider %j as failed', async (badProvider) => {
    const manifest = manifestOf([
      skillEntry(badProvider, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-b', '1.2.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].fullSlug).toBe(`${PROVIDER}/skill-b`);
    expect(result.items[0].outcome).toBe('installed');
    const expectedRawName = badProvider ? `${badProvider}/skill-a` : 'skill-a';
    expect(result.items[1]).toMatchObject({
      fullSlug: expectedRawName,
      outcome: 'failed',
      error: {
        code: 'INSTALL_FAILED',
        message: `Skill '${expectedRawName}' has invalid manifest data and was skipped.`,
      },
    });
  });

  it('returns all-failed result when all members have invalid providers', async () => {
    const manifest = manifestOf([
      skillEntry('../../../tmp', 'skill-a', '1.0.0'),
      skillEntry('no-at', 'skill-b', '1.0.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('failed');
    expect(result.summary).toEqual({ installed: 0, changed: 0, skipped: 0, failed: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      fullSlug: '../../../tmp/skill-a',
      outcome: 'failed',
      error: {
        code: 'INSTALL_FAILED',
        message: "Skill '../../../tmp/skill-a' has invalid manifest data and was skipped.",
      },
    });
    expect(result.items[1]).toMatchObject({
      fullSlug: 'no-at/skill-b',
      outcome: 'failed',
      error: {
        code: 'INSTALL_FAILED',
        message: "Skill 'no-at/skill-b' has invalid manifest data and was skipped.",
      },
    });
    expect(h.fetches.calls).toBe(0);
  });

  it('reports one valid + one invalid member as partial with the invalid one failed', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'valid-skill', '1.0.0'),
      skillEntry('no-at-prefix', 'bad-skill', '1.0.0'),
    ]);
    const zip = packZipOf(['valid-skill']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('partial');
    expect(result.summary).toEqual({ installed: 1, changed: 0, skipped: 0, failed: 1 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      fullSlug: `${PROVIDER}/valid-skill`,
      outcome: 'installed',
    });
    expect(result.items[1]).toMatchObject({
      fullSlug: 'no-at-prefix/bad-skill',
      outcome: 'failed',
      error: {
        code: 'INSTALL_FAILED',
        message: "Skill 'no-at-prefix/bad-skill' has invalid manifest data and was skipped.",
      },
    });
  });

  it('returns all-failed result when all members have invalid skillNames (all-rejected boundary)', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'has.dot', '1.0.0'),
      skillEntry(PROVIDER, '../escape', '1.0.0'),
    ]);
    const zip = packZipOf([]);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('failed');
    expect(result.summary).toEqual({ installed: 0, changed: 0, skipped: 0, failed: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      fullSlug: `${PROVIDER}/has.dot`,
      outcome: 'failed',
      error: { code: 'INSTALL_FAILED' },
    });
    expect(result.items[1]).toMatchObject({
      fullSlug: `${PROVIDER}/../escape`,
      outcome: 'failed',
      error: { code: 'INSTALL_FAILED' },
    });
    expect(h.fetches.calls).toBe(0);
  });

  it.each(['has.dot', '../escape', 'has space', '', 'a'.repeat(129)])(
    'reports members with invalid skillName %j as failed',
    async (badName) => {
      const manifest = manifestOf([
        skillEntry(PROVIDER, badName, '1.2.0'),
        skillEntry(PROVIDER, 'valid-skill', '1.2.0'),
      ]);
      const zip = packZipOf(['valid-skill']);
      const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

      const result = await h.svc.installPack({ packName: PACK, baseDir });

      expect(result.items).toHaveLength(2);
      expect(result.items[0].fullSlug).toBe(`${PROVIDER}/valid-skill`);
      expect(result.items[0].outcome).toBe('installed');
      const expectedRawName = badName ? `${PROVIDER}/${badName}` : PROVIDER;
      expect(result.items[1]).toMatchObject({
        fullSlug: expectedRawName,
        outcome: 'failed',
        error: {
          code: 'INSTALL_FAILED',
          message: `Skill '${expectedRawName}' has invalid manifest data and was skipped.`,
        },
      });
    },
  );
});

// ── §2.2 Precheck tri-state classification ──────────────────────────────────

describe('SkillsPackService — precheck tri-state classification', () => {
  it('classifies an absent member as installed with the flat target path', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0]).toMatchObject({
      outcome: 'installed',
      targetDir: path.join(baseDir, 'skill-a'),
    });
  });

  it('classifies an identical local version as noop and skips the install call', async () => {
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '1.2.0');
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0]).toMatchObject({ outcome: 'noop', version: '1.2.0' });
    expect(h.installState.calls.map((c) => c.skillName)).toEqual(['skill-b']);
  });

  it('classifies an older local version as changed and records previousVersion', async () => {
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '0.9.0');
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0]).toMatchObject({
      outcome: 'changed',
      version: '1.2.0',
      previousVersion: '0.9.0',
    });
  });

  it('classifies a newer local version (downgrade) as changed too (BR §2.3.4)', async () => {
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '2.0.0');
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0]).toMatchObject({
      outcome: 'changed',
      version: '1.2.0',
      previousVersion: '2.0.0',
    });
  });

  it('fails an unmanaged local directory with UNMANAGED_CONFLICT and keeps files', async () => {
    const target = path.join(baseDir, 'skill-a');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'SKILL.md'), 'not managed');
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0]).toMatchObject({
      outcome: 'failed',
      error: { code: 'UNMANAGED_CONFLICT' },
    });
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('not managed');
    expect(h.installState.calls.map((c) => c.skillName)).toEqual(['skill-b']);
  });

  it('installs members of mixed providers into independent flat paths', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(OTHER_PROVIDER, 'skill-b', '0.9.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items.map((i) => i.targetDir)).toEqual([
      path.join(baseDir, 'skill-a'),
      path.join(baseDir, 'skill-b'),
    ]);
  });

  it('completes an all-noop precheck before any download (no fetch, no hub re-fetch)', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '1.2.0');
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('success');
    expect(h.fetches.calls).toBe(0);
    expect(h.hub.calls).toBe(1);
    expect(h.installState.calls).toHaveLength(0);
  });

  it('skips download when all members are precheck-failed', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-b', '0.9.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    // Seed unmanaged directories to trigger UNMANAGED_CONFLICT for both
    const targetA = path.join(baseDir, 'skill-a');
    mkdirSync(targetA, { recursive: true });
    writeFileSync(path.join(targetA, 'SKILL.md'), 'unmanaged-a');
    const targetB = path.join(baseDir, 'skill-b');
    mkdirSync(targetB, { recursive: true });
    writeFileSync(path.join(targetB, 'SKILL.md'), 'unmanaged-b');
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('failed');
    expect(h.fetches.calls).toBe(0);
    expect(h.installState.calls).toHaveLength(0);
    expect(result.summary).toEqual({ installed: 0, changed: 0, skipped: 0, failed: 2 });
    expect(result.items[0]).toMatchObject({
      outcome: 'failed',
      error: { code: 'UNMANAGED_CONFLICT', message: expect.stringContaining('skill-a') },
    });
    expect(result.items[1]).toMatchObject({
      outcome: 'failed',
      error: { code: 'UNMANAGED_CONFLICT', message: expect.stringContaining('skill-b') },
    });
  });

  it('skips download when all members are noop or failed (mixed)', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-b', '0.9.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    // skill-a: noop (same version managed)
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '1.2.0');
    // skill-b: failed (unmanaged conflict)
    const targetB = path.join(baseDir, 'skill-b');
    mkdirSync(targetB, { recursive: true });
    writeFileSync(path.join(targetB, 'SKILL.md'), 'unmanaged-b');
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('partial');
    expect(h.fetches.calls).toBe(0);
    expect(h.installState.calls).toHaveLength(0);
    expect(result.summary).toEqual({ installed: 0, changed: 0, skipped: 1, failed: 1 });
    expect(result.items[0]).toMatchObject({ outcome: 'noop', version: '1.2.0' });
    expect(result.items[1]).toMatchObject({
      outcome: 'failed',
      error: { code: 'UNMANAGED_CONFLICT' },
    });
  });
});

// ── §2.3 Confirmation callback ───────────────────────────────────────────────

describe('SkillsPackService — confirmation callback', () => {
  it('calls onConfirm once with the precheck plan counts', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-b', '1.2.0'),
      skillEntry(PROVIDER, 'skill-c', '2.0.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b', 'skill-c']);
    seedManaged(path.join(baseDir, 'skill-b'), `${PROVIDER}/skill-b`, '0.9.0');
    seedManaged(path.join(baseDir, 'skill-c'), `${PROVIDER}/skill-c`, '2.0.0');
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);
    const confirmations: unknown[] = [];
    const onConfirm = async (plan: unknown): Promise<boolean> => {
      confirmations.push(plan);
      return true;
    };

    await h.svc.installPack({ packName: PACK, baseDir, onConfirm });

    expect(confirmations).toEqual([
      { install: 1, change: 1, noop: 1, failed: 0, override: 0, overrideMembers: [] },
    ]);
  });

  it('proceeds with download and install when onConfirm resolves true', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({
      packName: PACK,
      baseDir,
      onConfirm: async () => true,
    });

    expect(result.summary.installed).toBe(2);
    expect(h.fetches.calls).toBe(1);
  });

  it('throws USER_CANCELLED without download, install or local changes when declined', async () => {
    seedManaged(path.join(baseDir, 'skill-b'), `${PROVIDER}/skill-b`, '0.9.0');
    const h = defaultHarness();
    const before = readdirSync(baseDir).sort();

    await expect(
      h.svc.installPack({ packName: PACK, baseDir, onConfirm: async () => false }),
    ).rejects.toMatchObject({ code: USER_CANCELLED_CODE, exitCode: 0 });

    expect(h.fetches.calls).toBe(0);
    expect(h.installState.calls).toHaveLength(0);
    expect(readdirSync(baseDir).sort()).toEqual(before);
  });

  it('skips confirmation entirely when onConfirm is not provided', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.summary.installed).toBe(2);
  });

  it('never calls onConfirm when every member is noop', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '1.2.0');
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);
    let confirmCalls = 0;
    const onConfirm = async (): Promise<boolean> => {
      confirmCalls += 1;
      return true;
    };

    const result = await h.svc.installPack({ packName: PACK, baseDir, onConfirm });

    expect(result.overallStatus).toBe('success');
    expect(confirmCalls).toBe(0);
    expect(h.fetches.calls).toBe(0);
  });
});

// ── §2.4 Whole-pack download and SHA256 verification ────────────────────────

describe('SkillsPackService — whole-pack download and SHA256 verification', () => {
  it('downloads once and proceeds when SHA256 matches', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(h.fetches.calls).toBe(1);
    expect(result.summary.installed).toBe(2);
  });

  it('re-fetches a fresh URL once on SHA256 mismatch and succeeds on the second try', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const wrongSha = sha256Of(memberZip('wrong'));
    const h = harness(
      [
        packDownloadOf(manifest, zip, {
          sha256: wrongSha,
          ossUrl: 'https://oss.test.qianwenai.com/pack-a.zip',
        }),
        packDownloadOf(manifest, zip),
      ],
      [respondWith(zip), respondWith(zip)],
    );

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.summary.installed).toBe(1);
    expect(h.hub.calls).toBe(2);
    expect(h.fetches.calls).toBe(2);
    expect(h.fetches.urls).toEqual([
      'https://oss.test.qianwenai.com/pack-a.zip',
      'https://oss.test.qianwenai.com/pack.zip?Signature=abc',
    ]);
  });

  it('throws INSTALL_FAILED on a second SHA256 mismatch without staging leftovers', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const wrongSha = sha256Of(memberZip('wrong'));
    const h = harness(
      [
        packDownloadOf(manifest, zip, { sha256: wrongSha }),
        packDownloadOf(manifest, zip, { sha256: wrongSha }),
      ],
      [respondWith(zip), respondWith(zip)],
    );

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      message: expect.stringContaining('SHA256 mismatch'),
      exitCode: 1,
    });
    expect(h.hub.calls).toBe(2);
    expect(h.fetches.calls).toBe(2);
    assertNoStagingLeftover();
  });

  it('re-fetches once on HTTP 403 and succeeds with the new URL', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness(
      [
        packDownloadOf(manifest, zip, { ossUrl: 'https://oss.test.qianwenai.com/stale.zip' }),
        packDownloadOf(manifest, zip),
      ],
      [respond403, respondWith(zip)],
    );

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.summary.installed).toBe(1);
    expect(h.hub.calls).toBe(2);
    expect(h.fetches.urls).toEqual([
      'https://oss.test.qianwenai.com/stale.zip',
      'https://oss.test.qianwenai.com/pack.zip?Signature=abc',
    ]);
  });

  it('throws DOWNLOAD_FAILED when a re-fetched URL still returns 403 (T-4)', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness(
      [
        packDownloadOf(manifest, zip, { ossUrl: 'https://oss.test.qianwenai.com/a.zip' }),
        packDownloadOf(manifest, zip, { ossUrl: 'https://oss.test.qianwenai.com/b.zip' }),
      ],
      [respond403, respond403],
    );

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringContaining('Skill pack download failed'),
      exitCode: 1,
    });
    expect(h.hub.calls).toBe(2);
    assertNoStagingLeftover();
  });

  it('throws INSTALL_FAILED immediately when the server provides an empty SHA256 (no retry)', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip, { sha256: '' })], [respondWith(zip)]);

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      message: expect.stringContaining('did not provide a SHA256 checksum'),
      exitCode: 1,
    });
    expect(h.fetches.calls).toBe(0);
    expect(h.hub.calls).toBe(1);
    assertNoStagingLeftover();
  });

  it('throws INSTALL_FAILED for a whitespace-only SHA256 (no retry)', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip, { sha256: '   ' })], [respondWith(zip)]);

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      message: expect.stringContaining('did not provide a SHA256 checksum'),
    });
    expect(h.fetches.calls).toBe(0);
    assertNoStagingLeftover();
  });

  it('throws DOWNLOAD_FAILED on a network error', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip)], [failNetwork]);

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringContaining('Skill pack download failed'),
      exitCode: 1,
    });
    assertNoStagingLeftover();
  });

  it('refreshes an expired ExpiresAt URL before downloading and only fetches the new URL (B1)', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness(
      [
        packDownloadOf(manifest, zip, {
          ossUrl: 'https://oss.test.qianwenai.com/stale-pack.zip',
          expiresAt: '2020-01-01T00:00:00Z',
        }),
        packDownloadOf(manifest, zip, { expiresAt: '2999-01-01T00:00:00Z' }),
      ],
      [respondWith(zip)],
    );

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.summary.installed).toBe(1);
    expect(h.hub.calls).toBe(2);
    expect(h.fetches.calls).toBe(1);
    expect(h.fetches.urls).toEqual(['https://oss.test.qianwenai.com/pack.zip?Signature=abc']);
  });

  it('does not re-fetch when ExpiresAt is still in the future', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness(
      [packDownloadOf(manifest, zip, { expiresAt: '2999-01-01T00:00:00Z' })],
      [respondWith(zip)],
    );

    await h.svc.installPack({ packName: PACK, baseDir });

    expect(h.hub.calls).toBe(1);
  });

  it('parses nanosecond-precision ExpiresAt with a timezone offset as not expired', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness(
      [packDownloadOf(manifest, zip, { expiresAt: '2999-09-03T20:46:54.347527135+08:00' })],
      [respondWith(zip)],
    );

    await h.svc.installPack({ packName: PACK, baseDir });

    expect(h.hub.calls).toBe(1);
  });
});

// ── §2.5 Serial member installation and summary ─────────────────────────────

describe('SkillsPackService — serial member installation and summary', () => {
  it('installs members in manifest order', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-b', '1.2.0'),
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-c', '1.2.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b', 'skill-c']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    await h.svc.installPack({ packName: PACK, baseDir });

    expect(h.installState.calls.map((c) => c.skillName)).toEqual(['skill-b', 'skill-a', 'skill-c']);
  });

  it('skips noop members in the install calls', async () => {
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '1.2.0');
    const h = defaultHarness();

    await h.svc.installPack({ packName: PACK, baseDir });

    expect(h.installState.calls.map((c) => c.skillName)).toEqual(['skill-b']);
  });

  it('continues after a member-level failure and records the error', async () => {
    const h = defaultHarness();
    h.installState.failFor['skill-a'] = new CliError({
      code: 'DOWNLOAD_FAILED',
      message: 'Skill package download failed. Check your network and try again.',
      exitCode: 1,
    });

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0]).toMatchObject({
      outcome: 'failed',
      error: {
        code: 'DOWNLOAD_FAILED',
        message: 'Skill package download failed. Check your network and try again.',
      },
    });
    expect(result.items[1]).toMatchObject({ outcome: 'installed' });
    expect(h.installState.calls).toHaveLength(2);
  });

  it('fails a member whose entry is missing from the pack zip (INSTALL_FAILED generic)', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'missing', '1.2.0'),
    ]);
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[1]).toMatchObject({
      fullSlug: `${PROVIDER}/missing`,
      outcome: 'failed',
      error: {
        code: 'INSTALL_FAILED',
        message: expect.stringContaining('skills/missing.zip'),
      },
    });
    expect(result.items[0]).toMatchObject({ outcome: 'installed' });
  });

  it('maps a plain Error from installMember to INSTALL_FAILED generic', async () => {
    const h = defaultHarness();
    h.installState.failFor['skill-a'] = new Error('boom');

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0].error).toEqual({ code: 'INSTALL_FAILED', message: 'boom' });
  });

  it.each([
    {
      label: 'SKILL_NOT_FOUND',
      code: 'SKILL_NOT_FOUND',
      message:
        'Skill not found: @qianwen-ai/skill-a. Use skills search <keyword> to find available skills.',
    },
    {
      label: 'INSTALL_FAILED (SHA256 variant)',
      code: 'INSTALL_FAILED',
      message: "SHA256 mismatch for '@qianwen-ai/skill-a'. Existing files were not changed.",
    },
    {
      label: 'INSTALL_FAILED (SKILL.md variant)',
      code: 'INSTALL_FAILED',
      message: "Invalid Skill package for '@qianwen-ai/skill-a': SKILL.md was not found.",
    },
  ])('passes member-level error $label through verbatim (C2)', async ({ code, message }) => {
    const h = defaultHarness();
    h.installState.failFor['skill-a'] = new CliError({ code, message, exitCode: 1 });

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.items[0].error).toEqual({ code, message });
    expect(result.items[1]).toMatchObject({ outcome: 'installed' });
  });

  it('invokes onProgress once per member with ascending index', async () => {
    const h = defaultHarness();
    const progress: Array<{ slug: string; index: number; total: number }> = [];

    await h.svc.installPack({
      packName: PACK,
      baseDir,
      onProgress: (item, index, total) => progress.push({ slug: item.fullSlug, index, total }),
    });

    expect(progress).toEqual([
      { slug: `${PROVIDER}/skill-a`, index: 0, total: 2 },
      { slug: `${PROVIDER}/skill-b`, index: 1, total: 2 },
    ]);
  });

  it('invokes onProgress for noop members too (T-5)', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    seedManaged(path.join(baseDir, 'skill-a'), `${PROVIDER}/skill-a`, '1.2.0');
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);
    const progress: string[] = [];

    const result = await h.svc.installPack({
      packName: PACK,
      baseDir,
      onProgress: (item) => progress.push(item.fullSlug),
    });

    expect(result.items[0].outcome).toBe('noop');
    expect(progress).toEqual([`${PROVIDER}/skill-a`]);
  });

  it('summarizes counts that match the items one-to-one (failures excluded)', async () => {
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-b', '1.2.0'),
      skillEntry(PROVIDER, 'skill-c', '1.2.0'),
      skillEntry(PROVIDER, 'skill-d', '1.2.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b', 'skill-c', 'skill-d']);
    seedManaged(path.join(baseDir, 'skill-b'), `${PROVIDER}/skill-b`, '0.9.0');
    seedManaged(path.join(baseDir, 'skill-c'), `${PROVIDER}/skill-c`, '1.2.0');
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);
    h.installState.failFor['skill-d'] = new CliError({
      code: 'INSTALL_FAILED',
      message: 'nope',
      exitCode: 1,
    });

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.summary).toEqual({ installed: 1, changed: 1, skipped: 1, failed: 1 });
    expect(
      result.summary.installed +
        result.summary.changed +
        result.summary.skipped +
        result.summary.failed,
    ).toBe(result.items.length);
  });

  it('reports overallStatus success when nothing failed', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('success');
  });

  it('reports overallStatus partial when some members failed', async () => {
    const h = defaultHarness();
    h.installState.failFor['skill-a'] = new Error('boom');

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('partial');
  });

  it('reports overallStatus failed when every member failed', async () => {
    const h = defaultHarness();
    h.installState.failFor['skill-a'] = new Error('boom');
    h.installState.failFor['skill-b'] = new Error('boom');

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.overallStatus).toBe('failed');
    expect(result.summary).toEqual({ installed: 0, changed: 0, skipped: 0, failed: 2 });
  });

  it('returns pack/displayName/baseDir from the manifest and options', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.pack).toBe(PACK);
    expect(result.displayName).toBe('Qianwen Official Pack');
    expect(result.baseDir).toBe(baseDir);
  });

  it('falls back to the pack name when the manifest carries no display name', async () => {
    const manifest = { Skills: [skillEntry(PROVIDER, 'skill-a', '1.2.0')] };
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    expect(result.displayName).toBe(PACK);
  });
});

// ── §2.6 Staging cleanup ─────────────────────────────────────────────────────

describe('SkillsPackService — staging cleanup', () => {
  it('leaves no staging leftovers after a successful run', async () => {
    const h = defaultHarness();

    await h.svc.installPack({ packName: PACK, baseDir });

    assertNoStagingLeftover();
  });

  it('leaves no staging leftovers after a SHA256 verification failure', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const wrongSha = sha256Of(memberZip('wrong'));
    const h = harness(
      [
        packDownloadOf(manifest, zip, { sha256: wrongSha }),
        packDownloadOf(manifest, zip, { sha256: wrongSha }),
      ],
      [respondWith(zip), respondWith(zip)],
    );

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toBeTruthy();
    assertNoStagingLeftover();
  });

  it('leaves no staging leftovers after member-level failures', async () => {
    const h = defaultHarness();
    h.installState.failFor['skill-a'] = new Error('boom');

    await h.svc.installPack({ packName: PACK, baseDir });

    assertNoStagingLeftover();
  });

  it('leaves no staging leftovers after USER_CANCELLED', async () => {
    const h = defaultHarness();

    await expect(
      h.svc.installPack({ packName: PACK, baseDir, onConfirm: async () => false }),
    ).rejects.toMatchObject({ code: USER_CANCELLED_CODE });
    assertNoStagingLeftover();
  });

  it('leaves no staging leftovers after a download failure', async () => {
    const manifest = manifestOf([skillEntry(PROVIDER, 'skill-a', '1.2.0')]);
    const zip = packZipOf(['skill-a']);
    const h = harness([packDownloadOf(manifest, zip)], [failNetwork]);

    await expect(h.svc.installPack({ packName: PACK, baseDir })).rejects.toBeTruthy();
    assertNoStagingLeftover();
  });
});

// ── §2.7 Signed URL non-disclosure ──────────────────────────────────────────

describe('SkillsPackService — signed URL non-disclosure', () => {
  it('never includes the OSS URL in the serialized result', async () => {
    const h = defaultHarness();

    const result = await h.svc.installPack({ packName: PACK, baseDir });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('oss.test.qianwenai.com');
    expect(serialized).not.toContain('OssUrl');
    expect(serialized).not.toContain('Signature=');
  });

  it('never includes the OSS URL in error messages or stacks', async () => {
    const manifest = manifestOf([]);
    const zip = packZipOf([]);
    const h = harness(
      [
        packDownloadOf(manifest, zip, {
          ossUrl: 'https://oss.test.qianwenai.com/pack.zip?Signature=leak',
        }),
      ],
      [respondWith(zip)],
    );

    const error = await h.svc.installPack({ packName: PACK, baseDir }).catch((e: unknown) => e);

    const serialized = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    expect(serialized).not.toContain('oss.test.qianwenai.com');
    expect(serialized).not.toContain('Signature=');
  });
});

describe('SkillsPackService - slug conflict override (precheckMember)', () => {
  it('classifies a target dir with a different slug as changed with previousSlug', async () => {
    seedManaged(path.join(baseDir, 'skill-a'), `${OTHER_PROVIDER}/skill-a`, '0.5.0');
    const manifest = manifestOf([
      skillEntry(PROVIDER, 'skill-a', '1.2.0'),
      skillEntry(PROVIDER, 'skill-b', '0.9.0'),
    ]);
    const zip = packZipOf(['skill-a', 'skill-b']);
    const confirmations: unknown[] = [];
    const h = harness([packDownloadOf(manifest, zip)], [respondWith(zip)]);

    const result = await h.svc.installPack({
      packName: PACK,
      baseDir,
      onConfirm: async (plan) => {
        confirmations.push(plan);
        return true;
      },
    });

    expect(result.overallStatus).toBe('success');
    expect(result.items[0]).toMatchObject({
      fullSlug: `${PROVIDER}/skill-a`,
      outcome: 'changed',
      previousVersion: '0.5.0',
      previousSlug: `${OTHER_PROVIDER}/skill-a`,
    });
    const overrideCall = h.installState.calls.find((c) => c.skillName === 'skill-a');
    expect(overrideCall).toBeDefined();
    expect(confirmations[0]).toMatchObject({ override: 1 });
  });
});
