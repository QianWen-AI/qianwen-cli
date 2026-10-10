import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTokenPlanSeatDetails,
  resolveTokenPlanSeatAssignments,
} from '../../src/services/tokenplan-seat-details.js';
import { teamWithSeatDetails } from '../helpers/tokenplan-status.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';

const seat = (n: number, extra: Record<string, unknown> = {}) => ({
  InstanceCode: `seat-${n}`,
  SpecType: 'standard',
  Status: 'NORMAL',
  MemberId: '',
  EquityList: [{ CycleTotalValue: '25000', CycleSurplusValue: '20000' }],
  ...extra,
});
const page = (items: unknown[], total: unknown = items.length, current = 1) => ({
  Success: true,
  Code: 'Success',
  Data: { SubscriptionList: items, TotalCount: total, CurrentPage: current, PageSize: 100 },
});

afterEach(() => vi.useRealTimers());

describe('status seat detail collection', () => {
  it('collects all 150 records with a shared signal and omits confirmed historical seats', async () => {
    const api = makeMockApiClient({
      flat: async ({ params }) => {
        const current = Number(params?.pageNo);
        const offset = (current - 1) * 100;
        return page(
          Array.from({ length: current === 1 ? 100 : 50 }, (_, n) =>
            seat(offset + n, { Status: n === 0 ? 'REFUNDED' : 'NORMAL' }),
          ),
          150,
          current,
        );
      },
    });
    const result = await fetchTokenPlanSeatDetails(api);
    expect(result).toMatchObject({
      fetchedCount: 150,
      totalCount: 150,
      historicalCount: 2,
      collectionCompleteness: 'complete',
      completeness: 'complete',
      diagnostics: [],
    });
    expect(result.items).toHaveLength(148);
    expect(result.items.every((item) => item.status === 'NORMAL')).toBe(true);
    expect(api.callFlatApi).toHaveBeenCalledTimes(2);
    expect(api.callFlatApi.mock.calls[0][0].params).toEqual({
      productCode: 'sfm_tokenplanteams_dp_cn',
      pageNo: 1,
      pageSize: 100,
    });
    expect(api.callFlatApi.mock.calls[1][0].signal).toBe(api.callFlatApi.mock.calls[0][0].signal);
  });

  it('accepts array envelopes with a verified zero total', async () => {
    const api = makeMockApiClient({ flat: async () => ({ Data: [], TotalCount: 0 }) });
    expect(await fetchTokenPlanSeatDetails(api)).toEqual({
      items: [],
      fetchedCount: 0,
      totalCount: 0,
      historicalCount: 0,
      collectionCompleteness: 'complete',
      completeness: 'complete',
      diagnostics: [],
    });
  });

  it.each([{ items: [] }, { items: [seat(1)] }])(
    'does not use page length as a missing total',
    async ({ items }) => {
      const api = makeMockApiClient({ flat: async () => ({ Data: items }) });
      const result = await fetchTokenPlanSeatDetails(api);
      expect(result.totalCount).toBeNull();
      expect(result.completeness).toBe(items.length ? 'partial' : 'unknown');
      expect(result.diagnostics).not.toHaveLength(0);
    },
  );

  it.each([null, {}, { Success: false, Data: [] }, { Code: 'Error', Data: [] }, page([], '0')])(
    'rejects unverified envelopes and totals: %j',
    async (raw) => {
      const api = makeMockApiClient({ flat: async () => raw });
      expect(await fetchTokenPlanSeatDetails(api)).toMatchObject({
        completeness: 'unknown',
        totalCount: null,
        fetchedCount: 0,
      });
    },
  );

  it('preserves valid fields and distinguishes missing MemberId from explicit unassigned', async () => {
    const api = makeMockApiClient({
      flat: async () =>
        page(
          [
            seat(1, { MemberId: undefined, SpecType: 'future', Status: 'future', EquityList: [] }),
            seat(2, {
              MemberId: 'member-test',
              EquityList: [{ CycleTotalValue: '0', CycleSurplusValue: '0' }],
            }),
            seat(3),
            null,
            { SpecType: 'standard' },
            seat(4, { ProductCode: 'sfm_tokenplanpersonal_dp_cn' }),
          ],
          6,
        ),
    });
    const result = await fetchTokenPlanSeatDetails(api);
    expect(result.completeness).toBe('partial');
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      assignment: 'unknown',
      specType: null,
      status: null,
      totalValue: null,
      surplusValue: null,
    });
    expect(result.items[1]).toMatchObject({
      assignment: 'assigned',
      totalValue: '0',
      surplusValue: '0',
    });
    expect(result.items[2].assignment).toBe('unassigned');
    expect(JSON.stringify(result)).not.toContain('member-test');
  });

  it('keeps optional-field availability separate from a fully collected page', async () => {
    const api = makeMockApiClient({
      flat: async () =>
        page([seat(1, { MemberId: undefined, Assignable: true }), seat(2, { EquityList: [{}] })]),
    });
    const result = await fetchTokenPlanSeatDetails(api);
    expect(result).toMatchObject({
      collectionCompleteness: 'complete',
      completeness: 'partial',
      diagnostics: [],
    });
    expect(result.items[0].assignment).toBe('unknown');
    expect(result.items[1].totalValue).toBeNull();
  });

  it.each(['REFUNDED', 'RELEASE', 'STOP'])(
    'does not require current credits or assignment for historical %s seats',
    async (status) => {
      const api = makeMockApiClient({
        flat: async () =>
          page([seat(1, { Status: status, MemberId: undefined, EquityList: [{}] })]),
      });
      expect(await fetchTokenPlanSeatDetails(api)).toMatchObject({
        items: [],
        fetchedCount: 1,
        totalCount: 1,
        historicalCount: 1,
        collectionCompleteness: 'complete',
        completeness: 'complete',
        diagnostics: [],
      });
    },
  );

  it('does not claim there are no current seats when later pages are unavailable', async () => {
    const api = makeMockApiClient({
      flat: async ({ params }) => {
        if (params?.pageNo === 2) throw new Error('later page unavailable');
        return page(
          Array.from({ length: 100 }, (_, n) => seat(n, { Status: 'REFUNDED', EquityList: [{}] })),
          101,
        );
      },
    });
    expect(await fetchTokenPlanSeatDetails(api)).toMatchObject({
      items: [],
      fetchedCount: 100,
      historicalCount: 100,
      totalCount: 101,
      collectionCompleteness: 'partial',
      completeness: 'partial',
    });
  });

  it.each([
    [{ CycleTotalValue: '20', SurplusValue: '10' }, '20'],
    [{ TotalValue: '25000', SurplusValue: '25000.0000000000001' }, '25000'],
    [{ TotalValue: '1e6', SurplusValue: '-1' }, null],
    [{ TotalValue: '25', SurplusValue: '10', Unit: 'Tokens' }, null],
  ])('does not invent or mix quota values: %j', async (equity, total) => {
    const api = makeMockApiClient({ flat: async () => page([seat(1, { EquityList: [equity] })]) });
    const result = await fetchTokenPlanSeatDetails(api);
    expect(result.items[0]).toMatchObject({ totalValue: total, surplusValue: null });
    expect(result.completeness).toBe('partial');
  });

  it('deduplicates by either stable identifier without presenting duplicate pages as complete', async () => {
    const first = Array.from({ length: 100 }, (_, n) => seat(n, { InstanceId: `id-${n}` }));
    const api = makeMockApiClient({
      flat: async ({ params }) =>
        Number(params?.pageNo) === 1
          ? page(first, 101)
          : page([seat(0, { InstanceCode: undefined, InstanceId: 'id-0' })], 101, 2),
    });
    const result = await fetchTokenPlanSeatDetails(api);
    expect(result).toMatchObject({ fetchedCount: 100, totalCount: 101, completeness: 'partial' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ errorCode: 'DuplicateSeat' }),
    );
    expect(api.callFlatApi).toHaveBeenCalledTimes(2);
  });

  it('clears a drifting total while retaining new valid records', async () => {
    const api = makeMockApiClient({
      flat: async ({ params }) =>
        Number(params?.pageNo) === 1
          ? page(
              Array.from({ length: 100 }, (_, n) => seat(n)),
              150,
            )
          : page([seat(100)], 151, 2),
    });
    expect(await fetchTokenPlanSeatDetails(api)).toMatchObject({
      fetchedCount: 101,
      totalCount: null,
      completeness: 'partial',
    });
  });

  it.each([
    { ...page([seat(1)], 1), TotalCount: 2 },
    page([seat(1)], 1, 2),
    page(Array.from({ length: 101 }, (_, n) => seat(n))),
  ])('does not claim complete after pagination conflicts', async (raw) => {
    const api = makeMockApiClient({ flat: async () => raw });
    expect((await fetchTokenPlanSeatDetails(api)).completeness).toBe('partial');
    expect(api.callFlatApi).toHaveBeenCalledTimes(1);
  });

  it('keeps the first page and safe diagnostics after a later request fails', async () => {
    const api = makeMockApiClient({
      flat: async ({ params }) => {
        if (Number(params?.pageNo) === 2) throw new Error('private backend payload');
        return page(
          Array.from({ length: 100 }, (_, n) => seat(n)),
          150,
        );
      },
    });
    const result = await fetchTokenPlanSeatDetails(api);
    expect(result).toMatchObject({ fetchedCount: 100, totalCount: 150, completeness: 'partial' });
    expect(JSON.stringify(result)).not.toContain('private backend payload');
  });

  it('stops at 10 pages and reports the remaining records as incomplete', async () => {
    const api = makeMockApiClient({
      flat: async ({ params }) => {
        const current = Number(params?.pageNo);
        return page(
          Array.from({ length: 100 }, (_, n) => seat(current * 100 + n)),
          1001,
          current,
        );
      },
    });
    expect(await fetchTokenPlanSeatDetails(api)).toMatchObject({
      fetchedCount: 1000,
      totalCount: 1001,
      completeness: 'partial',
    });
    expect(api.callFlatApi).toHaveBeenCalledTimes(10);
  });

  it('bounds clients that ignore abort and prevents late responses from changing the result', async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => {};
    const api = makeMockApiClient({
      flat: async ({ params }) =>
        Number(params?.pageNo) === 1
          ? page(
              Array.from({ length: 100 }, (_, n) => seat(n)),
              101,
            )
          : new Promise((resolve) => {
              finish = resolve;
            }),
    });
    const pending = fetchTokenPlanSeatDetails(api);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result).toMatchObject({ fetchedCount: 100, completeness: 'partial' });
    expect(api.callFlatApi.mock.calls[1][0].signal.aborted).toBe(true);
    finish(page([seat(100)], 101, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.items).toHaveLength(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a parent abort before starting any request', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = makeMockApiClient();
    expect((await fetchTokenPlanSeatDetails(api, controller.signal)).completeness).toBe('unknown');
    expect(api.callFlatApi).not.toHaveBeenCalled();
  });
});

