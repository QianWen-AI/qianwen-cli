/**
 * Tests for SkillsHubService — SearchHub call contract, double-envelope
 * unwrapping, PascalCase/camelCase normalization, exact-slug hoisting (C-014),
 * the frozen output field mapping (TR §2.5), and the GetHubSkill /
 * GetHubSkillDownload contracts (securityStatus extraction, latest-version
 * resolution, NOT_FOUND CliError mapping).
 */
import { describe, it, expect } from 'vitest';
import {
  SkillsHubService,
  isVerifiedSecurityStatus,
  securityStatusLabel,
} from '../../../src/services/skills-hub-service.js';
import { GatewayBusinessError } from '../../../src/api/request-adapter.js';
import { CliError } from '../../../src/utils/errors.js';
import { site } from '../../../src/site.js';
import { makeMockApiClient } from '../../helpers/service-mocks.js';
import type {
  RawSearchHubEnvelope,
  RawSkillSearchItem,
  RawHubEnvelope,
  RawSkillDetailData,
  RawSkillDownloadData,
  RawPackDownloadData,
  PackManifest,
} from '../../../src/types/skills.js';

function okEnvelope(items: RawSkillSearchItem[], totalCount = items.length): RawSearchHubEnvelope {
  return {
    RequestId: 'req-1',
    Message: 'success',
    Code: '200',
    Success: true,
    Data: { TotalCount: totalCount, PageNo: 1, PageSize: 5, Items: items },
  };
}

function pascalItem(overrides: Partial<RawSkillSearchItem> = {}): RawSkillSearchItem {
  return {
    ResourceType: 'skill',
    ResourceId: 'res-1',
    ResourceName: 'pdf-extractor',
    DisplayName: 'PDF Extractor',
    Description: 'Extract text from PDFs',
    AuthorName: 'acme',
    SecurityDesc: '安全',
    SecurityStatus: 'safe',
    CurrentVersion: '1.2.0',
    Provider: { ProviderId: '@qianwen-ai', ProviderName: '千问 AI 平台', ProviderIcon: '' },
    ...overrides,
  };
}

function makeService(envelope: RawSearchHubEnvelope | null, capture?: { opts?: unknown }) {
  const api = makeMockApiClient({
    flat: async (opts) => {
      if (capture) capture.opts = opts;
      return envelope;
    },
  });
  return new SkillsHubService(api);
}

describe('SkillsHubService.searchSkills — call contract', () => {
  it('passes Query/ResourceTypes/PageNo/PageSize with authOptional to SearchHub', async () => {
    const capture: { opts?: unknown } = {};
    const svc = makeService(okEnvelope([pascalItem()]), capture);

    await svc.searchSkills({ query: 'pdf', limit: 10 });

    expect(capture.opts).toMatchObject({
      product: 'WebsitePortal',
      action: 'SearchHub',
      params: { Query: 'pdf', ResourceTypes: ['skill'], PageNo: 1, PageSize: 10 },
      authOptional: true,
    });
  });

  it('accepts an empty query and passes it through verbatim', async () => {
    const capture: { opts?: unknown } = {};
    const svc = makeService(okEnvelope([]), capture);

    const out = await svc.searchSkills({ query: '' });

    expect(capture.opts).toMatchObject({ params: { Query: '' } });
    expect(out.query).toBe('');
  });

  it('defaults limit to 5 when omitted', async () => {
    const capture: { opts?: unknown } = {};
    const svc = makeService(okEnvelope([]), capture);

    await svc.searchSkills({ query: 'x' });

    expect(capture.opts).toMatchObject({ params: { PageSize: 5 } });
  });
});

