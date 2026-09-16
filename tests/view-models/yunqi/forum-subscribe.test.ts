import { describe, it, expect } from 'vitest';
import { buildForumSubscribeViewModel } from '../../../src/view-models/yunqi/forum-subscribe.js';

describe('buildForumSubscribeViewModel', () => {
  it('订阅成功时使用 subscribed 文案', () => {
    const vm = buildForumSubscribeViewModel({ success: true }, 'subscribe');
    expect(vm).toEqual({ success: true, message: 'Successfully subscribed to forum.' });
  });

  it('订阅失败时使用 subscribe 文案', () => {
    const vm = buildForumSubscribeViewModel({ success: false }, 'subscribe');
    expect(vm).toEqual({ success: false, message: 'Failed to subscribe to forum.' });
  });

  it('退订成功时使用 unsubscribed 文案', () => {
    const vm = buildForumSubscribeViewModel({ success: true }, 'unsubscribe');
    expect(vm).toEqual({ success: true, message: 'Successfully unsubscribed from forum.' });
  });

  it('退订失败时使用 unsubscribe 文案', () => {
    const vm = buildForumSubscribeViewModel({ success: false }, 'unsubscribe');
    expect(vm).toEqual({ success: false, message: 'Failed to unsubscribe from forum.' });
  });

  it('退订文案不含 subscribed 字样', () => {
    for (const success of [true, false]) {
      const { message } = buildForumSubscribeViewModel({ success }, 'unsubscribe');
      expect(message).not.toMatch(/subscribed to/);
    }
  });
});
