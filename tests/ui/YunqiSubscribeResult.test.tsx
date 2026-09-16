import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { YunqiSubscribeResultInk } from '../../src/ui/YunqiSubscribeResult.js';
import { buildForumSubscribeViewModel } from '../../src/view-models/yunqi/forum-subscribe.js';
import type { ForumSubscriptionAction } from '../../src/view-models/yunqi/index.js';

function frame(success: boolean, action: ForumSubscriptionAction) {
  const vm = buildForumSubscribeViewModel({ success }, action);
  const { lastFrame } = render(<YunqiSubscribeResultInk vm={vm} />);
  return lastFrame() ?? '';
}

describe('<YunqiSubscribeResultInk />', () => {
  it.each([
    ['subscribe', true, 'Successfully subscribed to forum.'],
    ['subscribe', false, 'Failed to subscribe to forum.'],
    ['unsubscribe', true, 'Successfully unsubscribed from forum.'],
    ['unsubscribe', false, 'Failed to unsubscribe from forum.'],
  ] as const)('%s / success=%s 渲染对应文案', (action, success, expected) => {
    expect(stripAnsi(frame(success, action))).toBe(expected);
  });

  it('退订文案不含 subscribed to 字样', () => {
    for (const success of [true, false]) {
      expect(stripAnsi(frame(success, 'unsubscribe'))).not.toMatch(/subscribed to/);
    }
  });

  it('成功与失败渲染出不同的颜色标记', () => {
    const ok = frame(true, 'subscribe');
    const failed = frame(false, 'subscribe');
    expect(ok).not.toBe(failed);
    expect(stripAnsi(ok)).not.toBe(stripAnsi(failed));
  });
});