describe('SkillsHubService.searchSkills — normalization', () => {
  it('maps PascalCase fields to the frozen output shape', async () => {
    const svc = makeService(okEnvelope([pascalItem()], 42));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.totalCount).toBe(42);
    expect(out.results).toEqual([
      {
        slug: '@qianwen-ai/pdf-extractor',
        name: 'PDF Extractor',
        description: 'Extract text from PDFs',
        publisher: '千问 AI 平台',
        currentVersion: '1.2.0',
        verified: true,
      },
    ]);
  });

  it('falls back to camelCase field names (interface-doc spelling)', async () => {
    const svc = makeService({
      code: '200',
      success: true,
      data: {
        totalCount: 1,
        items: [
          {
            resourceName: 'camel-skill',
            displayName: 'Camel Skill',
            description: 'camel case payload',
            provider: { providerId: '@ns', providerName: 'Camel NS' },
            securityStatus: 'safe',
            currentVersion: '0.0.1',
          },
        ],
      },
    });

    const out = await svc.searchSkills({ query: 'camel' });

    expect(out.results[0]).toEqual({
      slug: '@ns/camel-skill',
      name: 'Camel Skill',
      description: 'camel case payload',
      publisher: 'Camel NS',
      currentVersion: '0.0.1',
      verified: true,
    });
  });

  it('falls back name to the bare ResourceName when DisplayName is missing', async () => {
    const svc = makeService(okEnvelope([pascalItem({ DisplayName: null })]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].name).toBe('pdf-extractor');
  });

  it('omits the currentVersion key (never null) when the server drops it', async () => {
    const svc = makeService(okEnvelope([pascalItem({ CurrentVersion: null })]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect('currentVersion' in out.results[0]).toBe(false);
  });

  it('derives verified from the machine securityStatus enum (C-017/C-022)', async () => {
    const svc = makeService(
      okEnvelope([
        pascalItem({ ResourceName: 'safe', SecurityStatus: 'safe' }),
        pascalItem({ ResourceName: 'risky', SecurityStatus: 'risk' }),
        pascalItem({ ResourceName: 'unknown', SecurityStatus: null }),
      ]),
    );

    const out = await svc.searchSkills({ query: 'x' });

    expect(out.results.map((r) => r.verified)).toEqual([true, false, false]);
  });

  it('ignores the display-only securityDesc wording for the verified verdict', async () => {
    const svc = makeService(
      okEnvelope([
        // Display text says safe, machine state says risk — machine state wins.
        pascalItem({ ResourceName: 'tricky', SecurityDesc: '安全', SecurityStatus: 'risk' }),
      ]),
    );

    const out = await svc.searchSkills({ query: 'x' });

    expect(out.results[0].verified).toBe(false);
  });

  it('returns an empty result set when Items is missing or empty', async () => {
    const svc = makeService({ Code: '200', Success: true, Data: { TotalCount: 0 } });

    const out = await svc.searchSkills({ query: 'nothing' });

    expect(out.results).toEqual([]);
    expect(out.totalCount).toBe(0);
  });
});

describe('SkillsHubService.searchSkills — exact slug hoisting (C-014)', () => {
  const items = [
    pascalItem({ ResourceName: 'alpha' }),
    pascalItem({ ResourceName: 'pdf' }),
    pascalItem({ ResourceName: 'beta' }),
  ];

  it('hoists the exact slug match to the front, preserving relative order', async () => {
    const svc = makeService(okEnvelope(items));

    const out = await svc.searchSkills({ query: '@qianwen-ai/pdf' });

    expect(out.results.map((r) => r.slug)).toEqual([
      '@qianwen-ai/pdf',
      '@qianwen-ai/alpha',
      '@qianwen-ai/beta',
    ]);
  });

  it('is case-sensitive: "@qianwen-ai/PDF" does not hoist slug "@qianwen-ai/pdf"', async () => {
    const svc = makeService(okEnvelope(items));

    const out = await svc.searchSkills({ query: '@qianwen-ai/PDF' });

    expect(out.results.map((r) => r.slug)).toEqual([
      '@qianwen-ai/alpha',
      '@qianwen-ai/pdf',
      '@qianwen-ai/beta',
    ]);
  });

  it('hoists only the first match when multiple slugs are identical', async () => {
    const svc = makeService(
      okEnvelope([
        pascalItem({ ResourceName: 'other' }),
        pascalItem({ ResourceName: 'dup', Description: 'first dup' }),
        pascalItem({ ResourceName: 'dup', Description: 'second dup' }),
      ]),
    );

    const out = await svc.searchSkills({ query: '@qianwen-ai/dup' });

    expect(out.results.map((r) => r.slug)).toEqual([
      '@qianwen-ai/dup',
      '@qianwen-ai/other',
      '@qianwen-ai/dup',
    ]);
    expect(out.results[0].description).toBe('first dup');
  });

  it('keeps order untouched when the match is already first', async () => {
    const svc = makeService(okEnvelope(items));

    const out = await svc.searchSkills({ query: '@qianwen-ai/alpha' });

    expect(out.results.map((r) => r.slug)).toEqual([
      '@qianwen-ai/alpha',
      '@qianwen-ai/pdf',
      '@qianwen-ai/beta',
    ]);
  });
});

describe('SkillsHubService.searchSkills — inner envelope failures', () => {
  it('throws GatewayBusinessError with the server message on business failure', async () => {
    const svc = makeService({
      Code: '403',
      Success: false,
      Message: 'blocked by policy',
    });

    await expect(svc.searchSkills({ query: 'x' })).rejects.toMatchObject({
      name: 'GatewayBusinessError',
      code: '403',
      message: 'blocked by policy',
    });
  });

  it('throws GatewayBusinessError on an empty (null) inner envelope', async () => {
    const svc = makeService(null);

    await expect(svc.searchSkills({ query: 'x' })).rejects.toBeInstanceOf(GatewayBusinessError);
  });
});

describe('isVerifiedSecurityStatus / securityStatusLabel — machine enum (C-017/C-022)', () => {
  it('accepts only the safe state, case-normalized', () => {
    expect(isVerifiedSecurityStatus('safe')).toBe(true);
    expect(isVerifiedSecurityStatus('Safe')).toBe(true);
    expect(isVerifiedSecurityStatus('risk')).toBe(false);
    expect(isVerifiedSecurityStatus('')).toBe(false);
    expect(isVerifiedSecurityStatus(null)).toBe(false);
    expect(isVerifiedSecurityStatus(undefined)).toBe(false);
  });

  it('derives display labels from site.defaults.language', () => {
    const expectedSafe = site.defaults.language === 'zh-CN' ? '安全' : 'safe';
    const expectedRisk = site.defaults.language === 'zh-CN' ? '不安全' : 'risk';
    expect(securityStatusLabel('safe')).toBe(expectedSafe);
    expect(securityStatusLabel('risk')).toBe(expectedRisk);
  });

  it('falls back to the raw value for unknown states and "unknown" when empty', () => {
    expect(securityStatusLabel('pending-review')).toBe('pending-review');
    expect(securityStatusLabel('')).toBe('unknown');
    expect(securityStatusLabel(null)).toBe('unknown');
    expect(securityStatusLabel(undefined)).toBe('unknown');
  });
});

// ── GetHubSkill / GetHubSkillDownload ───────────────────────────────────

function hubEnvelope<TData>(data: TData): RawHubEnvelope<TData> {
  return { RequestId: 'req-1', Message: 'success', Code: '200', Success: true, Data: data };
}

function detailData(overrides: Partial<RawSkillDetailData> = {}): RawSkillDetailData {
  return {
    SkillName: 'pdf-extractor',
    DisplayName: 'PDF Extractor',
    Description: 'Extract text from PDFs',
    SecurityStatus: 'safe',
    Security: { AuditStatus: 'safe', AuditTime: '2026-06-30T10:00:00+08:00' },
    Versions: [
      { Version: '1.1.0', PublishedAt: '2026-06-20', Changelog: 'newer', IsLatest: true },
      { Version: '1.0.0', PublishedAt: '2026-05-10', Changelog: 'initial', IsLatest: false },
    ],
    ...overrides,
  };
}

function makeDetailService(envelope: unknown, capture?: { opts?: unknown }) {
  const api = makeMockApiClient({
    flat: async (opts) => {
      if (capture) capture.opts = opts;
      return envelope;
    },
  });
  return new SkillsHubService(api);
}

describe('SkillsHubService.getSkillDetail — call contract', () => {
  it('passes SkillName and Language with authOptional to GetHubSkill', async () => {
    const capture: { opts?: unknown } = {};
    const svc = makeDetailService(hubEnvelope(detailData()), capture);

    await svc.getSkillDetail('pdf-extractor');

    expect(capture.opts).toMatchObject({
      product: 'WebsitePortal',
      action: 'GetHubSkill',
      params: { SkillName: 'pdf-extractor', Language: site.defaults.language },
      authOptional: true,
    });
  });

  it('normalizes the detail payload including the top-level securityStatus', async () => {
    const svc = makeDetailService(hubEnvelope(detailData()));

    const out = await svc.getSkillDetail('pdf-extractor');

    expect(out).toEqual({
      slug: 'pdf-extractor',
      displayName: 'PDF Extractor',
      description: 'Extract text from PDFs',
      securityStatus: 'safe',
      auditStatus: 'safe',
      auditTime: '2026-06-30T10:00:00+08:00',
      latestVersion: '1.1.0',
      versions: [
        { version: '1.1.0', publishedAt: '2026-06-20', changelog: 'newer', isLatest: true },
        { version: '1.0.0', publishedAt: '2026-05-10', changelog: 'initial', isLatest: false },
      ],
      provider: '',
    });
  });

  it('tolerates camelCase field spellings', async () => {
    const svc = makeDetailService(
      hubEnvelope({
        skillName: 'camel-skill',
        securityStatus: 'risk',
        versions: [{ version: '0.1.0', isLatest: true }],
      }),
    );

    const out = await svc.getSkillDetail('camel-skill');

    expect(out.slug).toBe('camel-skill');
    expect(out.securityStatus).toBe('risk');
    expect(out.latestVersion).toBe('0.1.0');
  });

  it('falls back to the first version when none is flagged latest', async () => {
    const svc = makeDetailService(
      hubEnvelope(
        detailData({
          Versions: [
            { Version: '2.0.0', IsLatest: false },
            { Version: '1.0.0', IsLatest: false },
          ],
        }),
      ),
    );

    const out = await svc.getSkillDetail('pdf-extractor');

    expect(out.latestVersion).toBe('2.0.0');
  });

  it('returns an empty securityStatus when the server omits the field', async () => {
    const svc = makeDetailService(hubEnvelope(detailData({ SecurityStatus: null })));

    const out = await svc.getSkillDetail('pdf-extractor');

    expect(out.securityStatus).toBe('');
  });

  it('maps a NOT_FOUND business code to an actionable CliError with SKILL_NOT_FOUND code and exit 1', async () => {
    const svc = makeDetailService({
      Code: 'NOT_FOUND',
      Success: false,
      Message: 'Published Skill does not exist: nope',
    });

    await expect(svc.getSkillDetail('nope')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
      message: expect.stringContaining('Skill not found: nope'),
      exitCode: 1,
    });
    await expect(svc.getSkillDetail('nope')).rejects.toBeInstanceOf(CliError);
  });
});

