/**
 * Unit tests for buildUsageLogsViewModel — pure data transformation tests.
 */
import { describe, it, expect } from 'vitest';
import { buildUsageLogsViewModel } from '../../src/view-models/usage-logs.js';
import type { UsageLogsResponse, UsageLogItem } from '../../src/types/usage.js';

function makeItem(overrides: Partial<UsageLogItem> = {}): UsageLogItem {
  return {
    requestId: '9f2c6a40-1234-4abc-9def-0000000000a1bd',
    model: 'qwen3.6-plus',
    createdAt: '2026-05-23T14:32:17+08:00',
    statusCode: 200,
    durationMs: 1234,
    firstOutputDurationMs: 456,
    errorCode: null,
    usages: [
      { key: 'input', value: 100 },
      { key: 'output', value: 50 },
      { key: 'total', value: 150 },
    ],
    ...overrides,
  };
}

function makeResponse(
  items: UsageLogItem[],
  overrides: Partial<UsageLogsResponse> = {},
): UsageLogsResponse {
  return {
    totalCount: items.length,
    page: 1,
    pageSize: 20,
    period: { from: '2026-05-22T14:00:00.000Z', to: '2026-05-23T14:00:00.000Z' },
    items,
    ...overrides,
  };
}

describe('buildUsageLogsViewModel', () => {
  it('renders the period label in the documented format', () => {
    const vm = buildUsageLogsViewModel(makeResponse([makeItem()]));
    expect(vm.periodLabel).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  describe('statusColor mapping', () => {
    it('maps 2xx → green', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ statusCode: 200 })]));
      expect(vm.items[0].statusColor).toBe('green');
    });

    it('maps 4xx → yellow', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ statusCode: 429 })]));
      expect(vm.items[0].statusColor).toBe('yellow');
    });

    it('maps 5xx → red', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ statusCode: 503 })]));
      expect(vm.items[0].statusColor).toBe('red');
    });
  });

  describe('requestId passthrough', () => {
    it('preserves the full identifier without truncation', () => {
      const fullId = 'abcdefgh-ijkl-mnop-qrst-uvwxyz010203';
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ requestId: fullId })]));
      expect(vm.items[0].requestId).toBe(fullId);
    });

    it('falls back to em-dash when the upstream id is empty', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ requestId: '' })]));
      expect(vm.items[0].requestId).toBe('—');
    });
  });

  describe('latency display', () => {
    it('renders sub-second latencies in milliseconds (e.g., "40 ms")', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ durationMs: 40 })]));
      expect(vm.items[0].latencyDisplay).toMatch(/40\s*ms/);
    });

    it('renders ≥1s latencies in seconds with two decimals (e.g., "1.23 s")', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ durationMs: 1234 })]));
      expect(vm.items[0].latencyDisplay).toMatch(/1\.2\d\s*s/);
    });
  });

  describe('time rendering', () => {
    it('renders local-timezone ISO8601 as "YYYY-MM-DD HH:MM:SS" without offset', () => {
      const vm = buildUsageLogsViewModel(
        makeResponse([makeItem({ createdAt: '2026-05-26T17:06:45+08:00' })]),
      );
      expect(vm.items[0].time).toBe('2026-05-26 17:06:45');
      expect(vm.items[0].shortTime).toBe('17:06:45');
    });

    it('extracts shortTime from ISO8601 timestamps with trailing Z', () => {
      const vm = buildUsageLogsViewModel(
        makeResponse([makeItem({ createdAt: '2026-05-27T10:46:45Z' })]),
      );
      expect(vm.items[0].time).toBe('2026-05-27 10:46:45');
      expect(vm.items[0].shortTime).toBe('10:46:45');
    });

    it('extracts shortTime from ISO8601 timestamps without trailing designator', () => {
      const vm = buildUsageLogsViewModel(
        makeResponse([makeItem({ createdAt: '2026-05-27T10:46:45' })]),
      );
      expect(vm.items[0].time).toBe('2026-05-27 10:46:45');
      expect(vm.items[0].shortTime).toBe('10:46:45');
    });

    it('falls back to em-dash for both fields when createdAt is empty', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ createdAt: '' })]));
      expect(vm.items[0].time).toBe('—');
      expect(vm.items[0].shortTime).toBe('—');
    });
  });

  describe('usage column', () => {
    it('renders empty usage array as em-dash', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ usages: [] })]));
      expect(vm.items[0].usage).toBe('—');
    });

    it('joins positive entries as "key: value" separated by commas', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem()]));
      expect(vm.items[0].usage).toBe('input: 100, output: 50, total: 150');
    });

    it('preserves single-entry usage payloads (e.g., image generation)', () => {
      const vm = buildUsageLogsViewModel(
        makeResponse([makeItem({ usages: [{ key: 'image', value: 1 }] })]),
      );
      expect(vm.items[0].usage).toBe('image: 1');
    });
  });

  describe('errorCode propagation', () => {
    it('preserves null for successful calls', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem()]));
      expect(vm.items[0].errorCode).toBeNull();
    });

    it('preserves string error codes', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem({ errorCode: 'Throttling.User' })]));
      expect(vm.items[0].errorCode).toBe('Throttling.User');
    });
  });

  describe('pagination', () => {
    it('computes pageCount = ceil(totalCount / pageSize)', () => {
      const vm = buildUsageLogsViewModel(
        makeResponse([], { totalCount: 150, page: 1, pageSize: 20 }),
      );
      expect(vm.pageCount).toBe(8);
    });

    it('sets isEmpty=true when totalCount is 0', () => {
      const vm = buildUsageLogsViewModel(makeResponse([], { totalCount: 0 }));
      expect(vm.isEmpty).toBe(true);
    });

    it('sets isEmpty=false when there are rows', () => {
      const vm = buildUsageLogsViewModel(makeResponse([makeItem()]));
      expect(vm.isEmpty).toBe(false);
    });
  });
});
