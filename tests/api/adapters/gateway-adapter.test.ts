/**
 * Tests for the gateway envelope adapter — pure transformations.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEnvelopePayload,
  isSuccessRet,
  parseRetError,
  deriveProductCode,
} from '../../../src/api/adapters/gateway-adapter.js';

describe('buildEnvelopePayload', () => {
  it('wraps the supplied data in reqDTO and injects a default cornerstoneParam', () => {
    const out = buildEnvelopePayload({
      api: 'zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent',
      data: { pageNo: 1, pageSize: 20 },
    });

    expect(out.api).toBe('zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent');
    expect(out.data.reqDTO).toEqual({ pageNo: 1, pageSize: 20 });

    // Default cornerstoneParam carries six well-known fields.
    expect(out.cornerstoneParam).toMatchObject({
      consoleSite: 'QIANWENAI',
      console: 'ONE_CONSOLE',
      xsp_lang: 'zh-CN',
      protocol: 'V2',
      productCode: 'p_efm',
    });
    expect(typeof out.cornerstoneParam.domain).toBe('string');
    expect((out.cornerstoneParam.domain as string).length).toBeGreaterThan(0);
  });

  it('honours an explicit cornerstoneParam override', () => {
    const corner = { domain: 'override.test.qianwen.com', protocol: 'V3', productCode: 'p_test' };
    const out = buildEnvelopePayload({
      api: 'foo.bar.baz',
      data: { x: 1 },
      cornerstoneParam: corner,
    });
    expect(out.cornerstoneParam).toEqual(corner);
    expect(out.data.cornerstoneParam).toEqual(corner);
  });

  it('does not share references with caller-supplied data or cornerstoneParam', () => {
    const data = { x: 1 };
    const corner = { domain: 'a.test.qianwen.com' };
    const out = buildEnvelopePayload({ api: 'a.b', data, cornerstoneParam: corner });
    out.data.reqDTO.x = 999;
    out.cornerstoneParam.domain = 'mutated';
    expect(data.x).toBe(1);
    expect(corner.domain).toBe('a.test.qianwen.com');
  });
});

describe('parseRetError', () => {
  it('splits "Code::message" on the first "::"', () => {
    expect(parseRetError('TOKEN_EXPIRED::Token has expired')).toEqual({
      code: 'TOKEN_EXPIRED',
      message: 'Token has expired',
    });
  });

  it('preserves "::" inside the message', () => {
    expect(parseRetError('CODE::a::b::c')).toEqual({ code: 'CODE', message: 'a::b::c' });
  });

  it('returns the entire input as the code when no separator is present', () => {
    expect(parseRetError('PLAIN_ERR')).toEqual({ code: 'PLAIN_ERR', message: '' });
  });

  it('returns empty fields on empty input', () => {
    expect(parseRetError('')).toEqual({ code: '', message: '' });
  });
});

describe('isSuccessRet', () => {
  it('returns true only for the literal SUCCESS:: prefix', () => {
    expect(isSuccessRet('SUCCESS::ok')).toBe(true);
    expect(isSuccessRet('SUCCESS::')).toBe(true);
  });

  it('rejects all non-success / malformed inputs', () => {
    expect(isSuccessRet('SUCCESS')).toBe(false);
    expect(isSuccessRet('FAILURE::oops')).toBe(false);
    expect(isSuccessRet('')).toBe(false);
    expect(isSuccessRet('success::ok')).toBe(false); // case sensitive
  });

  it('rejects non-string inputs without throwing', () => {
    expect(isSuccessRet(undefined as unknown as string)).toBe(false);
    expect(isSuccessRet(null as unknown as string)).toBe(false);
  });
});

describe('deriveProductCode', () => {
  it('picks the first segment that contains "bailian" (case insensitive)', () => {
    expect(deriveProductCode('zeldaEasy.bailian-platform.api')).toBe('bailian-platform');
    expect(deriveProductCode('foo.BAILIAN-CORE.bar')).toBe('BAILIAN-CORE');
  });

  it('falls back to a sentinel when no segment matches', () => {
    expect(deriveProductCode('zeldaEasy.workspace.api')).toBe('bailian-platform');
    expect(deriveProductCode('')).toBe('bailian-platform');
  });
});
