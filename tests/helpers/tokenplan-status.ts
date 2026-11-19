import type {
  TokenPlanEditionStatus,
  TokenPlanStatusResult,
} from '../../src/types/tokenplan-subscription.js';

export function tokenPlanStatusWithDetails(): TokenPlanStatusResult {
  const team = teamWithSeatDetails();
  team.seatSummaries = [
    {
      seatType: 'standard',
      seatCount: 2,
      assignedCount: 1,
      totalCredits: '50000',
      remainingCredits: '40000',
      remainingPct: 80,
      resetAt: null,
    },
  ];
  const names = [
    '图像生成 MCP',
    '代码解释器 MCP',
    '联网搜索增强版 MCP',
    '网页解析 MCP',
    '垂类搜索 MCP',
    '语音合成 MCP',
    '语音识别 MCP',
  ];
  return {
    individual: {
      edition: 'individual',
      commodityCode: 'sfm_tokenplansolo_public_cn',
      subscriptionId: 'fixture-personal',
      status: 'active',
      type: 'token_plan_individual_standard',
      name: 'Standard',
      specCode: 'standard',
      period: null,
      remainingDays: 29,
      autoRenew: null,
      seatSummary: null,
      completeness: 'complete',
      diagnostics: [],
      tiers: [
        {
          tier: 'standard',
          windowType: 'monthly',
          totalCredits: '45000',
          remainingCredits: null,
          usedPct: 0,
          remainingPct: 100,
          resetAt: null,
        },
      ],
      harnessAllowances: names.map((toolName) => ({
        toolId: 'official_tool',
        toolName,
        totalQuota: '100',
        remainingQuota: '90',
        quotaUnit: '次',
        startAt: null,
        endAt: null,
      })),
    },
    team,
    product: 'Token Plan',
    period: null,
    autoRenew: null,
    renewable: null,
    seatSummary: team.seatSummary,
    diagnostics: [],
  };
}

export function teamWithSeatDetails(): TokenPlanEditionStatus {
  return {
    edition: 'team',
    commodityCode: 'sfm_tokenplanteams_dp_cn',
    status: 'active',
    type: 'token_plan_team',
    name: 'Token Plan Team Edition',
    specCode: null,
    period: null,
    remainingDays: null,
    autoRenew: null,
    completeness: 'partial',
    diagnostics: [],
    seatSummary: {
      groups: [
        {
          specType: 'standard',
          seats: 2,
          assigned: 1,
          totalValue: '50000',
          surplusValue: '40000',
          unit: 'Credits',
          nextCycleFlushTime: null,
        },
        {
          specType: 'max',
          seats: 1,
          assigned: 1,
          totalValue: '250000',
          surplusValue: '200000',
          unit: 'Credits',
          nextCycleFlushTime: null,
        },
      ],
      total: { seats: 3, totalValue: '300000', surplusValue: '240000', unit: 'Credits' },
    },
    seatDetails: {
      fetchedCount: 3,
      totalCount: 3,
      historicalCount: 0,
      collectionCompleteness: 'complete',
      completeness: 'complete',
      diagnostics: [],
      items: [
        {
          instanceCode: 'subs-standard-0123456789abcdef',
          specType: 'standard',
          status: 'NORMAL',
          assignment: 'assigned',
          totalValue: '25000',
          surplusValue: '20000',
        },
        {
          instanceCode: 'subs-standard-02',
          specType: 'standard',
          status: 'NORMAL',
          assignment: 'unassigned',
          totalValue: '25000',
          surplusValue: '20000',
        },
        {
          instanceCode: 'subs-max-03',
          specType: 'max',
          status: 'NORMAL',
          assignment: 'assigned',
          totalValue: '250000',
          surplusValue: '200000',
        },
      ],
    },
  };
}

export function tokenPlanStatusWithoutSubscriptions(): TokenPlanStatusResult {
  const team = teamWithSeatDetails();
  team.status = 'not_subscribed';
  team.type = null;
  team.seatSummary = null;
  team.seatSummaries = [];
  team.seatDetails = {
    fetchedCount: 8,
    totalCount: 8,
    historicalCount: 8,
    collectionCompleteness: 'complete',
    completeness: 'complete',
    diagnostics: [],
    items: [],
  };
  return {
    individual: {
      edition: 'individual',
      commodityCode: 'sfm_tokenplansolo_public_cn',
      status: 'not_subscribed',
      type: null,
      name: 'Token Plan Individual Edition',
      specCode: null,
      period: null,
      remainingDays: null,
      autoRenew: null,
      seatSummary: null,
      completeness: 'complete',
      diagnostics: [],
      tiers: [],
    },
    team,
    product: 'Token Plan',
    period: null,
    autoRenew: null,
    renewable: null,
    seatSummary: null,
    diagnostics: [],
  };
}
