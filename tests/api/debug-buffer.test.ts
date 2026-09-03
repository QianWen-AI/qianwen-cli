import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDebugHttp = process.env.DEBUG_HTTP;
process.env.DEBUG_HTTP = 'full';

const { addDiagnostic, clearDebugBuffer, endRequest, flushDebugReport, startRequest } =
  await import('../../src/api/debug-buffer.js');

describe('HTTP debug buffer payment redaction', () => {
  beforeEach(() => {
    clearDebugBuffer();
  });

  afterEach(() => {
    clearDebugBuffer();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (originalDebugHttp === undefined) delete process.env.DEBUG_HTTP;
    else process.env.DEBUG_HTTP = originalDebugHttp;
  });

  it('redacts Nbid from request, response, diagnostics, and the flushed report', () => {
    const nbid = 'nbid/value+debug-1';
    const encodedNbid = encodeURIComponent(nbid);
    const orderId = 'order-visible-debug-1';
    const paymentUrl = 'https://pay.test.qianwenai.com/checkout/order-visible-debug-1';
    const requestBody = JSON.stringify({
      product: 'BssOpenAPI-V3',
      action: 'GetRechargeResult',
      params: { Nbid: nbid, ChargeOrderId: orderId },
    });
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const requestId = startRequest(
      'POST',
      `https://api.test.qianwenai.com/data/v2/api.json?account=${encodedNbid}`,
      { 'Content-Type': 'application/json', Nbid: nbid },
      requestBody,
      'recharge-test',
    );
    endRequest(
      requestId,
      200,
      `OK for ${nbid}`,
      JSON.stringify({
        data: { Nbid: nbid, ChargeOrderId: orderId, RechargeUrl: paymentUrl },
        message: `account ${nbid} (${encodedNbid}) completed`,
      }),
      false,
      JSON.parse(requestBody),
    );
    addDiagnostic('Recharge', `Nbid=${nbid}; order=${orderId}; paymentUrl=${paymentUrl}`, 'warn');

    flushDebugReport();

    const report = stderrSpy.mock.calls.map(([value]) => String(value)).join('\n');
    expect(report.includes(nbid)).toBe(false);
    expect(report.includes(encodedNbid)).toBe(false);
    expect(report).toContain('[REDACTED]');
    expect(report).toContain('BssOpenAPI-V3/GetRechargeResult');
    expect(report).toContain(orderId);
    expect(report).toContain(paymentUrl);
    expect(report).toContain('Total requests: 1 | Successful: 1 | Failed: 0');
  });

  it('redacts a response Nbid discovered only from request context', () => {
    const nbid = 'nbid-response-context-2';
    const requestBody = JSON.stringify({
      product: 'BssOpenAPI-V3',
      action: 'GetRechargeUrl',
      params: { Nbid: nbid },
    });
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requestId = startRequest(
      'POST',
      'https://api.test.qianwenai.com/data/v2/api.json',
      {},
      requestBody,
    );

    endRequest(
      requestId,
      500,
      `Failed for ${nbid}`,
      `The billing account ${nbid} is unavailable`,
      true,
      JSON.parse(requestBody),
    );
    flushDebugReport();

    const report = stderrSpy.mock.calls.map(([value]) => String(value)).join('\n');
    expect(report.includes(nbid)).toBe(false);
    expect(report).toContain('Failed for [REDACTED]');
    expect(report).toContain('The billing account [REDACTED] is unavailable');
    expect(report).toContain('Failed: 1');
  });
});