describe('SkillsHubService.getSkillDownload — call contract', () => {
  const downloadData: RawSkillDownloadData = {
    OssUrl: 'https://oss.test.qianwenai.com/skill.zip?sig=abc',
    ExpiresAt: '2026-07-27T20:00:00+08:00',
  };

  it('passes SkillName and SkillVersion when a version is given', async () => {
    const capture: { opts?: unknown } = {};
    const svc = makeDetailService(hubEnvelope(downloadData), capture);

    await svc.getSkillDownload('pdf-extractor', '1.1.0');

    expect(capture.opts).toMatchObject({
      product: 'WebsitePortal',
      action: 'GetHubSkillDownload',
      params: { SkillName: 'pdf-extractor', SkillVersion: '1.1.0' },
      authOptional: true,
    });
  });

  it('omits SkillVersion entirely when no version is given', async () => {
    const capture: { opts?: { params?: Record<string, unknown> } } = {};
    const svc = makeDetailService(hubEnvelope(downloadData), capture);

    await svc.getSkillDownload('pdf-extractor');

    expect(capture.opts?.params).toEqual({ SkillName: 'pdf-extractor' });
  });

  it('normalizes OssUrl and ExpiresAt', async () => {
    const svc = makeDetailService(hubEnvelope(downloadData));

    const out = await svc.getSkillDownload('pdf-extractor');

    expect(out).toEqual({
      ossUrl: 'https://oss.test.qianwenai.com/skill.zip?sig=abc',
      expiresAt: '2026-07-27T20:00:00+08:00',
    });
  });

  it('normalizes Sha256 alongside OssUrl when the server returns it', async () => {
    const svc = makeDetailService(hubEnvelope({ ...downloadData, Sha256: 'AB'.repeat(32) }));

    const out = await svc.getSkillDownload('pdf-extractor');

    expect(out.sha256).toBe('AB'.repeat(32));
  });

  it('tolerates the camelCase sha256 spelling', async () => {
    const svc = makeDetailService(
      hubEnvelope({ ossUrl: 'https://oss.test.qianwenai.com/skill.zip', sha256: 'ab'.repeat(32) }),
    );

    const out = await svc.getSkillDownload('pdf-extractor');

    expect(out.sha256).toBe('ab'.repeat(32));
  });

  it('throws when the payload carries no download URL', async () => {
    const svc = makeDetailService(hubEnvelope({}));

    await expect(svc.getSkillDownload('pdf-extractor')).rejects.toBeInstanceOf(
      GatewayBusinessError,
    );
  });

  it('maps a NOT_FOUND business code to the same actionable CliError with SKILL_NOT_FOUND code and exit 1', async () => {
    const svc = makeDetailService({ Code: 'NOT_FOUND', Success: false, Message: 'missing' });

    await expect(svc.getSkillDownload('ghost')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
      message: expect.stringContaining('Skill not found: ghost'),
      exitCode: 1,
    });
  });
});