describe('current seat assignment resolution', () => {
  const currentTeam = (assigned = 0) => {
    const team = teamWithSeatDetails();
    team.seatSummary!.groups = [{ ...team.seatSummary!.groups[0], seats: 2, assigned }];
    team.seatSummary!.total!.seats = 2;
    return team;
  };

  async function missingAssignments() {
    const api = makeMockApiClient({
      flat: async () =>
        page([
          seat(0, { MemberId: undefined, Assignable: true, Status: 'REFUNDED', EquityList: [{}] }),
          seat(1, { MemberId: undefined, Assignable: true }),
          seat(2, { MemberId: undefined, Assignable: true }),
        ]),
    });
    return fetchTokenPlanSeatDetails(api);
  }

  it.each([
    { assigned: 0, expected: 'unassigned' },
    { assigned: 2, expected: 'assigned' },
  ])(
    'resolves a wholly $expected group from a verified summary',
    async ({ assigned, expected }) => {
      const source = await missingAssignments();
      const result = resolveTokenPlanSeatAssignments(source, currentTeam(assigned))!;
      expect(result.items.map((item) => item.assignment)).toEqual([expected, expected]);
      expect(result).toMatchObject({
        completeness: 'complete',
        collectionCompleteness: 'complete',
        fetchedCount: 3,
        historicalCount: 1,
        diagnostics: [],
      });
      expect(source.items.every((item) => item.assignment === 'unknown')).toBe(true);
    },
  );

  it('does not guess which seats are assigned in a partially assigned group', async () => {
    const result = resolveTokenPlanSeatAssignments(await missingAssignments(), currentTeam(1))!;
    expect(result.items.every((item) => item.assignment === 'unknown')).toBe(true);
    expect(result).toMatchObject({
      completeness: 'partial',
      collectionCompleteness: 'complete',
      diagnostics: [],
    });
  });

  it.each(['empty', 'fewer', 'extra', 'spec-mismatch', 'missing-assigned', 'missing-total'])(
    'warns about verified summary/detail disagreement without changing records: %s',
    async (scenario) => {
      const team = currentTeam();
      const size =
        scenario === 'empty' ? 0 : scenario === 'extra' ? 3 : scenario === 'spec-mismatch' ? 2 : 1;
      if (scenario === 'missing-assigned') team.seatSummary!.groups[0].assigned = null;
      if (scenario === 'missing-total') team.seatSummary!.total = null;
      const originalTeam = structuredClone(team);
      const source = await fetchTokenPlanSeatDetails(
        makeMockApiClient({
          flat: async () =>
            page(
              Array.from({ length: size }, (_, index) =>
                seat(index, {
                  MemberId: undefined,
                  SpecType: scenario === 'spec-mismatch' && index === 1 ? 'pro' : 'standard',
                }),
              ),
            ),
        }),
      );
      const originalSource = structuredClone(source);
      const result = resolveTokenPlanSeatAssignments(source, team)!;

      expect(result).toMatchObject({
        items: source.items,
        fetchedCount: size,
        totalCount: size,
        collectionCompleteness: 'complete',
        completeness: 'partial',
        diagnostics: [
          {
            api: 'GetSubscriptionDetail',
            errorCode: 'SeatSummaryMismatch',
            errorMessage: 'Seat details do not match the seat summary. Please try again later.',
          },
        ],
      });
      expect(resolveTokenPlanSeatAssignments(result, team)?.diagnostics).toHaveLength(1);
      expect(team).toEqual(originalTeam);
      expect(source).toEqual(originalSource);
    },
  );

  it('does not warn when the summary and details both confirm zero current seats', async () => {
    const team = currentTeam();
    team.seatSummary!.groups = [];
    team.seatSummary!.total!.seats = 0;
    const source = await fetchTokenPlanSeatDetails(
      makeMockApiClient({ flat: async () => page([]) }),
    );
    expect(resolveTokenPlanSeatAssignments(source, team)).toMatchObject({
      items: [],
      collectionCompleteness: 'complete',
      completeness: 'complete',
      diagnostics: [],
    });
  });

  it.each([
    'partial-query',
    'unknown-status',
    'unknown-summary',
    'summary-error',
    'unknown-subscription',
  ])('does not turn uncertain data into a count conflict: %s', async (scenario) => {
    const source = await missingAssignments();
    const team = currentTeam();
    team.seatSummary!.total!.seats = 3;
    if (scenario === 'partial-query') source.collectionCompleteness = 'partial';
    if (scenario === 'unknown-status') source.items[0].status = null;
    if (scenario === 'unknown-summary') team.seatSummary = null;
    if (scenario === 'summary-error')
      team.diagnostics.push({
        api: 'GetSubscriptionSummary',
        errorCode: 'Unavailable',
        errorMessage: 'Unavailable',
      });
    if (scenario === 'unknown-subscription') team.status = 'unknown';

    expect(resolveTokenPlanSeatAssignments(source, team)?.diagnostics).not.toContainEqual(
      expect.objectContaining({ errorCode: 'SeatSummaryMismatch' }),
    );
  });

  it.each([
    'partial-query',
    'total-mismatch',
    'group-mismatch',
    'missing-assigned',
    'excess-assigned',
    'duplicate-group',
    'unknown-status',
    'unknown-spec',
    'summary-error',
    'unknown-subscription',
  ])('does not derive assignments with %s evidence', async (mode) => {
    const source = await missingAssignments();
    const team = currentTeam();
    if (mode === 'partial-query') source.collectionCompleteness = 'partial';
    if (mode === 'total-mismatch') team.seatSummary!.total!.seats = 3;
    if (mode === 'group-mismatch') team.seatSummary!.groups[0].seats = 3;
    if (mode === 'missing-assigned') team.seatSummary!.groups[0].assigned = null;
    if (mode === 'excess-assigned') team.seatSummary!.groups[0].assigned = 3;
    if (mode === 'duplicate-group')
      team.seatSummary!.groups.push({ ...team.seatSummary!.groups[0] });
    if (mode === 'unknown-status') source.items[0].status = null;
    if (mode === 'unknown-spec') source.items[0].specType = null;
    if (mode === 'summary-error')
      team.diagnostics.push({
        api: 'GetSeatSubscriptionSummary',
        errorCode: 'InvalidGroup',
        errorMessage: 'Unavailable',
      });
    if (mode === 'unknown-subscription') team.status = 'unknown';
    const result = resolveTokenPlanSeatAssignments(source, team)!;
    expect(result.items.every((item) => item.assignment === 'unknown')).toBe(true);
  });

  it('reports contradictory explicit assignments instead of overwriting them with the summary', async () => {
    const source = await missingAssignments();
    source.items[0].assignment = 'assigned';
    const result = resolveTokenPlanSeatAssignments(source, currentTeam())!;
    expect(result.items.map((item) => item.assignment)).toEqual(['assigned', 'unknown']);
    expect(result.completeness).toBe('partial');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ errorCode: 'AssignmentConflict' }),
    );
  });
});
