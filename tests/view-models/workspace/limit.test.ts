import { describe, it, expect } from 'vitest';
import { buildWorkspaceLimitViewModel } from '../../../src/view-models/workspace/limit.js';

describe('buildWorkspaceLimitViewModel', () => {
  it('computes remaining and utilization for typical input', () => {
    const vm = buildWorkspaceLimitViewModel({ current: 3, max: 10 });
    expect(vm.current).toBe(3);
    expect(vm.max).toBe(10);
    expect(vm.remaining).toBe(7);
    expect(vm.utilizationPct).toBe(30);
  });

  it('rounds utilization to nearest integer', () => {
    // 1/3 = 33.33% → rounded to 33
    const vm = buildWorkspaceLimitViewModel({ current: 1, max: 3 });
    expect(vm.utilizationPct).toBe(33);
  });

  it('returns 0% utilization when max is zero (avoids division-by-zero)', () => {
    const vm = buildWorkspaceLimitViewModel({ current: 0, max: 0 });
    expect(vm.utilizationPct).toBe(0);
    expect(vm.remaining).toBe(0);
  });

  it('clamps negative current and max to zero', () => {
    const vm = buildWorkspaceLimitViewModel({ current: -5, max: -10 });
    expect(vm.current).toBe(0);
    expect(vm.max).toBe(0);
    expect(vm.remaining).toBe(0);
    expect(vm.utilizationPct).toBe(0);
  });

  it('clamps remaining to zero when current exceeds max (overflow)', () => {
    const vm = buildWorkspaceLimitViewModel({ current: 15, max: 10 });
    expect(vm.remaining).toBe(0);
    expect(vm.utilizationPct).toBe(150);
  });

  it('returns 100% when current equals max', () => {
    const vm = buildWorkspaceLimitViewModel({ current: 5, max: 5 });
    expect(vm.utilizationPct).toBe(100);
    expect(vm.remaining).toBe(0);
  });

  it('handles zero current with positive max', () => {
    const vm = buildWorkspaceLimitViewModel({ current: 0, max: 20 });
    expect(vm.remaining).toBe(20);
    expect(vm.utilizationPct).toBe(0);
  });
});