describe('SkillsHubService.searchSkills — Provider object normalization', () => {
  it('derives publisher from Provider.ProviderName (PascalCase)', async () => {
    const svc = makeService(okEnvelope([pascalItem()]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].publisher).toBe('千问 AI 平台');
  });

  it('tolerates the camelCase provider object spelling on a PascalCase item', async () => {
    const svc = makeService(
      okEnvelope([
        pascalItem({
          Provider: null,
          provider: { providerId: '@ns', providerName: 'Camel NS' },
        }),
      ]),
    );

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].publisher).toBe('Camel NS');
  });

  it('falls back to ProviderId when ProviderName is null', async () => {
    const svc = makeService(
      okEnvelope([pascalItem({ Provider: { ProviderId: '@qianwen-ai', ProviderName: null } })]),
    );

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].publisher).toBe('@qianwen-ai');
  });

  it('falls back to ProviderId when ProviderName is empty', async () => {
    const svc = makeService(
      okEnvelope([pascalItem({ Provider: { ProviderId: '@qianwen-ai', ProviderName: '' } })]),
    );

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].publisher).toBe('@qianwen-ai');
  });

  it('ignores the deprecated AuthorName field entirely', async () => {
    const svc = makeService(okEnvelope([pascalItem({ AuthorName: 'legacy-author' })]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].publisher).toBe('千问 AI 平台');
  });

  it('emits an empty publisher and a bare slug when the Provider object is missing', async () => {
    const svc = makeService(okEnvelope([pascalItem({ Provider: null })]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].publisher).toBe('');
    expect(out.results[0].slug).toBe('pdf-extractor');
  });

  it('composes the full slug from ProviderId and ResourceName', async () => {
    const svc = makeService(okEnvelope([pascalItem()]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].slug).toBe('@qianwen-ai/pdf-extractor');
  });

  it('keeps the bare ResourceName as slug when ProviderId is missing', async () => {
    const svc = makeService(okEnvelope([pascalItem({ Provider: { ProviderName: 'No Id' } })]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].slug).toBe('pdf-extractor');
  });

  it('maps RequiresApiKey=true into the result', async () => {
    const svc = makeService(okEnvelope([pascalItem({ RequiresApiKey: true })]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].requiresApiKey).toBe(true);
  });

  it('maps RequiresApiKey=false into the result as an explicit false', async () => {
    const svc = makeService(okEnvelope([pascalItem({ RequiresApiKey: false })]));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results[0].requiresApiKey).toBe(false);
  });

  it('omits the requiresApiKey key when the server drops the field or sends null', async () => {
    const missing = makeService(okEnvelope([pascalItem()]));
    const missingOut = await missing.searchSkills({ query: 'pdf' });
    expect('requiresApiKey' in missingOut.results[0]).toBe(false);

    const nullItem = makeService(okEnvelope([pascalItem({ RequiresApiKey: null })]));
    const nullOut = await nullItem.searchSkills({ query: 'pdf' });
    expect('requiresApiKey' in nullOut.results[0]).toBe(false);
  });
});

