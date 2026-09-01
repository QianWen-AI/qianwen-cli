/** Types for the chat modality: messages, content parts, and normalized results. */

import type { StreamChunk, TokenUsage } from './model-invocation.js';

export interface ChatContentPart {
  type: 'text' | 'image_url' | 'video_url';
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
}

/** Normalized streaming event; reuses the discriminated union shape of StreamChunk. */
export type ChatStreamEvent = StreamChunk;

export interface ChatResult {
  requestId?: string;
  usage?: TokenUsage;
  data: Record<string, unknown>;
}
