import type { TokenPlanEditionStatus } from '../../src/types/tokenplan-subscription.js';

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
