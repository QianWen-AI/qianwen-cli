import type { ForumSubscribeResult } from '../../types/yunqi.js';

export type ForumSubscriptionAction = 'subscribe' | 'unsubscribe';

export interface ForumSubscribeViewModel {
  success: boolean;
  message: string;
}

const PHRASES: Record<ForumSubscriptionAction, { success: string; failure: string }> = {
  subscribe: {
    success: 'Successfully subscribed to forum.',
    failure: 'Failed to subscribe to forum.',
  },
  unsubscribe: {
    success: 'Successfully unsubscribed from forum.',
    failure: 'Failed to unsubscribe from forum.',
  },
};

export function buildForumSubscribeViewModel(
  result: ForumSubscribeResult,
  action: ForumSubscriptionAction,
): ForumSubscribeViewModel {
  return {
    success: result.success,
    message: result.success ? PHRASES[action].success : PHRASES[action].failure,
  };
}