describe('SkillsHubService.searchSkills — exact slug hoisting with full slugs', () => {
  const items = [
    pascalItem({ ResourceName: 'alpha' }),
    pascalItem({ ResourceName: 'pdf' }),
    pascalItem({ ResourceName: 'beta' }),
  ];

  it('hoists an exact full-slug query match to the front', async () => {
    const svc = makeService(okEnvelope(items));

    const out = await svc.searchSkills({ query: '@qianwen-ai/pdf' });

    expect(out.results.map((r) => r.slug)).toEqual([
      '@qianwen-ai/pdf',
      '@qianwen-ai/alpha',
      '@qianwen-ai/beta',
    ]);
  });

  it('does not hoist a bare-name query against full-slug items', async () => {
    const svc = makeService(okEnvelope(items));

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results.map((r) => r.slug)).toEqual([
      '@qianwen-ai/alpha',
      '@qianwen-ai/pdf',
      '@qianwen-ai/beta',
    ]);
  });

  it('keeps legacy hoisting for items without a Provider object', async () => {
    const svc = makeService(
      okEnvelope([
        pascalItem({ ResourceName: 'alpha', Provider: null }),
        pascalItem({ ResourceName: 'pdf', Provider: null }),
        pascalItem({ ResourceName: 'beta', Provider: null }),
      ]),
    );

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results.map((r) => r.slug)).toEqual(['pdf', 'alpha', 'beta']);
  });
});

