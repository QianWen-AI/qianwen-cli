/**
 * Unit tests for the call-log retrieval method on UsageService.
 *
 * The Service is expected to:
 *   1. Translate option strings (from / to) into millisecond timestamps.
 *   2. Forward the array filters (models, statusCodeTypes) verbatim.
 *   3. Default page=1 and pageSize=20 when omitted; clamp pageSize to ≤100.
 *   4. Bypass other filters when modelRequestId is supplied (exact match).
 *   5. Pass the gateway envelope through the configured ApiClient method.
 *   6. Surface upstream errors as plain Error instances (no swallow).
 *   7. Tolerate empty result sets without throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UsageLogsResponse } from '../../src/types/usage.js';
import { UsageService } from '../../src/services/usage-service.js';
import { makeMockCachedFetcher } from '../helpers/service-mocks.js';
import type { ApiClient } from '../../src/api/api-client.js';
import type { BillingService } from '../../src/services/billing-service.js';
import type { FreetierService } from '../../src/services/freetier-service.js';
import type { TokenplanService } from '../../src/services/tokenplan-service.js';

interface MockApiClient {
  callFlatApi: ReturnType<typeof vi.fn>;
  callEnvelopeApi: ReturnType<typeof vi.fn>;
}

function makeMockApiClient(): MockApiClient {
  return { callFlatApi: vi.fn(), callEnvelopeApi: vi.fn() };
}

function makeStubService<T>(): T {
  // Cross-service composition is not exercised by getUsageLogs; stub each
  // collaborator with vi.fn() so the four-arg constructor stays satisfied.
  return new Proxy({}, { get: () => vi.fn() }) as T;
}

function makeRawEnvelopeBody(
  list: unknown[] = [],
  totalCount = list.length,
  maxResults = 20,
): unknown {
  return { totalCount, maxResults, list };
}

function makeRawListItem(overrides: Record<string, unknown> = {}): unknown {
  return {
    originLog: {
      request_id: '9f2c6a40-1234-4abc-9def-0000000000a1bd',
      model: 'qwen3.6-plus',
      start_time: '2026-05-23 14:32:17.000',
      status_code: '200',
      duration: '1234',
      ...overrides,
    },
    formattedUsages: [
      { unit: 'tokens', value: 100, key: 'input_tokens' },
      { unit: 'tokens', value: 50, key: 'output_tokens' },
      { unit: 'tokens', value: 150, key: 'total_tokens' },
    ],
  };
}

describe('UsageService.getUsageLogs', () => {
  let apiClient: MockApiClient;
  let service: UsageService;

  beforeEach(() => {
    apiClient = makeMockApiClient();
    service = new UsageService(
      apiClient as unknown as ApiClient,
      makeStubService<BillingService>(),
      makeStubService<FreetierService>(),
      makeStubService<TokenplanService>(),
      makeMockCachedFetcher(),
    );
  });

  describe('time-range mapping', () => {
    it('forwards from/to as millisecond timestamps in the gateway data payload', async () => {
      apiClient.callEnvelopeApi.mockResolvedValue(makeRawEnvelopeBody([]));

      await service.getUsageLogs({
        from: '2026-05-22T14:00:00.000Z',
        to: '2026-05-23T14:00:00.000Z',
      });

      expect(apiClient.callEnvelopeApi).toHaveBeenCalledTimes(1);
      const arg = apiClient.callEnvelopeApi.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(arg.data.startTime).toBe(Date.parse('2026-05-22T14:00:00.000Z'));
      expect(arg.data.endTime).toBe(Date.parse('2026-05-23T14:00:00.000Z'));
    });

    it('translates date-only strings (YYYY-MM-DD) into UTC midnight ms', async () => {
      apiClient.callEnvelopeApi.mockResolvedValue(makeRawEnvelopeBody([]));

      await service.getUsageLogs({ from: '2026-05-22', to: '2026-05-23' });

      const arg = apiClient.callEnvelopeApi.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(typeof arg.data.startTime).toBe('number');
      expect(typeof arg.data.endTime).toBe('number');
      expect(arg.data.endTime as number).toBeGreaterThan(arg.data.startTime as number);
    });
  });

  describe('filter forwarding', () => {
    it('forwards models[] and statusCodeTypes[] arrays verbatim', async () => {
      apiClient.callEnvelopeApi.mockResolvedValue(makeRawEnvelopeBody([]));

      await service.getUsageLogs({
        from: '2026-05-22',
        to: '2026-05-23',
        models: ['qwen3.6-plus', 'qwen-vl-max'],
        statusCodeTypes: ['CLIENT_ERROR', 'SERVER_ERROR'],
      });

      const arg = apiClient.callEnvelopeApi.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(arg.data.models).toEqual(['qwen3.6-plus', 'qwen-vl-max']);
      expect(arg.data.statusCodeTypes).toEqual(['CLIENT_ERROR', 'SERVER_ERROR']);
    });

    it('applies modelRequestId for exact match', async () => {
      apiClient.callEnvelopeApi.mockResolvedValue(makeRawEnvelopeBody([]));

      await service.getUsageLogs({
        from: '2026-05-22',
        to: '2026-05-23',
        modelRequestId: 'abcd-1234',
      });

      const arg = apiClient.callEnvelopeApi.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(arg.data.modelRequestId).toBe('abcd-1234');
    });
  });

  describe('pagination defaults', () => {
    it('defaults page=1 and pageSize=20 when omitted', async () => {
      apiClient.callEnvelopeApi.mockResolvedValue(makeRawEnvelopeBody([]));

      await service.getUsageLogs({ from: '2026-05-22', to: '2026-05-23' });

      const arg = apiClient.callEnvelopeApi.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(arg.data.maxResults).toBe(20);
      expect(arg.data.skip).toBe(0);
    });

    it('clamps pageSize to the documented upper bound (100)', async () => {
      apiClient.callEnvelopeApi.mockResolvedValue(makeRawEnvelopeBody([]));

      await service.getUsageLogs({ from: '2026-05-22', to: '2026-05-23', pageSize: 500 });

      const arg = apiClient.callEnvelopeApi.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(arg.data.maxResults).toBe(100);
      expect(arg.data.skip).toBe(0);
    });
  });

  describe('response handling', () => {
    it('returns the parsed UsageLogsResponse on success', async () => {
      const raw = makeRawEnvelopeBody([makeRawListItem()]);
      apiClient.callEnvelopeApi.mockResolvedValue(raw);

      const result: UsageLogsResponse = await service.getUsageLogs({
        from: '2026-05-22',
        to: '2026-05-23',
      });

      expect(result.totalCount).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].requestId).toBe('9f2c6a40-1234-4abc-9def-0000000000a1bd');
      expect(result.items[0].statusCode).toBe(200);
    });

    it('returns an empty list without throwing', async () => {
      apiClient.callEnvelopeApi.mockResolvedValue(makeRawEnvelopeBody([], 0));

      const result = await service.getUsageLogs({ from: '2026-05-22', to: '2026-05-23' });

      expect(result.totalCount).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('propagates upstream errors as plain Error', async () => {
      apiClient.callEnvelopeApi.mockRejectedValue(new Error('GatewayError: upstream timeout'));

      await expect(
        service.getUsageLogs({ from: '2026-05-22', to: '2026-05-23' }),
      ).rejects.toThrow(/upstream timeout/);
    });
  });
});
