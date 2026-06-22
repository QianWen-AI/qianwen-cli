/**
 * Tests for the model adapter — pure transformations from raw API model
 * groups / items to Service-layer DTOs.
 */
import { describe, it, expect } from 'vitest';
import {
  transformModelDetail,
  transformModelList,
  transformModelMapping,
  type ModelMappingEntry,
} from '../../../src/api/adapters/model-adapter.js';
import type { ApiModelGroup, ApiModelItem } from '../../../src/types/api-models.js';

function makeApiModelItem(overrides: Partial<ApiModelItem> = {}): ApiModelItem {
  return {
    Model: 'qwen-test',
    Name: 'Qwen Test',
    Description: 'A test model',
    ShortDescription: 'short',
    Category: 'Standard',
    Language: 'zh-CN',
    DataId: 'd1',
    GroupModel: 'TestSeries',
    VersionTag: 'MAJOR',
    ActivationStatus: 1,
    Scope: 'PUBLIC',
    OpenSource: false,
    FreeTierOnly: false,
    NeedApply: false,
    AliyunRecommend: false,
    UpdateAt: '2026-04-01T12:34:56Z',
    LatestOnlineAt: '2026-03-01T00:00:00Z',
    InferenceMetadata: { RequestModality: ['Text'], ResponseModality: ['Text'] },
    Capabilities: [],
    ModelInfo: { ContextWindow: 128000, MaxInputTokens: 120000, MaxOutputTokens: 8000 },
    ContextWindow: 128000,
    MaxInputTokens: 120000,
    MaxOutputTokens: 8000,
    QpmInfo: {
      ModelDefault: {
        UsageLimitField: 'total_tokens',
        CountLimit: 1500,
        Type: 'model-default',
        UsageLimit: 5_000_000,
        CountLimitPeriod: 60,
        UsageLimitPeriod: 60,
      },
    },
    Permissions: { Inference: true } as ApiModelItem['Permissions'],
    Features: [],
    InferenceProvider: 'bailian',
    Provider: 'qwen',
    SampleCodeV2: { OpenAI: '' } as ApiModelItem['SampleCodeV2'],
    ApplyType: 0,
    ...overrides,
  };
}

function makeGroup(items: ApiModelItem[]): ApiModelGroup {
  return {
    Group: true,
    Name: 'TestSeries',
    DataId: 'g1',
    Providers: ['qwen'],
    LatestOnlineAt: '2026-03-01T00:00:00Z',
    InstanceLatestOnlineAt: '2026-03-02T00:00:00Z',
    ActivationStatus: 1,
    UpdateAt: '2026-03-01T00:00:00Z',
    Supports: { Inference: true } as ApiModelGroup['Supports'],
    Language: 'zh-CN',
    Permissions: { Inference: true } as ApiModelGroup['Permissions'],
    Features: [],
    Items: items,
    ApplyType: 0,
  };
}

describe('transformModelList', () => {
  it('flattens groups into Models and reports total = items.length', () => {
    const groups = [
      makeGroup([makeApiModelItem({ Model: 'qwen-a' }), makeApiModelItem({ Model: 'qwen-b' })]),
      makeGroup([makeApiModelItem({ Model: 'qwen-c' })]),
    ];
    const out = transformModelList(groups);
    expect(out.total).toBe(3);
    expect(out.models.map((m) => m.id)).toEqual(['qwen-a', 'qwen-b', 'qwen-c']);
  });

  it('returns total=0 on empty group list', () => {
    expect(transformModelList([])).toEqual({ models: [], total: 0 });
  });

  it('omits free-tier quota by default (list view)', () => {
    const groups = [makeGroup([makeApiModelItem({ Model: 'qwen-a' })])];
    const out = transformModelList(groups);
    expect(out.models[0]!.free_tier.quota).toBeNull();
  });
});

describe('transformModelDetail', () => {
  it('preserves the original ISO 8601 UpdateAt timestamp on metadata.updated', () => {
    const item = makeApiModelItem({ UpdateAt: '2026-04-01T12:34:56Z' });
    const detail = transformModelDetail(item);
    expect(detail.metadata.updated).toBe('2026-04-01T12:34:56Z');
  });

  it('falls back to empty string when UpdateAt is missing', () => {
    const item = makeApiModelItem();
    delete item.UpdateAt;
    const detail = transformModelDetail(item);
    expect(detail.metadata.updated).toBe('');
  });
});

describe('transformModelMapping', () => {
  it('returns a shallow copy keyed by model id', () => {
    const raw: Record<string, ModelMappingEntry> = {
      'qwen-a': { snapshot: 'qwen-a-2026-04-01' },
      'qwen-b': { snapshot: 'qwen-b-2026-04-01', deprecated: true },
    };
    const out = transformModelMapping(raw);
    expect(out).toEqual(raw);
    // Mutating the copy does not affect the source.
    out['qwen-a']!.snapshot = 'mutated';
    expect(raw['qwen-a']!.snapshot).toBe('qwen-a-2026-04-01');
  });

  it('preserves extra unknown fields verbatim', () => {
    const raw: Record<string, ModelMappingEntry> = {
      'qwen-a': { snapshot: 's', deprecated: false, customFlag: 'xyz' },
    };
    const out = transformModelMapping(raw);
    expect(out['qwen-a']).toEqual({ snapshot: 's', deprecated: false, customFlag: 'xyz' });
  });

  it('returns an empty object for an empty input', () => {
    expect(transformModelMapping({})).toEqual({});
  });
});
