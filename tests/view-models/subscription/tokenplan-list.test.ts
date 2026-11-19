/**
 * Unit tests for buildTokenPlanListViewModel — covers the subscription
 * status → user-facing message mapping across the tri-state contract
 * (active / not_subscribed / unknown) for both editions.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildTokenPlanListViewModel } from '../../../src/view-models/subscription/tokenplan-list.js';
import { tokenPlanListFailureFor } from '../../../src/commands/subscription/tokenplan/list.js';
import { renderTextTokenPlanList } from '../../../src/output/text/tokenplan-list.js';
import type {
  TokenPlanListRow,
  TokenPlanListResult,
  TokenPlanListSection,
  TokenPlanCurrentPlanDetails,
} from '../../../src/types/tokenplan-catalog.js';
import type { TokenPlanEdition } from '../../../src/types/tokenplan-subscription.js';

function makeSection(
  edition: TokenPlanEdition,
  overrides: Partial<TokenPlanListSection> = {},
): TokenPlanListSection {
  return {
    edition,
    billingCycleSupported: true,
    subscriptionStatus: 'not_subscribed',
    currentPlan: null,
    currentBillingCycle: null,
    subscriptionUrl: null,
    rows: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<TokenPlanListResult> = {}): TokenPlanListResult {
  return {
    authenticated: true,
    edition: 'all',
    billingCycle: 'monthly',
    completeness: 'complete',
    sections: [makeSection('individual'), makeSection('team')],
    ...overrides,
  };
}

function makeIndividualRow(
  specCode: string,
  weeklyCredits?: number,
  monthlyCredits: string | number | null = null,
): TokenPlanListRow {
  return {
    type: `token_plan_individual_${specCode}`,
    specCode,
    seatType: null,
    name: specCode,
    price: '99',
    currency: 'CNY',
    inventory: true,
    ...(weeklyCredits === undefined ? {} : { weeklyCredits }),
    monthlyCredits,
    status: 'purchasable',
  };
}

describe('buildTokenPlanListViewModel — subscription copy', () => {
  it.each([true, false])('uses the updated guidance with authenticated=%s', (authenticated) => {
    const source = makeResult({ authenticated });
    const vm = buildTokenPlanListViewModel(source);
    const loginGuidance = [
      'You can view Token Plan prices without logging in.',
      'To view your subscription status and account-specific availability, run:',
      '  qianwen auth login',
    ].join('\n');
    if (authenticated) expect(vm.note).not.toContain(loginGuidance);
    else expect(vm.note).toContain(loginGuidance);
    expect(vm.note).toContain(
      'Your purchase status shown here is for reference only. Your eligibility will be verified again before purchase.',
    );
    expect(vm.note).not.toContain('Log in to also view');
    expect(vm.note).not.toContain('Availability shown here is for reference.');
    expect(vm.data).toEqual(source);
  });

  it('projects new fields explicitly, cleans output and preserves every legacy key and omission', () => {
    const section = makeSection('individual', {
      rows: [makeIndividualRow('lite', 0)],
      subscriptionStatus: 'active',
      currentPlan: 'lite',
    });
    const legacy = buildTokenPlanListViewModel(makeResult({ sections: [section] })).data;
    const source = {
      ...section,
      currentPlanDetails: {
        subscriptionId: 'fixture',
        endAt: '2027-01-01T00:00:00.000Z',
        totalCredits: '0',
        remainingCredits: null,
        privateField: 'must-not-project',
      },
      plans: [
        {
          tier: 'lite',
          billingTerm: 'monthly' as const,
          listPrice: '199',
          promoPrice: '99',
          currency: 'CNY' as const,
          quotaWindows: [{ windowType: 'weekly' as const, totalCredits: '0' }],
          supportedModels: [
            {
              modelId: 'fixture',
              modelBrand: '\u001b[31mQwen\u001b[0m',
              modelName: 'Name\nInjected',
              capabilities: ['TG'],
              isNew: true,
              badgeLabel: '\u001b[31m限时2折\u001b[0m',
              badgeDescription: '说明\n内容',
              privateField: 'must-not-project',
            },
          ],
          harnessAllowances: [
            {
              toolId: 'fixture',
              toolName: 'Tool',
              freeQuota: null,
              quotaUnit: null,
              discount: null,
              discountType: null,
              privateField: 'must-not-project',
            },
          ],
          privateField: 'must-not-project',
        },
      ],
    };
    const before = structuredClone(source);
    const vm = buildTokenPlanListViewModel(makeResult({ sections: [source] }));
    const projected = {
      ...vm.data,
      sections: vm.data.sections.map(
        ({ plans: _plans, currentPlanDetails: _details, ...old }) => old,
      ),
    };
    expect(projected).toEqual(legacy);
    expect(source).toEqual(before);
    expect(JSON.stringify(vm.data)).not.toContain('must-not-project');
    expect(vm.sections[0]!.subscriptionDetails.join('\n')).toContain(
      '2027-01-01 08:00:00 (Asia/Shanghai)',
    );
    expect(vm.sections[0]!.details[0]!.rows).toEqual([
      ['Qwen', 'fixture', '文本生成', 'New、限时2折'],
    ]);
    expect(vm.data.sections[0]!.plans![0]!.supportedModels![0]!.modelName).toBe('NameInjected');
    expect(vm.data.sections[0]!.plans![0]!.supportedModels![0]).toMatchObject({
      isNew: true,
      badgeLabel: '限时2折',
      badgeDescription: '说明内容',
    });
    expect(vm.sections[0]!.details).toHaveLength(1);
    expect(JSON.stringify(vm.data)).not.toContain('harnessAllowances');
  });

  it.each([
    ['TG', '文本生成'],
    ['ASR', '语音识别'],
    ['TTS', '语音合成'],
    ['IU', '图片理解'],
    ['VU', '视觉理解'],
    ['IG', '图片生成'],
    ['VG', '视频生成'],
    ['IP', '图片处理'],
    ['TR', '向量模型'],
    ['ME', '多模态向量'],
    ['RK', '排序模型'],
    ['AU', '音频理解'],
    ['OMNI', '全模态'],
    ['Reasoning', '推理模型'],
    ['QwQ', '推理模型'],
    ['Realtime-Text-to-Speech', '实时语音合成'],
    ['Realtime-Omni', '实时全模态'],
    ['Realtime-Voice-Replication', '实时语音复制'],
    ['Multimodal-Omni', '全模态'],
    ['Realtime-ASR', '实时语音识别'],
    ['Realtime-Audio-Translate', '实时语音翻译'],
    ['Realtime-Chatting', '实时对话'],
    ['unknown-capability', 'unknown-capability'],
  ])('displays capability %s as %s while retaining its JSON code', (capability, label) => {
    const source = makeResult({
      sections: [
        makeSection('individual', {
          plans: [
            {
              tier: 'pro',
              billingTerm: 'monthly',
              listPrice: null,
              promoPrice: null,
              currency: 'CNY',
              quotaWindows: [],
              supportedModels: [
                {
                  modelId: 'fixture',
                  modelBrand: 'Qwen',
                  modelName: 'Model',
                  capabilities: [capability],
                },
              ],
            },
          ],
        }),
      ],
    });
    const before = structuredClone(source);
    const vm = buildTokenPlanListViewModel(source);
    expect(vm.sections[0]!.details[0]!.rows).toEqual([['Qwen', 'fixture', label, '—']]);
    expect(vm.data).toEqual(before);
    expect(source).toEqual(before);
  });

  it('deduplicates translated aliases and retains unknown codes without mutating JSON', () => {
    const capabilities = [
      'TG',
      '',
      'Reasoning',
      'QwQ',
      'OMNI',
      'Multimodal-Omni',
      'custom',
      'custom',
      'constructor',
      '__proto__',
    ];
    const source = makeResult({
      sections: [
        makeSection('team', {
          plans: [
            {
              seatType: 'standard',
              billingTerm: 'monthly',
              listPrice: null,
              promoPrice: null,
              currency: 'CNY',
              quotaWindows: [],
              supportedModels: [
                { modelId: 'fixture', modelBrand: 'Qwen', modelName: 'Model', capabilities },
              ],
            },
          ],
        }),
      ],
    });
    const before = structuredClone(source);
    const vm = buildTokenPlanListViewModel(source);
    expect(vm.sections[0]!.details[0]!.rows[0]![2]).toBe(
      '文本生成、推理模型、全模态、custom、constructor、__proto__',
    );
    expect(vm.data).toEqual(before);
    expect(source).toEqual(before);
  });

  it.each([
    {
      metadata: { isNew: true, badgeLabel: '限时2折', badgeDescription: 'Tooltip only' },
      tag: 'New、限时2折',
    },
    { metadata: { isNew: false, badgeLabel: '限时5折' }, tag: '限时5折' },
    { metadata: { isNew: true }, tag: 'New' },
    { metadata: {}, tag: '—' },
    { metadata: { isNew: false, badgeLabel: '' }, tag: '—' },
    { metadata: { badgeDescription: 'Tooltip only' }, tag: '—' },
  ])('renders frontend badge combinations as $tag for both editions', ({ metadata, tag }) => {
    const source = makeResult({
      sections: (['individual', 'team'] as const).map((edition) =>
        makeSection(edition, {
          plans: [
            {
              billingTerm: 'monthly',
              listPrice: null,
              promoPrice: null,
              currency: 'CNY',
              quotaWindows: [],
              supportedModels: [
                {
                  modelId: 'fixture',
                  modelBrand: 'Qwen',
                  modelName: '显示名',
                  capabilities: ['TG'],
                  ...metadata,
                },
              ],
            },
          ],
        }),
      ),
    });
    const before = structuredClone(source);
    const vm = buildTokenPlanListViewModel(source);
    for (const section of vm.sections) {
      expect(section.details[0]!.headers).toEqual([
        'MODEL BRAND',
        'MODEL NAME',
        'CAPABILITIES',
        'TAG',
      ]);
      expect(section.details[0]!.rows).toEqual([['Qwen', 'fixture', '文本生成', tag]]);
    }
    expect(vm.data).toEqual(before);
    expect(source).toEqual(before);
  });

  it('renders optional expansion once per edition and distinguishes empty and failure', () => {
    const plan = {
      tier: 'lite',
      billingTerm: 'monthly' as const,
      listPrice: null,
      promoPrice: '99',
      currency: 'CNY' as const,
      quotaWindows: [],
      supportedModels: [],
    };
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [makeIndividualRow('lite'), makeIndividualRow('pro')],
            plans: [plan, { ...plan, tier: 'pro' }],
          }),
        ],
      }),
    );
    expect(vm.sections[0]!.details).toHaveLength(1);
    expect(vm.sections[0]!.details[0]!.emptyMessage).toBe('No supported models available.');
    const failed = buildTokenPlanListViewModel(
      makeResult({
        sections: [makeSection('individual', { plans: [{ ...plan, supportedModels: null }] })],
      }),
    );
    expect(failed.sections[0]!.details[0]!.emptyMessage).toContain('unavailable');
  });

  it('marks the default billing cycle without exposing a Team summary type', () => {
    const vm = buildTokenPlanListViewModel(makeResult(), { billingCycleDefaulted: true });

    expect(vm.billingCycleLabel).toBe('monthly (default)');
    expect(vm.sections.find((section) => section.edition === 'team')?.type).toBeNull();
  });

  it('uses the PRD error block for an unsupported Team billing cycle', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        billingCycle: 'quarterly',
        sections: [makeSection('team', { billingCycleSupported: false })],
      }),
    );

    expect(vm.sections[0]?.cycleNote).toBe(
      "Error: billing cycle 'quarterly' is not available for Team Token Plans.\n" +
        'Available billing cycles:\n' +
        '  monthly\n' +
        '  yearly',
    );
  });

  it('renders "No active Individual Token Plan subscription." when authenticated and not_subscribed', () => {
    const vm = buildTokenPlanListViewModel(makeResult());
    const individual = vm.sections.find((section) => section.edition === 'individual');
    expect(individual?.subscription).toBe('No active Individual Token Plan subscription.');
  });

  it('renders "No active Team Token Plan subscription." for the team edition when not_subscribed', () => {
    const vm = buildTokenPlanListViewModel(makeResult());
    const team = vm.sections.find((section) => section.edition === 'team');
    expect(team?.subscription).toBe('No active Team Token Plan subscription.');
    const teamOnly = buildTokenPlanListViewModel(
      makeResult({
        edition: 'team',
        billingCycle: 'yearly',
        sections: [makeSection('team')],
      }),
    );
    expect(teamOnly.note).toContain('--edition team --billing-cycle monthly');
    expect(teamOnly.note).not.toContain('quarterly');
  });

  it('renders the already-subscribed copy when subscriptionStatus is active', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'active',
            currentPlan: 'essential',
            subscriptionUrl: 'https://platform.qianwenai.com/home/analytics/token-plan/individual',
          }),
          makeSection('team', { subscriptionStatus: 'not_subscribed' }),
        ],
      }),
    );
    const individual = vm.sections.find((section) => section.edition === 'individual');
    expect(individual?.subscription).toBe(
      "You're already subscribed to an Individual Token Plan. Current plan: Essential",
    );
    expect(individual?.subscriptionDetails).toEqual([
      'View subscription: https://platform.qianwenai.com/home/analytics/token-plan/individual',
    ]);
  });

  it('restores the legacy status labels after the PRD quote columns without changing JSON', () => {
    const rows: TokenPlanListRow[] = [
      { ...makeIndividualRow('lite', 2500), status: 'unavailable' },
      { ...makeIndividualRow('essential', 5000), status: 'subscribed' },
      { ...makeIndividualRow('standard', 10000), status: 'upgrade' },
      { ...makeIndividualRow('pro', 40000), status: 'upgrade' },
      { ...makeIndividualRow('future', 40000), status: 'purchasable' },
      { ...makeIndividualRow('unknown', 40000), status: 'unknown' },
    ];
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'active',
            currentPlan: 'essential',
            currentBillingCycle: 'monthly',
            rows,
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.columns.at(-1)).toEqual({ key: 'status', header: 'Status' });
    expect(vm.sections[0]?.rows.map((row) => row.status)).toEqual([
      'not_subscribable',
      'current_plan',
      'upgrade_on_web',
      'upgrade_on_web',
      'purchasable',
      'unknown',
    ]);
    expect(vm.data.sections[0]?.rows).toEqual(rows);
    expect(vm.sections[0]?.diagnostics).toEqual([]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderTextTokenPlanList(vm);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('Status');
      for (const label of [
        'not_subscribable',
        'current_plan',
        'upgrade_on_web',
        'purchasable',
        'unknown',
      ])
        expect(output).toContain(label);
    } finally {
      log.mockRestore();
    }
  });

  it('does not report a service outage or reinterpret eligibility when browsing another billing cycle', () => {
    const rows: TokenPlanListRow[] = ['lite', 'essential', 'standard', 'pro'].map((specCode) => ({
      ...makeIndividualRow(specCode, 2500),
      status: 'unavailable',
    }));
    const vm = buildTokenPlanListViewModel(
      makeResult({
        billingCycle: 'yearly',
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'active',
            currentPlan: 'essential',
            currentBillingCycle: 'monthly',
            rows,
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.subscription).toContain('Current plan: Essential (monthly)');
    expect(vm.sections[0]?.rows.every((row) => row.billingCycle === 'yearly')).toBe(true);
    expect(vm.sections[0]?.diagnostics).toEqual([]);
    expect(vm.data.sections[0]?.rows).toEqual(rows);
  });

  it.each(['not_subscribed', 'unknown'] as const)(
    'retains legacy Team row statuses when the edition state is %s',
    (subscriptionStatus) => {
      const rows: TokenPlanListRow[] = (['purchasable', 'unavailable', 'unknown'] as const).map(
        (status, index) => ({
          ...makeIndividualRow(['standard', 'pro', 'max'][index]!, undefined, '1000'),
          seatType: ['standard', 'pro', 'max'][index]!,
          status,
        }),
      );
      const source = makeResult({
        edition: 'team',
        sections: [makeSection('team', { subscriptionStatus, rows })],
      });
      const before = structuredClone(source);
      const vm = buildTokenPlanListViewModel(source);
      expect(vm.sections[0]!.columns.at(-1)).toEqual({ key: 'status', header: 'Status' });
      expect(vm.sections[0]!.rows.map((row) => row.status)).toEqual([
        'purchasable',
        'unavailable',
        'unknown',
      ]);
      expect(vm.data.sections[0]!.rows).toEqual(rows);
      expect(source).toEqual(before);
    },
  );

  it('renders the team subscription as an edition-level state', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        edition: 'team',
        sections: [
          makeSection('team', {
            subscriptionStatus: 'active',
            subscriptionUrl: 'https://platform.qianwenai.com/home/analytics/token-plan/team',
            rows: [
              {
                type: 'token_plan_team',
                specCode: 'standard',
                seatType: 'standard',
                name: 'Standard Seat',
                price: '150',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '25000',
                status: 'subscribed',
              },
              {
                type: 'token_plan_team',
                specCode: 'pro',
                seatType: 'pro',
                name: 'Pro Seat',
                price: '550',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '100000',
                status: 'subscribed',
              },
              {
                type: 'token_plan_team',
                specCode: 'max',
                seatType: 'max',
                name: 'Max Seat',
                price: '1398',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '250000',
                status: 'subscribed',
              },
            ],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.subscription).toBe("You're already subscribed to a Team Token Plan.");
    expect(vm.sections[0]?.columns.map((column) => column.header)).not.toContain('Status');
    expect(vm.sections[0]?.rows.every((row) => !Object.hasOwn(row, 'status'))).toBe(true);
    expect(vm.data.sections[0]?.rows.every((row) => !Object.hasOwn(row, 'status'))).toBe(true);
    expect(vm.data.sections[0]?.rows[0]?.type).toBe('token_plan_team');
    expect(vm.sections[0]?.columns.slice(0, 2)).toEqual([
      { key: 'seatType', header: 'Seat Type' },
      { key: 'billingCycle', header: 'Billing Cycle' },
    ]);
    expect(vm.sections[0]?.rows.map((row) => row.seatType)).toEqual(['standard', 'pro', 'max']);
    expect(vm.data.sections[0]?.rows.map((row) => [row.seatType, row.name])).toEqual([
      ['standard', 'Standard Seat'],
      ['pro', 'Pro Seat'],
      ['max', 'Max Seat'],
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderTextTokenPlanList(vm);
      const output = log.mock.calls.flat().join('\n');
      expect(output).not.toContain('TYPE  token_plan_team');
      expect(output).toMatch(
        /Seat Type\s+Billing Cycle\s+List Price\s+Promo Price\s+Currency\s+Quota Window\s+Total Credits/,
      );
      expect(output).toMatch(/standard\s+monthly/);
      expect(output).toMatch(/pro\s+monthly/);
      expect(output).toMatch(/max\s+monthly/);
      expect(output).not.toContain('Status');
      expect(output.split('\nTo purchase a Token Plan, run:')[0]).not.toContain('token_plan_team');
    } finally {
      log.mockRestore();
    }
  });

  it('renders "Subscription status: unknown" only for a genuine unknown state', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', { subscriptionStatus: 'unknown' }),
          makeSection('team', { subscriptionStatus: 'not_subscribed' }),
        ],
      }),
    );
    const individual = vm.sections.find((section) => section.edition === 'individual');
    expect(individual?.subscription).toBe('Subscription status: unknown');
  });

  it('emits no subscription copy when the user is not authenticated', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        authenticated: false,
        sections: [
          makeSection('individual', {
            subscriptionStatus: 'not_subscribed',
            rows: [makeIndividualRow('lite', 2500)],
          }),
          makeSection('team', {
            subscriptionStatus: 'not_subscribed',
            rows: [
              {
                type: 'token_plan_team',
                specCode: 'standard',
                seatType: 'standard',
                name: 'Standard Seat',
                price: '150',
                currency: 'CNY',
                inventory: true,
                monthlyCredits: '25000',
                status: 'purchasable',
              },
            ],
          }),
        ],
      }),
    );
    expect(vm.sections[0]?.subscription).toBeNull();
    expect(vm.sections[0]?.columns[0]).toEqual({ key: 'tier', header: 'Tier' });
    expect(vm.sections[0]?.columns.some((column) => column.key === 'seatType')).toBe(false);
    expect(vm.sections[0]?.rows[0]?.tier).toBe('lite');
    expect(vm.data.sections[0]?.rows[0]?.type).toBe('token_plan_individual_lite');
    expect(vm.sections[1]?.columns.slice(0, 2)).toEqual([
      { key: 'seatType', header: 'Seat Type' },
      { key: 'billingCycle', header: 'Billing Cycle' },
    ]);
    expect(vm.sections[1]?.rows[0]).toMatchObject({
      seatType: 'standard',
    });
    expect(vm.note).toContain('You can view Token Plan prices without logging in.');
    expect(vm.note).toContain(
      'To view your subscription status and account-specific availability, run:',
    );
    expect(vm.note).toContain(
      'Your purchase status shown here is for reference only. Your eligibility will be verified again before purchase.',
    );
    expect(vm.note).not.toContain('Credits limits');
    expect(vm.note).toContain(
      '  qianwen subscription tokenplan purchase <individual-token-plan-type> --channel alipay --billing-cycle <cycle> --no-auto-renew',
    );
    expect(vm.note).toContain(
      '  qianwen subscription tokenplan purchase token_plan_team --channel alipay --billing-cycle <cycle> --standard-seat-count <n> --no-auto-renew',
    );
    expect(vm.note).toContain(
      "Run 'qianwen subscription tokenplan purchase --help' for available values and options.",
    );
    expect(vm.sections[0]?.rows[0]).toMatchObject({ quotaWindow: 'weekly', totalCredits: '2500' });
    expect(vm.sections[1]?.rows[0]).toMatchObject({
      quotaWindow: 'monthly',
      totalCredits: '25000',
    });
  });

  it('shows each personal quota window on its own row and leaves missing quotas unknown', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [makeIndividualRow('lite', 2500, '11500'), makeIndividualRow('standard')],
          }),
        ],
      }),
    );
    expect(
      vm.sections[0]?.rows.map((row) => [row.tier, row.quotaWindow, row.totalCredits]),
    ).toEqual([
      ['lite', 'weekly', '2500'],
      ['lite', 'monthly', '11500'],
      ['standard', '—', '—'],
    ]);
    expect(vm.data.sections[0]?.rows).toHaveLength(2);
  });

  it('flags a personal row that reports neither a weekly nor a monthly limit', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [makeIndividualRow('lite', undefined, '11500'), makeIndividualRow('standard')],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([
      'Standard credit limit is temporarily unavailable. Try again later.',
    ]);
  });

  it('does not surface a generic network error when visible catalog data is complete', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [
              makeIndividualRow('lite', 2500),
              makeIndividualRow('standard', 10000),
              makeIndividualRow('pro', 40000),
            ],
            diagnostics: [
              {
                api: 'internal/api/path',
                errorCode: 'NETWORK_ERROR',
                errorMessage: 'The service could not be reached. Check your network connection.',
              },
            ],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([]);
    expect(vm.data.sections[0]?.diagnostics).toEqual([
      {
        api: 'internal/api/path',
        errorCode: 'NETWORK_ERROR',
        errorMessage: 'The service could not be reached. Check your network connection.',
      },
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderTextTokenPlanList(vm);
      expect(log).not.toHaveBeenCalledWith(
        'The service could not be reached. Check your network connection.',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('uses a row-level degradation message for unavailable catalog fields', () => {
    const row = makeIndividualRow('pro', 10000);
    row.inventory = null;
    row.status = 'unknown';
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [row],
            diagnostics: [
              {
                api: 'CheckInventory/pro',
                errorCode: 'NETWORK_ERROR',
                errorMessage: 'The service could not be reached. Check your network connection.',
              },
            ],
          }),
        ],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([
      'Pro availability is temporarily unavailable. Try again later.',
    ]);
    expect(vm.sections[0]?.diagnostics.join(' ')).not.toContain('network');
    expect(vm.sections[0]?.columns.at(-1)).toEqual({ key: 'status', header: 'Status' });
    expect(vm.sections[0]?.rows[0]?.status).toBe('unknown');
    expect(vm.data.sections[0]?.rows[0]?.status).toBe('unknown');
  });

  it('adds a retry hint when a catalog is empty', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [makeSection('individual')],
      }),
    );

    expect(vm.sections[0]?.diagnostics).toEqual([
      'Individual Token Plan catalog is temporarily unavailable. Try again later.',
    ]);
  });
});

describe('Token Plan catalog display corrections', () => {
  it.each([
    { usedPct: 0, expected: 0 },
    { usedPct: 100, expected: 100 },
    { usedPct: 12.345, expected: 12.345 },
    { usedPct: null, expected: null },
    { usedPct: undefined, expected: null },
    { usedPct: -1, expected: null },
    { usedPct: 101, expected: null },
    { usedPct: Number.NaN, expected: null },
    { usedPct: Number.POSITIVE_INFINITY, expected: null },
  ])(
    'uses the native personal percentage without an amount fallback: %j',
    ({ usedPct, expected }) => {
      const currentPlanDetails: TokenPlanCurrentPlanDetails = {
        subscriptionId: 'fixture',
        endAt: null,
        totalCredits: '1000',
        remainingCredits: '900',
        usedPct,
        remainingPct: 75,
        quotaWindowType: 'weekly',
      };
      const before = structuredClone(currentPlanDetails);
      const vm = buildTokenPlanListViewModel(
        makeResult({
          sections: [
            makeSection('individual', { subscriptionStatus: 'active', currentPlanDetails }),
          ],
        }),
      );
      expect(vm.data.sections[0]?.currentPlanDetails).toEqual({
        subscriptionId: 'fixture',
        endAt: null,
        usedPct: expected,
        remainingPct: expected === null ? null : 100 - expected,
        quotaWindowType: 'weekly',
      });
      expect(currentPlanDetails).toEqual(before);
      expect(vm.sections[0]?.subscriptionDetails.join('\n')).not.toMatch(
        /Total Credits|Remaining Credits/,
      );
      if (expected === 12.345) {
        expect(vm.sections[0]?.subscriptionDetails).toContain(
          'Used (%): 12.35%; Remaining (%): 87.66% (weekly)',
        );
      }
    },
  );

  it.each([undefined, null, -1, 101, Number.NaN])(
    'keeps missing or invalid legacy personal percentages unknown (%s)',
    (remainingPct) => {
      const vm = buildTokenPlanListViewModel(
        makeResult({
          sections: [
            makeSection('individual', {
              subscriptionStatus: 'active',
              currentPlanDetails: {
                subscriptionId: null,
                endAt: null,
                totalCredits: '1000',
                remainingCredits: '750',
                remainingPct,
              },
            }),
          ],
        }),
      );
      expect(vm.data.sections[0]?.currentPlanDetails).toEqual({
        subscriptionId: null,
        endAt: null,
        usedPct: null,
        remainingPct: null,
      });
      expect(vm.sections[0]?.subscriptionDetails).toContain('Used (%): —; Remaining (%): —');
    },
  );

  it.each([
    { total: '1000', remaining: '1000' },
    { total: '1000', remaining: '0' },
    { total: '1000', remaining: '750' },
    { total: null, remaining: null },
  ])('omits Team current subscription amounts and percentages: %j', ({ total, remaining }) => {
    const currentPlanDetails: TokenPlanCurrentPlanDetails = {
      subscriptionId: null,
      endAt: null,
      totalCredits: total,
      remainingCredits: remaining,
      usedPct: 50,
      remainingPct: 50,
    };
    const before = structuredClone(currentPlanDetails);
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [makeSection('team', { subscriptionStatus: 'active', currentPlanDetails })],
      }),
    );
    expect(vm.data.sections[0]?.currentPlanDetails).toEqual({ subscriptionId: null, endAt: null });
    expect(currentPlanDetails).toEqual(before);
    expect(vm.sections[0]?.subscriptionDetails.join('\n')).not.toMatch(
      /Total Credits|Remaining Credits|Used \(%\)|Remaining \(%\)/,
    );
  });

  it('keeps absent/null subscription details and pricing Credits distinct in JSON', () => {
    const source = makeResult({
      sections: [
        makeSection('individual', { currentPlanDetails: null }),
        makeSection('team'),
        makeSection('individual', {
          subscriptionStatus: 'active',
          currentPlanDetails: {
            subscriptionId: 'fixture',
            endAt: null,
            totalCredits: '1000',
            remainingCredits: null,
            usedPct: 25,
          },
          plans: [
            {
              tier: 'lite',
              billingTerm: 'monthly',
              listPrice: '99',
              promoPrice: null,
              currency: 'CNY',
              quotaWindows: [{ windowType: 'weekly', totalCredits: '1000' }],
            },
          ],
        }),
      ],
    });
    const before = structuredClone(source);
    const data = buildTokenPlanListViewModel(source).data;
    expect(data.sections[0]?.currentPlanDetails).toBeNull();
    expect(data.sections[1]).not.toHaveProperty('currentPlanDetails');
    expect(data.sections[2]?.currentPlanDetails).not.toHaveProperty('totalCredits');
    expect(data.sections[2]?.currentPlanDetails).not.toHaveProperty('remainingCredits');
    expect(data.sections[2]?.plans?.[0]?.quotaWindows).toEqual([
      { windowType: 'weekly', totalCredits: '1000' },
    ]);
    expect(source).toEqual(before);
  });

  it.each(['individual', 'team'] as const)(
    'places the %s subscription link after its visible details and projects JSON',
    (edition) => {
      const subscriptionUrl = `https://console.test.qianwenai.com/home/analytics/token-plan/${edition}`;
      const currentPlanDetails = {
        subscriptionId: 'fixture-subscription',
        endAt: '2027-01-01T00:00:00.000Z',
        totalCredits: '1000',
        remainingCredits: '750',
        remainingPct: 75,
        quotaWindowType: 'monthly' as const,
      };
      const before = structuredClone(currentPlanDetails);
      const vm = buildTokenPlanListViewModel(
        makeResult({
          sections: [
            makeSection(edition, {
              subscriptionStatus: 'active',
              currentBillingCycle: 'monthly',
              subscriptionUrl,
              currentPlanDetails,
            }),
          ],
        }),
      );
      const details = vm.sections[0]!.subscriptionDetails;
      expect(details.at(-1)).toBe(`View subscription: ${subscriptionUrl}`);
      if (edition === 'individual') {
        expect(details.at(-2)).toBe('Used (%): 25%; Remaining (%): 75% (monthly)');
      } else {
        expect(details.at(-2)).toMatch(/^End At:/);
        expect(details.join('\n')).not.toMatch(/Used \(%\)|Remaining \(%\)/);
      }
      expect(details.slice(0, -1).join('\n')).toMatch(/Subscription ID:.*\nEnd At:/);
      expect(vm.data.sections[0]!.subscriptionUrl).toBe(subscriptionUrl);
      expect(vm.data.sections[0]!.currentPlanDetails).toEqual({
        subscriptionId: 'fixture-subscription',
        endAt: '2027-01-01T00:00:00.000Z',
        ...(edition === 'individual' ? { usedPct: 25, remainingPct: 75 } : {}),
        quotaWindowType: 'monthly',
      });
      expect(currentPlanDetails).toEqual(before);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        renderTextTokenPlanList(vm);
        const output = log.mock.calls.flat().join('\n');
        expect(output.indexOf('View subscription:')).toBeGreaterThan(output.indexOf('End At:'));
        expect(output).not.toMatch(/Total Credits:|Remaining Credits:/);
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each([0, 75, 100, null])(
    'shows the personal remaining percentage %s without an unknown Credits balance',
    (remainingPct) => {
      const vm = buildTokenPlanListViewModel(
        makeResult({
          sections: [
            makeSection('individual', {
              subscriptionStatus: 'active',
              currentPlan: 'lite',
              currentPlanDetails: {
                subscriptionId: 'fixture',
                endAt: null,
                totalCredits: '1000',
                remainingCredits: null,
                remainingPct,
                quotaWindowType: 'weekly',
              },
            }),
          ],
        }),
      );
      expect(vm.sections[0]!.subscriptionDetails).toContain(
        `Used (%): ${remainingPct === null ? '—' : `${100 - remainingPct}%`}; Remaining (%): ${remainingPct === null ? '—' : `${remainingPct}%`} (weekly)`,
      );
      expect(vm.data.sections[0]!.currentPlanDetails).not.toHaveProperty('totalCredits');
      expect(vm.data.sections[0]!.currentPlanDetails).not.toHaveProperty('remainingCredits');
      expect(vm.data.sections[0]!.currentPlanDetails?.remainingPct).toBe(remainingPct);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        renderTextTokenPlanList(vm);
        const output = log.mock.calls.flat().join('\n');
        expect(output).toContain('Remaining (%):');
        expect(output).not.toMatch(/Total Credits:|Remaining Credits|\x1b/);
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each(['individual', 'team'] as const)(
    'renders %s monthly Credits once while retaining JSON quota windows',
    (edition) => {
      const row = makeIndividualRow('standard', undefined, '1000');
      if (edition === 'team') {
        row.type = 'token_plan_team';
        row.seatType = 'standard';
      }
      const plan = {
        ...(edition === 'individual' ? { tier: 'standard' } : { seatType: 'standard' }),
        billingTerm: 'monthly' as const,
        listPrice: '199',
        promoPrice: '99',
        currency: 'CNY' as const,
        quotaWindows: [{ windowType: 'monthly' as const, totalCredits: '1000' }],
      };
      const vm = buildTokenPlanListViewModel(
        makeResult({ sections: [makeSection(edition, { rows: [row], plans: [plan] })] }),
      );
      const headers = vm.sections[0]!.columns.map((column) => column.header);
      expect(headers).toEqual([
        edition === 'individual' ? 'Tier' : 'Seat Type',
        'Billing Cycle',
        'List Price',
        'Promo Price',
        'Currency',
        'Quota Window',
        'Total Credits',
        'Status',
      ]);
      expect(vm.sections[0]!.rows[0]).toMatchObject({
        billingCycle: 'monthly',
        listPrice: '199.00',
        promoPrice: '99.00',
        currency: 'CNY',
        quotaWindow: 'monthly',
        totalCredits: '1000',
      });
      expect(vm.data.sections[0]!.plans?.[0]?.quotaWindows).toEqual(plan.quotaWindows);
    },
  );

  it.each([
    {
      edition: 'individual' as const,
      specCode: 'pro',
      listPrice: '100',
      promoPrice: '80',
      expectedPromo: '80.00',
    },
    {
      edition: 'team' as const,
      specCode: 'standard',
      listPrice: '150',
      promoPrice: null,
      expectedPromo: '—',
    },
    {
      edition: 'individual' as const,
      specCode: 'lite',
      listPrice: '0',
      promoPrice: '0',
      expectedPromo: '0.00',
    },
  ])(
    'matches the PRD quote example for $edition / $specCode',
    ({ edition, specCode, listPrice, promoPrice, expectedPromo }) => {
      const row = makeIndividualRow(specCode, undefined, '1000');
      if (edition === 'team') {
        row.type = 'token_plan_team';
        row.seatType = specCode;
      }
      const plan = {
        ...(edition === 'individual' ? { tier: specCode } : { seatType: specCode }),
        billingTerm: 'monthly' as const,
        listPrice,
        promoPrice,
        currency: 'CNY' as const,
        quotaWindows: [{ windowType: 'monthly' as const, totalCredits: '1000' }],
      };
      const result = makeResult({
        sections: [makeSection(edition, { rows: [row], plans: [plan] })],
      });
      const before = structuredClone(result);
      const vm = buildTokenPlanListViewModel(result);
      expect(vm.sections[0]!.rows[0]).toEqual({
        ...(edition === 'individual' ? { tier: specCode } : { seatType: specCode }),
        billingCycle: 'monthly',
        listPrice: `${listPrice}.00`,
        promoPrice: expectedPromo,
        currency: 'CNY',
        quotaWindow: 'monthly',
        totalCredits: '1000',
        status: 'purchasable',
      });
      expect(vm.data).toEqual(before);
      expect(result).toEqual(before);
    },
  );

  it('keeps all verified quota windows and their Credits paired in separate human rows', () => {
    const row = makeIndividualRow('pro', 1, '1');
    const plan = {
      tier: 'pro',
      billingTerm: 'yearly' as const,
      listPrice: '100',
      promoPrice: null,
      currency: 'CNY' as const,
      quotaWindows: [
        { windowType: 'weekly' as const, totalCredits: '1000' },
        { windowType: 'monthly' as const, totalCredits: '4000' },
      ],
    };
    const vm = buildTokenPlanListViewModel(
      makeResult({
        billingCycle: 'yearly',
        sections: [makeSection('individual', { rows: [row], plans: [plan] })],
      }),
    );
    expect(
      vm.sections[0]!.rows.map((entry) => [
        entry.tier,
        entry.billingCycle,
        entry.quotaWindow,
        entry.totalCredits,
      ]),
    ).toEqual([
      ['pro', 'yearly', 'weekly', '1000'],
      ['pro', 'yearly', 'monthly', '4000'],
    ]);
    expect(vm.sections[0]!.rows.every((entry) => entry.status === 'purchasable')).toBe(true);
    expect(vm.data.sections[0]!.rows).toHaveLength(1);
    expect(vm.data.sections[0]!.plans).toEqual([plan]);
  });

  it('uses verified personal quota windows for display without rewriting the legacy pricing quota', () => {
    const row = makeIndividualRow('lite', undefined, '1000');
    const plan = {
      tier: 'lite',
      billingTerm: 'monthly' as const,
      listPrice: '199',
      promoPrice: '99',
      currency: 'CNY' as const,
      quotaWindows: [{ windowType: 'monthly' as const, totalCredits: '4000' }],
    };
    const vm = buildTokenPlanListViewModel(
      makeResult({ sections: [makeSection('individual', { rows: [row], plans: [plan] })] }),
    );
    expect(vm.sections[0]!.rows[0]!.totalCredits).toBe('4000');
    expect(vm.data.sections[0]!.rows[0]!.monthlyCredits).toBe('1000');
    const missing = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', { rows: [row], plans: [{ ...plan, quotaWindows: [] }] }),
        ],
      }),
    );
    expect(missing.sections[0]!.rows[0]).toMatchObject({ quotaWindow: '—', totalCredits: '—' });
  });

  it('keeps a single Credits column for personal tiers with different quota windows', () => {
    const plans = (['weekly', 'monthly'] as const).map((windowType, index) => ({
      tier: index === 0 ? 'lite' : 'standard',
      billingTerm: 'monthly' as const,
      listPrice: '199',
      promoPrice: '99',
      currency: 'CNY' as const,
      quotaWindows: [{ windowType, totalCredits: '1000' }],
    }));
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('individual', {
            rows: [
              makeIndividualRow('lite', 1000),
              makeIndividualRow('standard', undefined, '1000'),
            ],
            plans,
          }),
        ],
      }),
    );
    expect(vm.sections[0]!.rows.map((row) => [row.quotaWindow, row.totalCredits])).toEqual([
      ['weekly', '1000'],
      ['monthly', '1000'],
    ]);
  });

  it('shows trusted Team end time while hiding its absent ID and quota details', () => {
    const vm = buildTokenPlanListViewModel(
      makeResult({
        sections: [
          makeSection('team', {
            subscriptionStatus: 'active',
            currentPlanDetails: {
              subscriptionId: null,
              endAt: '2027-01-01T00:00:00.000Z',
              totalCredits: '1000',
              remainingCredits: '0',
            },
          }),
        ],
      }),
    );
    expect(vm.sections[0]!.subscriptionDetails.join('\n')).not.toContain('Subscription ID');
    expect(vm.sections[0]!.subscriptionDetails.join('\n')).toMatch(/End At:.*2027.*Asia\/Shanghai/);
    expect(vm.sections[0]!.subscriptionDetails.join('\n')).not.toMatch(
      /Credits|Used \(%\)|Remaining \(%\)/,
    );
    expect(vm.data.sections[0]!.currentPlanDetails?.subscriptionId).toBeNull();
  });
});

describe('tokenPlanListFailureFor', () => {
  it('preserves protocol failures as configuration-class exit 4', () => {
    const error = tokenPlanListFailureFor(new Set(['PROTOCOL_ERROR']));
    expect(error.code).toBe('PROTOCOL_ERROR');
    expect(error.exitCode).toBe(4);
  });
});