describe('SkillsHubService.getSkillDownload — Provider parameter', () => {
  const downloadData: RawSkillDownloadData = {
    OssUrl: 'https://oss.test.qianwenai.com/skill.zip?sig=abc',
    ExpiresAt: '2026-07-27T20:00:00+08:00',
  };

  it('passes Provider alongside SkillName and SkillVersion when all are given', async () => {
    const capture: { opts?: { params?: Record<string, unknown> } } = {};
    const svc = makeDetailService(hubEnvelope(downloadData), capture);

    await svc.getSkillDownload('pdf-extractor', '1.1.0', '@qianwen-ai');

    expect(capture.opts?.params).toEqual({
      SkillName: 'pdf-extractor',
      Provider: '@qianwen-ai',
      SkillVersion: '1.1.0',
    });
  });

  it('passes Provider without SkillVersion', async () => {
    const capture: { opts?: { params?: Record<string, unknown> } } = {};
    const svc = makeDetailService(hubEnvelope(downloadData), capture);

    await svc.getSkillDownload('pdf-extractor', undefined, '@qianwen-ai');

    expect(capture.opts?.params).toEqual({
      SkillName: 'pdf-extractor',
      Provider: '@qianwen-ai',
    });
  });

  it('omits Provider entirely in legacy bare-slug mode', async () => {
    const capture: { opts?: { params?: Record<string, unknown> } } = {};
    const svc = makeDetailService(hubEnvelope(downloadData), capture);

    await svc.getSkillDownload('pdf-extractor');

    expect(capture.opts?.params).toEqual({ SkillName: 'pdf-extractor' });
  });
});

describe('SkillsHubService.getSkillDetail — provider parameter', () => {
  it('does not send Provider when it is omitted (regression)', async () => {
    const capture: { opts?: { params?: Record<string, unknown> } } = {};
    const svc = makeDetailService(hubEnvelope(detailData()), capture);

    await svc.getSkillDetail('pdf-extractor');

    expect(capture.opts?.params).toEqual({
      SkillName: 'pdf-extractor',
      Language: site.defaults.language,
    });
  });

  it('passes Provider through when explicitly provided', async () => {
    const capture: { opts?: { params?: Record<string, unknown> } } = {};
    const svc = makeDetailService(hubEnvelope(detailData()), capture);

    await svc.getSkillDetail('pdf-extractor', '@qianwen-ai');

    expect(capture.opts?.params).toEqual({
      SkillName: 'pdf-extractor',
      Language: site.defaults.language,
      Provider: '@qianwen-ai',
    });
  });
});

// ── Pack collection actions (getPackDownload) ──

const manifestObj = (overrides: Partial<PackManifest> = {}): PackManifest => ({
  skills: [
    { skillName: 'skill-a', provider: '@qianwen-ai', version: '0.0.1' },
    { skillName: 'skill-b', provider: '@other-ns', version: '0.0.2' },
  ],
  packName: 'test-pack',
  displayName: 'Test Pack',
  summary: 'pack summary',
  skillsNames: ['skill-a', 'skill-b'],
  ...overrides,
});

function packDownloadEnvelope(
  manifest: unknown,
  overrides: Partial<RawPackDownloadData> = {},
): RawHubEnvelope<RawPackDownloadData> {
  return hubEnvelope({
    OssUrl: 'https://oss.test.qianwenai.com/pack.zip?Signature=abc',
    Sha256: 'ab'.repeat(32),
    ExpiresAt: '2026-09-09T20:00:00.347527135+08:00',
    Manifest: manifest as RawPackDownloadData['Manifest'],
    ...overrides,
  });
}

