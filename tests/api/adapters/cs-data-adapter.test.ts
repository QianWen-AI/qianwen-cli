import { describe, expect, it } from 'vitest';
import {
  buildCsDataRequest,
  unwrapCsDataResponse,
} from '../../../src/api/adapters/cs-data-adapter.js';
import {
  API_TOKENPLAN_MODEL_PROVIDERS,
  API_TOKENPLAN_SOLO_QUOTA_CONFIG,
  API_TOKENPLAN_SOLO_SUBSCRIPTION,
  API_TOKENPLAN_SUPPORTED_MODELS,
} from '../../../src/types/api-routes.js';

function response(code: string, success = true): unknown {
  return {
    code: '200',
    successResponse: true,
    data: {
      success: true,
      DataV2: { ret: ['SUCCESS::ok'], data: { code, success, data: { list: [] } } },
    },
  };
}

describe('cs-data Token Plan model contract', () => {
  it('allows only the model and provider APIs to add anonymous model access', () => {
    const model = buildCsDataRequest({
      api: API_TOKENPLAN_SUPPORTED_MODELS,
      authMode: 'none',
      endpoint: 'https://cs-data.test.qianwenai.com',
      data: { input: { pageNo: 2, pageSize: 100, edition: 'PERSONAL' } },
    });
    expect(model.authMode).toBe('none');
    const params = JSON.parse(new URLSearchParams(model.body).get('params') ?? '{}');
    expect(params.Data.input).toEqual({ pageNo: 2, pageSize: 100, edition: 'PERSONAL' });
    expect(
      buildCsDataRequest({ api: API_TOKENPLAN_MODEL_PROVIDERS, authMode: 'none' }).authMode,
    ).toBe('none');
    expect(() =>
      buildCsDataRequest({ api: API_TOKENPLAN_SOLO_SUBSCRIPTION, authMode: 'none' }),
    ).toThrow();
    expect(() => buildCsDataRequest({ api: 'unregistered.models', authMode: 'none' })).toThrow();
  });

  it.each([
    { input: { pageNo: 0, pageSize: 100, edition: 'PERSONAL' } },
    { input: { pageNo: 1.5, pageSize: 100, edition: 'PERSONAL' } },
    { input: { pageNo: '1', pageSize: 100, edition: 'PERSONAL' } },
    { input: { pageNo: 1, pageSize: 101, edition: 'PERSONAL' } },
    { input: { pageNo: 1, pageSize: 100, edition: 'all' } },
    { input: { pageNo: 1, pageSize: 100, edition: 'TEAM', leaked: true } },
    { input: { pageNo: 1, pageSize: 100, edition: 'TEAM' }, tenantId: 'other' },
  ])('rejects invalid or extra model parameters: %j', (data) => {
    expect(() => buildCsDataRequest({ api: API_TOKENPLAN_SUPPORTED_MODELS, data })).toThrow();
  });

  it('keeps existing empty-parameter contracts and SUCCESS codes unchanged', () => {
    expect(() =>
      buildCsDataRequest({ api: API_TOKENPLAN_SOLO_QUOTA_CONFIG, data: { input: {} } }),
    ).toThrow();
    expect(() =>
      buildCsDataRequest({ api: API_TOKENPLAN_MODEL_PROVIDERS, data: { input: {} } }),
    ).toThrow();
    expect(
      unwrapCsDataResponse(response('SUCCESS'), API_TOKENPLAN_SOLO_QUOTA_CONFIG),
    ).toMatchObject({ code: 'SUCCESS' });
    expect(() => unwrapCsDataResponse(response('200'), API_TOKENPLAN_SOLO_QUOTA_CONFIG)).toThrow();
    expect(() =>
      unwrapCsDataResponse(response('SUCCESS'), API_TOKENPLAN_SUPPORTED_MODELS),
    ).toThrow();
    expect(unwrapCsDataResponse(response('200'), API_TOKENPLAN_SUPPORTED_MODELS)).toMatchObject({
      code: '200',
    });
    expect(() =>
      unwrapCsDataResponse(response('200', false), API_TOKENPLAN_MODEL_PROVIDERS),
    ).toThrow();
    expect(() => unwrapCsDataResponse(response('500'), API_TOKENPLAN_MODEL_PROVIDERS)).toThrow();
  });
});
