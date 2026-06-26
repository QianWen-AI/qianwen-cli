/**
 * Unit tests for SupportService.rateTicket and SupportService.getAssessmentCard.
 *
 * Covers the contract between the command layer and the Workorder gateway:
 *   1. Type A protocol envelope (product=Workorder, action=SubmitCard).
 *   2. PostParam JSON encoding of all card metadata + satisfaction fields.
 *   3. Conditional tag serialization based on rating threshold.
 *   4. Optional comment forwarding (suggest field).
 *   5. AssessmentCard parsing — full structure plus tolerant fallbacks.
 *   6. Error propagation for network and business failures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiClient } from '../../src/api/api-client.js';
import type { AssessmentCardData } from '../../src/types/support.js';

interface MockApiClient {
  callFlatApi: ReturnType<typeof vi.fn>;
}

function makeMockApiClient(): MockApiClient {
  return { callFlatApi: vi.fn() };
}

const { SupportService } = await import('../../src/services/support-service.js');

// The submission metadata excludes every three-state decision field
// (editable / hasCard / alreadyRated / satisfaction) — only wire-level card
// snapshot fields are forwarded upstream.
type SubmissionMetadata = Omit<
  AssessmentCardData,
  'editable' | 'hasCard' | 'alreadyRated' | 'satisfaction'
>;

function makeMetadata(overrides: Partial<SubmissionMetadata> = {}): SubmissionMetadata {
  return {
    schemaId: 1001,
    bizType: 'ticket_satisfaction',
    answerType: 'satisfaction_card',
    cardBizId: 'CARD-XYZ',
    dialogId: 9988,
    ticketId: 'TICKET-130000001',
    isStar: false,
    ...overrides,
  };
}

function getCallOptions(
  client: MockApiClient,
  callIndex = 0,
): {
  product: string;
  action: string;
  params: Record<string, unknown>;
} {
  return client.callFlatApi.mock.calls[callIndex][0] as {
    product: string;
    action: string;
    params: Record<string, unknown>;
  };
}

function getPostParam(client: MockApiClient, callIndex = 0): Record<string, unknown> {
  const opts = getCallOptions(client, callIndex);
  const raw = opts.params.PostParam;
  expect(typeof raw).toBe('string');
  return JSON.parse(raw as string) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────
// rateTicket — protocol contract
// ─────────────────────────────────────────────────────────────────────────

describe('SupportService.rateTicket — protocol contract', () => {
  let apiClient: MockApiClient;
  let service: InstanceType<typeof SupportService>;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    apiClient.callFlatApi.mockResolvedValue({
      Data: {},
      Message: 'successful',
      Code: 0,
      Success: true,
    });
    service = new SupportService(apiClient as unknown as ApiClient);
  });

  it('calls Type A with product=Workorder, action=SubmitCard', async () => {
    await service.rateTicket('TICKET-130000001', 4);

    const opts = getCallOptions(apiClient);
    expect(opts.product).toBe('Workorder');
    expect(opts.action).toBe('SubmitCard');
  });

  it('wraps the satisfaction payload in a PostParam JSON string', async () => {
    await service.rateTicket('TICKET-130000001', 5);

    const opts = getCallOptions(apiClient);
    expect(Object.keys(opts.params)).toEqual(['PostParam']);
    expect(typeof opts.params.PostParam).toBe('string');
    // Must be valid JSON.
    expect(() => JSON.parse(opts.params.PostParam as string)).not.toThrow();
  });

  it('forwards ticketId and satisfaction inside PostParam', async () => {
    await service.rateTicket('TICKET-130000001', 5);

    const post = getPostParam(apiClient);
    expect(post.ticketId).toBe('TICKET-130000001');
    expect(post.satisfaction).toBe(5);
  });

  it('uses safe defaults for all card metadata fields when metadata is omitted', async () => {
    await service.rateTicket('TICKET-130000001', 3);

    const post = getPostParam(apiClient);
    expect(post.schemaId).toBe(0);
    expect(post.biz_type).toBe('');
    expect(post.answerType).toBe('');
    expect(post.cardBizId).toBe('');
    expect(post.dialogId).toBe(0);
    expect(post.isStar).toBe(false);
  });

  it('omits suggest field when comment is absent', async () => {
    await service.rateTicket('TICKET-130000001', 3);

    const post = getPostParam(apiClient);
    expect('suggest' in post).toBe(false);
  });

  it('omits suggest field when comment is empty string', async () => {
    await service.rateTicket('TICKET-130000001', 3, '');

    const post = getPostParam(apiClient);
    expect('suggest' in post).toBe(false);
  });

  it('forwards non-empty comment into PostParam.suggest', async () => {
    await service.rateTicket('TICKET-130000001', 4, 'Quick and helpful response');

    const post = getPostParam(apiClient);
    expect(post.suggest).toBe('Quick and helpful response');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// rateTicket — metadata propagation
// ─────────────────────────────────────────────────────────────────────────

describe('SupportService.rateTicket — metadata propagation', () => {
  let apiClient: MockApiClient;
  let service: InstanceType<typeof SupportService>;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    apiClient.callFlatApi.mockResolvedValue({ Data: {} });
    service = new SupportService(apiClient as unknown as ApiClient);
  });

  it('serializes every metadata field into PostParam under the wire-level name', async () => {
    const metadata = makeMetadata({
      schemaId: 7777,
      bizType: 'ticket_satisfaction',
      answerType: 'satisfaction_card',
      cardBizId: 'CARD-ABC-001',
      dialogId: 555_001,
      ticketId: 'TICKET-130000001',
      isStar: true,
    });

    await service.rateTicket('TICKET-130000001', 5, undefined, metadata);

    const post = getPostParam(apiClient);
    expect(post.schemaId).toBe(7777);
    expect(post.biz_type).toBe('ticket_satisfaction');
    expect(post.answerType).toBe('satisfaction_card');
    expect(post.cardBizId).toBe('CARD-ABC-001');
    expect(post.dialogId).toBe(555_001);
    expect(post.isStar).toBe(true);
  });

  it('uses the explicit ticketId argument as PostParam.ticketId regardless of metadata', async () => {
    // The argument-level ticketId is the source of truth — metadata.ticketId is
    // metadata snapshot only and must not override the explicit submission target.
    const metadata = makeMetadata({ ticketId: 'TICKET-OLD' });

    await service.rateTicket('TICKET-NEW-130000099', 4, undefined, metadata);

    const post = getPostParam(apiClient);
    expect(post.ticketId).toBe('TICKET-NEW-130000099');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// rateTicket — conditional tag serialization
// ─────────────────────────────────────────────────────────────────────────

describe('SupportService.rateTicket — tag serialization', () => {
  let apiClient: MockApiClient;
  let service: InstanceType<typeof SupportService>;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    apiClient.callFlatApi.mockResolvedValue({ Data: {} });
    service = new SupportService(apiClient as unknown as ApiClient);
  });

  it('emits tagfilter_goodlabel only when rating>=2 and good tags are present', async () => {
    await service.rateTicket('TICKET-130000001', 2, undefined, makeMetadata(), {
      good: ['处理速度快', '解决方案有效'],
    });

    const post = getPostParam(apiClient);
    expect(post.tagfilter_goodlabel).toEqual(['处理速度快', '解决方案有效']);
    expect('tagfilter_badlabel' in post).toBe(false);
  });

  it('still emits tagfilter_goodlabel at the rating>=2 boundary (rating=2)', async () => {
    await service.rateTicket('TICKET-130000001', 2, undefined, makeMetadata(), {
      good: ['服务态度好'],
    });

    const post = getPostParam(apiClient);
    expect(post.tagfilter_goodlabel).toEqual(['服务态度好']);
  });

  it('emits tagfilter_badlabel only when rating<2 and bad tags are present', async () => {
    await service.rateTicket('TICKET-130000001', 1, undefined, makeMetadata(), {
      bad: ['响应处理速度慢', '解决方案无效'],
    });

    const post = getPostParam(apiClient);
    expect(post.tagfilter_badlabel).toEqual(['响应处理速度慢', '解决方案无效']);
    expect('tagfilter_goodlabel' in post).toBe(false);
  });

  it('drops good tags when rating<2 (channel mismatch)', async () => {
    await service.rateTicket('TICKET-130000001', 1, undefined, makeMetadata(), {
      good: ['服务态度好'],
    });

    const post = getPostParam(apiClient);
    expect('tagfilter_goodlabel' in post).toBe(false);
    expect('tagfilter_badlabel' in post).toBe(false);
  });

  it('drops bad tags when rating>=2 (channel mismatch)', async () => {
    await service.rateTicket('TICKET-130000001', 2, undefined, makeMetadata(), {
      bad: ['响应处理速度慢'],
    });

    const post = getPostParam(apiClient);
    expect('tagfilter_goodlabel' in post).toBe(false);
    expect('tagfilter_badlabel' in post).toBe(false);
  });

  it('emits no tag fields when the matching tag list is empty', async () => {
    await service.rateTicket('TICKET-130000001', 2, undefined, makeMetadata(), { good: [] });

    const post = getPostParam(apiClient);
    expect('tagfilter_goodlabel' in post).toBe(false);
    expect('tagfilter_badlabel' in post).toBe(false);
  });

  it('emits no tag fields when tags argument is omitted', async () => {
    await service.rateTicket('TICKET-130000001', 2, undefined, makeMetadata());

    const post = getPostParam(apiClient);
    expect('tagfilter_goodlabel' in post).toBe(false);
    expect('tagfilter_badlabel' in post).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// rateTicket — return value contract
// ─────────────────────────────────────────────────────────────────────────

describe('SupportService.rateTicket — return value contract', () => {
  let apiClient: MockApiClient;
  let service: InstanceType<typeof SupportService>;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    apiClient.callFlatApi.mockResolvedValue({ Data: {} });
    service = new SupportService(apiClient as unknown as ApiClient);
  });

  it('returns ticketId, rating, status="score" and an ISO-8601 timestamp', async () => {
    const result = await service.rateTicket('TICKET-130000001', 4);

    expect(result.ticketId).toBe('TICKET-130000001');
    expect(result.rating).toBe(4);
    expect(result.status).toBe('score');
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// rateTicket — error propagation
// ─────────────────────────────────────────────────────────────────────────

describe('SupportService.rateTicket — error propagation', () => {
  let apiClient: MockApiClient;
  let service: InstanceType<typeof SupportService>;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    service = new SupportService(apiClient as unknown as ApiClient);
  });

  it('propagates network/timeout errors thrown by callFlatApi', async () => {
    apiClient.callFlatApi.mockRejectedValue(
      Object.assign(new Error('connect ETIMEDOUT mock-api.test.qianwen.com'), {
        name: 'NetworkError',
        code: 'ETIMEDOUT',
      }),
    );

    await expect(service.rateTicket('TICKET-130000001', 4)).rejects.toMatchObject({
      name: 'NetworkError',
      code: 'ETIMEDOUT',
    });
  });

  it('propagates business errors (e.g. ticket not in wait_score state)', async () => {
    apiClient.callFlatApi.mockRejectedValue(
      Object.assign(new Error('ticket is not awaiting rating'), {
        name: 'GatewayBusinessError',
        code: '400',
      }),
    );

    await expect(service.rateTicket('TICKET-130000001', 4)).rejects.toMatchObject({
      name: 'GatewayBusinessError',
      code: '400',
    });
  });

  it('propagates not-found errors for invalid ticketId', async () => {
    apiClient.callFlatApi.mockRejectedValue(
      Object.assign(new Error('您无权查看该工单'), {
        name: 'GatewayBusinessError',
        code: '401',
      }),
    );

    await expect(service.rateTicket('TICKET-999999999', 4)).rejects.toMatchObject({
      name: 'GatewayBusinessError',
      code: '401',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getAssessmentCard — protocol contract
// ─────────────────────────────────────────────────────────────────────────

describe('SupportService.getAssessmentCard — protocol contract', () => {
  let apiClient: MockApiClient;
  let service: InstanceType<typeof SupportService>;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    service = new SupportService(apiClient as unknown as ApiClient);
  });

  it('calls Type A with product=Workorder, action=GetAssessmentCard and TicketId param', async () => {
    apiClient.callFlatApi.mockResolvedValue({ Data: { DataInfo: { Editable: 1 } } });

    await service.getAssessmentCard('TICKET-130000001');

    const opts = getCallOptions(apiClient);
    expect(opts.product).toBe('Workorder');
    expect(opts.action).toBe('GetAssessmentCard');
    expect(opts.params).toEqual({ TicketId: 'TICKET-130000001' });
  });

  it('returns the full assessment card including editable=true and metadata fields', async () => {
    apiClient.callFlatApi.mockResolvedValue({
      Data: {
        DataInfo: {
          Editable: 1,
          DialogId: 9988,
          Values: {
            schemaId: 1001,
            biz_type: 'ticket_satisfaction',
            answerType: 'satisfaction_card',
            cardBizId: 'CARD-XYZ',
            dialogId: 9988,
            ticketId: 'TICKET-130000001',
          },
        },
      },
    });

    const result = await service.getAssessmentCard('TICKET-130000001');

    expect(result.editable).toBe(true);
    expect(result.schemaId).toBe(1001);
    expect(result.bizType).toBe('ticket_satisfaction');
    expect(result.answerType).toBe('satisfaction_card');
    expect(result.cardBizId).toBe('CARD-XYZ');
    expect(result.dialogId).toBe(9988);
    expect(result.ticketId).toBe('TICKET-130000001');
    expect(result.isStar).toBe(false);
    // Default fallback tags when Props is missing
    expect(result.goodTags).toEqual(['服务入口便捷', '处理速度快', '解决方案有效', '服务态度好']);
    expect(result.badTags).toEqual([
      '找售后服务入口费力',
      '响应处理速度慢',
      '解决方案无效',
      '服务态度不好',
    ]);
  });

  it('falls back to DataInfo.DialogId when Values.dialogId is missing', async () => {
    apiClient.callFlatApi.mockResolvedValue({
      Data: {
        DataInfo: {
          Editable: 1,
          DialogId: 7777,
          Values: {
            schemaId: 1,
            biz_type: 'ticket_satisfaction',
            answerType: 'satisfaction_card',
            cardBizId: 'CARD-1',
            ticketId: 'TICKET-130000001',
          },
        },
      },
    });

    const result = await service.getAssessmentCard('TICKET-130000001');
    expect(result.dialogId).toBe(7777);
  });

  it('returns editable=false when Editable === 2 (already rated)', async () => {
    apiClient.callFlatApi.mockResolvedValue({ Data: { DataInfo: { Editable: 2 } } });

    const result = await service.getAssessmentCard('TICKET-130000001');
    expect(result.editable).toBe(false);
  });

  it('returns editable=false when Editable === 0 (iter-75: only Editable===1 is editable)', async () => {
    apiClient.callFlatApi.mockResolvedValue({ Data: { DataInfo: { Editable: 0 } } });

    const result = await service.getAssessmentCard('TICKET-130000001');
    expect(result.editable).toBe(false);
  });

  it('returns editable=true when Editable === 1', async () => {
    apiClient.callFlatApi.mockResolvedValue({ Data: { DataInfo: { Editable: 1 } } });

    const result = await service.getAssessmentCard('TICKET-130000001');
    expect(result.editable).toBe(true);
  });

  it('returns safe fallbacks (editable=true + zero/empty metadata) when DataInfo.Values is missing', async () => {
    apiClient.callFlatApi.mockResolvedValue({ Data: { DataInfo: {} } });

    const result = await service.getAssessmentCard('TICKET-130000001');
    // G4: the full-equality snapshot must include the three-state fields. An
    // empty DataInfo (no Values, Editable undefined) is a present-but-unrateable
    // card: hasCard=true, editable=false, alreadyRated=false, satisfaction absent.
    expect(result).toEqual({
      editable: false,
      hasCard: true,
      alreadyRated: false,
      schemaId: 0,
      bizType: '',
      answerType: '',
      cardBizId: '',
      dialogId: 0,
      ticketId: 'TICKET-130000001',
      isStar: false,
      goodTags: ['服务入口便捷', '处理速度快', '解决方案有效', '服务态度好'],
      badTags: ['找售后服务入口费力', '响应处理速度慢', '解决方案无效', '服务态度不好'],
    });
    expect(result.satisfaction).toBeUndefined();
  });

  it('returns safe fallbacks when Data is empty', async () => {
    apiClient.callFlatApi.mockResolvedValue({ Data: {} });

    const result = await service.getAssessmentCard('TICKET-130000001');
    expect(result.editable).toBe(false);
    expect(result.ticketId).toBe('TICKET-130000001');
    expect(result.goodTags).toEqual(['服务入口便捷', '处理速度快', '解决方案有效', '服务态度好']);
    expect(result.badTags).toEqual([
      '找售后服务入口费力',
      '响应处理速度慢',
      '解决方案无效',
      '服务态度不好',
    ]);
  });

  it('returns safe fallbacks when the entire response body is empty', async () => {
    apiClient.callFlatApi.mockResolvedValue({});

    const result = await service.getAssessmentCard('TICKET-130000001');
    expect(result.editable).toBe(false);
    expect(result.schemaId).toBe(0);
    expect(result.bizType).toBe('');
    expect(result.ticketId).toBe('TICKET-130000001');
    expect(result.goodTags).toEqual(['服务入口便捷', '处理速度快', '解决方案有效', '服务态度好']);
    expect(result.badTags).toEqual([
      '找售后服务入口费力',
      '响应处理速度慢',
      '解决方案无效',
      '服务态度不好',
    ]);
  });

  it('parses goodTags and badTags from Props schema', async () => {
    apiClient.callFlatApi.mockResolvedValue({
      Data: {
        DataInfo: {
          Editable: 1,
          DialogId: 9988,
          Props: [
            {
              name: 'ServiceEvaluation',
              value: {
                schema: {
                  properties: {
                    overall: {
                      'x-component-props': {
                        goodDataSource: ['自定义好评标签1', '自定义好评标签2'],
                        badDataSource: ['自定义差评标签1', '自定义差评标签2'],
                        isStar: true,
                      },
                    },
                  },
                },
              },
            },
          ],
          Values: {
            schemaId: 1001,
            biz_type: 'ticket_satisfaction',
            answerType: 'satisfaction_card',
            cardBizId: 'CARD-XYZ',
            dialogId: 9988,
            ticketId: 'TICKET-130000001',
          },
        },
      },
    });

    const result = await service.getAssessmentCard('TICKET-130000001');
    expect(result.goodTags).toEqual(['自定义好评标签1', '自定义好评标签2']);
    expect(result.badTags).toEqual(['自定义差评标签1', '自定义差评标签2']);
    expect(result.isStar).toBe(true);
  });

  it('propagates network/business errors thrown by callFlatApi', async () => {
    apiClient.callFlatApi.mockRejectedValue(
      Object.assign(new Error('connect ETIMEDOUT mock-api.test.qianwen.com'), {
        name: 'NetworkError',
        code: 'ETIMEDOUT',
      }),
    );

    await expect(service.getAssessmentCard('TICKET-130000001')).rejects.toMatchObject({
      name: 'NetworkError',
      code: 'ETIMEDOUT',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getAssessmentCard — three-state classification (hasCard / alreadyRated /
// editable / satisfaction) derived from the real upstream response shapes.
//
// Probe evidence (real GetAssessmentCard responses):
//   • Closed + rated   : DataInfo.Editable=2, Values.satisfaction=N,
//                        Props[0].value.disableEvaluate=true
//   • Not closed       : Data has no DataInfo at all
//   • Rateable         : DataInfo.Editable=1, Values.satisfaction absent,
//                        Props[0].value.disableEvaluate=false
//
// Decision rules (per architecture design):
//   hasCard      = DataInfo present
//   alreadyRated = (satisfaction is a number) || disableEvaluate===true || Editable===2
//   editable     = Editable===1
// ─────────────────────────────────────────────────────────────────────────

describe('SupportService.getAssessmentCard — three-state classification', () => {
  let apiClient: MockApiClient;
  let service: InstanceType<typeof SupportService>;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    service = new SupportService(apiClient as unknown as ApiClient);
  });

  it('classifies an already-rated card (Editable=2 + satisfaction + disableEvaluate)', async () => {
    apiClient.callFlatApi.mockResolvedValue({
      Data: {
        DataInfo: {
          Editable: 2,
          Values: {
            satisfaction: 5,
            schemaId: 1001,
            biz_type: 'ticket_satisfaction',
            answerType: 'satisfaction_card',
            cardBizId: 'CARD-RATED',
            dialogId: 9988,
            ticketId: 'TICKET-130000001',
            isStar: false,
          },
          Props: [{ value: { disableEvaluate: true } }],
        },
      },
    });

    const result = await service.getAssessmentCard('TICKET-130000001');

    expect(result.hasCard).toBe(true);
    expect(result.alreadyRated).toBe(true);
    expect(result.editable).toBe(false);
    expect(result.satisfaction).toBe(5);
  });

  it('captures the exact satisfaction score on a rated card (score=2)', async () => {
    apiClient.callFlatApi.mockResolvedValue({
      Data: {
        DataInfo: {
          Editable: 2,
          Values: {
            satisfaction: 2,
            schemaId: 1001,
            biz_type: 'ticket_satisfaction',
            answerType: 'satisfaction_card',
            cardBizId: 'CARD-RATED-2',
            dialogId: 7001,
            ticketId: 'TICKET-130000002',
            isStar: false,
          },
          Props: [{ value: { disableEvaluate: true } }],
        },
      },
    });

    const result = await service.getAssessmentCard('TICKET-130000002');

    expect(result.alreadyRated).toBe(true);
    expect(result.satisfaction).toBe(2);
  });

  it('classifies a not-closed ticket (no DataInfo) as hasCard=false', async () => {
    apiClient.callFlatApi.mockResolvedValue({ Data: {} });

    const result = await service.getAssessmentCard('TICKET-130000003');

    expect(result.hasCard).toBe(false);
    expect(result.alreadyRated).toBe(false);
    expect(result.editable).toBe(false);
    expect(result.satisfaction).toBeUndefined();
  });

  it('classifies a rateable card (Editable=1, no satisfaction, disableEvaluate=false)', async () => {
    apiClient.callFlatApi.mockResolvedValue({
      Data: {
        DataInfo: {
          Editable: 1,
          Values: {
            schemaId: 1001,
            biz_type: 'ticket_satisfaction',
            answerType: 'satisfaction_card',
            cardBizId: 'CARD-OPEN',
            dialogId: 9988,
            ticketId: 'TICKET-130000004',
            isStar: false,
          },
          Props: [{ value: { disableEvaluate: false } }],
        },
      },
    });

    const result = await service.getAssessmentCard('TICKET-130000004');

    expect(result.editable).toBe(true);
    expect(result.hasCard).toBe(true);
    expect(result.alreadyRated).toBe(false);
    expect(result.satisfaction).toBeUndefined();
  });

  it('treats disableEvaluate=true alone as already-rated even without a satisfaction value', async () => {
    apiClient.callFlatApi.mockResolvedValue({
      Data: {
        DataInfo: {
          Editable: 2,
          Values: {
            schemaId: 1001,
            biz_type: 'ticket_satisfaction',
            answerType: 'satisfaction_card',
            cardBizId: 'CARD-DISABLED',
            dialogId: 9988,
            ticketId: 'TICKET-130000005',
            isStar: false,
          },
          Props: [{ value: { disableEvaluate: true } }],
        },
      },
    });

    const result = await service.getAssessmentCard('TICKET-130000005');

    expect(result.alreadyRated).toBe(true);
    expect(result.editable).toBe(false);
  });
});