describe('SkillsHubService.getPackDownload — call contract', () => {
  it('passes only CollectionName with authOptional to HubSkillCollectionDownload', async () => {
    const capture: { opts?: { params?: Record<string, unknown> } } = {};
    const svc = makeDetailService(packDownloadEnvelope(manifestObj()), capture);

    await svc.getPackDownload('test-pack');

    expect(capture.opts).toMatchObject({
      product: 'WebsitePortal',
      action: 'HubSkillCollectionDownload',
      authOptional: true,
    });
    expect(capture.opts?.params).toEqual({ CollectionName: 'test-pack' });
  });
});

describe('SkillsHubService.getPackDownload — response parsing and error mapping', () => {
  it('returns ossUrl/sha256/expiresAt/manifest verbatim', async () => {
    const svc = makeDetailService(packDownloadEnvelope(manifestObj()));

    const out = await svc.getPackDownload('test-pack');

    expect(out).toEqual({
      ossUrl: 'https://oss.test.qianwenai.com/pack.zip?Signature=abc',
      sha256: 'ab'.repeat(32),
      expiresAt: '2026-09-09T20:00:00.347527135+08:00',
      manifest: manifestObj(),
    });
  });

  it('parses a JSON-string manifest into a pre-parsed object', async () => {
    const svc = makeDetailService(packDownloadEnvelope(JSON.stringify(manifestObj())));

    const out = await svc.getPackDownload('test-pack');

    expect(out.manifest).toEqual(manifestObj());
    expect(out.manifest.skills[0].version).toBe('0.0.1');
  });

  it('passes a pre-parsed object manifest through (POC §10.1)', async () => {
    const svc = makeDetailService(packDownloadEnvelope(manifestObj()));

    const out = await svc.getPackDownload('test-pack');

    expect(out.manifest.skills).toHaveLength(2);
    expect(out.manifest.packName).toBe('test-pack');
  });

  it('tolerates a legacy top-level type field in the manifest (pre 09-07 format)', async () => {
    const svc = makeDetailService(
      packDownloadEnvelope(JSON.stringify(manifestObj({ type: '千问AI平台技能市场技能包' }))),
    );

    const out = await svc.getPackDownload('test-pack');

    expect(out.manifest.type).toBe('千问AI平台技能市场技能包');
    expect(out.manifest.skills).toHaveLength(2);
  });

  it('throws PACK_EMPTY when manifest.skills is an empty array', async () => {
    const svc = makeDetailService(
      packDownloadEnvelope(JSON.stringify(manifestObj({ skills: [] }))),
    );

    await expect(svc.getPackDownload('test-pack')).rejects.toMatchObject({
      code: 'PACK_EMPTY',
      message: 'Skill pack is empty: test-pack.',
      exitCode: 1,
    });
  });

  it('throws PACK_EMPTY when manifest.skills is missing or null', async () => {
    const missing = makeDetailService(
      packDownloadEnvelope(JSON.stringify({ packName: 'test-pack', displayName: 'Test Pack' })),
    );
    await expect(missing.getPackDownload('test-pack')).rejects.toMatchObject({
      code: 'PACK_EMPTY',
    });

    const nullSkills = makeDetailService(
      packDownloadEnvelope(JSON.stringify({ packName: 'test-pack', skills: null })),
    );
    await expect(nullSkills.getPackDownload('test-pack')).rejects.toMatchObject({
      code: 'PACK_EMPTY',
    });
  });

  it('throws PACK_EMPTY instead of a raw SyntaxError on invalid JSON', async () => {
    const svc = makeDetailService(packDownloadEnvelope('{not json'));

    await expect(svc.getPackDownload('test-pack')).rejects.toMatchObject({ code: 'PACK_EMPTY' });
    await expect(svc.getPackDownload('test-pack')).rejects.toBeInstanceOf(CliError);
  });

  it('maps a NOT_FOUND business envelope to PACK_NOT_FOUND with exit code 1', async () => {
    const svc = makeDetailService({ Code: 'NOT_FOUND', Success: false, Message: 'missing' });

    await expect(svc.getPackDownload('ghost-pack')).rejects.toMatchObject({
      code: 'PACK_NOT_FOUND',
      message: 'Skill pack not found: ghost-pack.',
      exitCode: 1,
    });
    await expect(svc.getPackDownload('ghost-pack')).rejects.toBeInstanceOf(CliError);
  });
});
