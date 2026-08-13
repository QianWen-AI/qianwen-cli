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
        slug: 'pdf-extractor',
        name: 'PDF Extractor',
        description: 'Extract text from PDFs',
        publisher: 'acme',
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
            authorName: 'camel',
            securityStatus: 'safe',
            currentVersion: '0.0.1',
          },
        ],
      },
    });

    const out = await svc.searchSkills({ query: 'camel' });

    expect(out.results[0]).toEqual({
      slug: 'camel-skill',
      name: 'Camel Skill',
      description: 'camel case payload',
      publisher: 'camel',
      currentVersion: '0.0.1',
      verified: true,
    });
  });

  it('falls back name to slug when DisplayName is missing', async () => {
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

    const out = await svc.searchSkills({ query: 'pdf' });

    expect(out.results.map((r) => r.slug)).toEqual(['pdf', 'alpha', 'beta']);
  });

  it('is case-sensitive: "PDF" does not hoist slug "pdf"', async () => {
    const svc = makeService(okEnvelope(items));

    const out = await svc.searchSkills({ query: 'PDF' });

    expect(out.results.map((r) => r.slug)).toEqual(['alpha', 'pdf', 'beta']);
  });

  it('hoists only the first match when multiple slugs are identical', async () => {
    const svc = makeService(
      okEnvelope([
        pascalItem({ ResourceName: 'other' }),
        pascalItem({ ResourceName: 'dup', Description: 'first dup' }),
        pascalItem({ ResourceName: 'dup', Description: 'second dup' }),
      ]),
    );

    const out = await svc.searchSkills({ query: 'dup' });

    expect(out.results.map((r) => r.slug)).toEqual(['dup', 'other', 'dup']);
    expect(out.results[0].description).toBe('first dup');
  });

  it('keeps order untouched when the match is already first', async () => {
    const svc = makeService(okEnvelope(items));

    const out = await svc.searchSkills({ query: 'alpha' });

    expect(out.results.map((r) => r.slug)).toEqual(['alpha', 'pdf', 'beta']);
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

  it('maps a NOT_FOUND business code to an actionable CliError', async () => {
    const svc = makeDetailService({
      Code: 'NOT_FOUND',
      Success: false,
      Message: 'Published Skill does not exist: nope',
    });

    await expect(svc.getSkillDetail('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('Skill not found: nope'),
    });
    await expect(svc.getSkillDetail('nope')).rejects.toBeInstanceOf(CliError);
  });
});

describe('SkillsHubService.getSkillDownload — call contract', () => {
  const downloadData: RawSkillDownloadData = {
    OssUrl: 'https://oss.test.qianwen.com/skill.zip?sig=abc',
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
      ossUrl: 'https://oss.test.qianwen.com/skill.zip?sig=abc',
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
      hubEnvelope({ ossUrl: 'https://oss.test.qianwen.com/skill.zip', sha256: 'ab'.repeat(32) }),
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

  it('maps a NOT_FOUND business code to the same actionable CliError', async () => {
    const svc = makeDetailService({ Code: 'NOT_FOUND', Success: false, Message: 'missing' });

    await expect(svc.getSkillDownload('ghost')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('Skill not found: ghost'),
    });
  });
});
