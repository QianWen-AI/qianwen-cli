/**
 * Tests for model-level retirement semantics derived from ListModelSeries
 * `offlineInfo.inference`, plus the way the list/detail view models surface it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isModelRetiring,
  modelRetireTime,
  modelRetireDateLong,
  resolveAnnouncementUrl,
  parseOfflineTime,
  RETIRE_NOTICE_WINDOW_MS,
} from '../../src/services/model-lifecycle.js';
import { ANNOUNCEMENT_URL } from '../../src/services/model-deprecation-source.js';
import {
  buildModelListViewModelFromModels,
  buildModelDetailViewModel,
} from '../../src/view-models/models.js';
import type { Model, ModelDetail } from '../../src/types/model.js';

const NOW = Date.parse('2026-06-01T00:00:00+08:00');

function listModel(id: string, offlineTime?: string): Model {
  return {
    id,
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: { mode: 'standard', quota: null },
    ...(offlineTime
      ? { lifecycle: { status: 'retiring' as const, offline_time: offlineTime } }
      : {}),
  };
}

function detailModel(id: string, offlineTime?: string): ModelDetail {
  return {
    ...listModel(id, offlineTime),
    description: 'x',
    tags: [],
    features: [],
    pricing: { per_token: { price: 1, unit: 'CNY/1M tokens' } },
    rate_limits: { rpm: 1 },
    metadata: { version_tag: 'MAJOR', open_source: false, updated: '2026-08-25' },
  };
}

describe('parseOfflineTime', () => {
  it('parses ISO-8601 and `yyyy-MM-dd HH:mm:ss`, rejecting malformed input', () => {
    expect(parseOfflineTime('2026-10-10T23:59:59+08:00')).toBe(
      Date.parse('2026-10-10T23:59:59+08:00'),
    );
    expect(parseOfflineTime('2026-10-10 23:59:59')).toBe(Date.parse('2026-10-10T23:59:59'));
    expect(parseOfflineTime('')).toBeNull();
    expect(parseOfflineTime(undefined)).toBeNull();
    expect(parseOfflineTime('not-a-date')).toBeNull();
  });
});

describe('model retirement predicates', () => {
  it('flags a future-dated model within the 90-day window as retiring', () => {
    expect(isModelRetiring(listModel('a', '2026-06-20T23:59:59+08:00'), NOW)).toBe(true);
    expect(isModelRetiring(listModel('b', '2026-01-01T00:00:00+08:00'), NOW)).toBe(false);
    expect(isModelRetiring(listModel('c'), NOW)).toBe(false);
  });

  it('returns false when the offline time is beyond the 90-day window', () => {
    expect(isModelRetiring(listModel('d', '2026-10-01T23:59:59+08:00'), NOW)).toBe(false);
  });

  it('returns true at the exact 90-day boundary', () => {
    const exactly30d = new Date(NOW + RETIRE_NOTICE_WINDOW_MS).toISOString();
    expect(isModelRetiring(listModel('e', exactly30d), NOW)).toBe(true);
  });

  it('returns false at one millisecond past the 90-day boundary', () => {
    const just31d = new Date(NOW + RETIRE_NOTICE_WINDOW_MS + 1).toISOString();
    expect(isModelRetiring(listModel('f', just31d), NOW)).toBe(false);
  });

  it('exposes the raw retirement time and long date only while retiring', () => {
    expect(modelRetireTime(listModel('a', '2026-06-20T23:59:59+08:00'), NOW)).toBe(
      '2026-06-20T23:59:59+08:00',
    );
    expect(modelRetireDateLong(listModel('a', '2026-06-20T23:59:59+08:00'), NOW)).toBe(
      'June 20, 2026',
    );
    expect(modelRetireTime(listModel('b', '2026-01-01T00:00:00+08:00'), NOW)).toBeNull();
    expect(modelRetireTime(listModel('c', '2026-10-10T23:59:59+08:00'), NOW)).toBeNull();
  });

  it('always surfaces the site announcement anchor', () => {
    expect(resolveAnnouncementUrl()).toBe(ANNOUNCEMENT_URL);
  });
});

describe('list view model retirement markers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks retiring rows and reports hasRetiring', () => {
    vi.useFakeTimers({ now: NOW });
    const vm = buildModelListViewModelFromModels([
      listModel('qwen-retiring', '2026-06-20T23:59:59+08:00'),
      listModel('qwen-plus'),
    ]);
    expect(vm.hasRetiring).toBe(true);
    expect(vm.rows[0].retiring).toBe(true);
    expect(vm.rows[1].retiring).toBe(false);
  });

  it('reports no retiring rows when none are scheduled', () => {
    const vm = buildModelListViewModelFromModels([listModel('qwen-plus')]);
    expect(vm.hasRetiring).toBe(false);
  });
});

describe('detail view model retirement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows RETIRING lifecycle and a notice for a retiring model', () => {
    vi.useFakeTimers({ now: NOW });
    const vm = buildModelDetailViewModel(detailModel('qwen-retiring', '2026-06-20T23:59:59+08:00'));
    expect(vm.lifecycle).toBe('RETIRING · June 20, 2026');
    expect(vm.notice).toBe(
      `This model will be retired on June 20, 2026, learn more at Announcement: ${ANNOUNCEMENT_URL}`,
    );
  });

  it('omits lifecycle and notice for a normal model', () => {
    const vm = buildModelDetailViewModel(detailModel('qwen-plus'));
    expect(vm.lifecycle).toBeUndefined();
    expect(vm.notice).toBeUndefined();
  });
});
