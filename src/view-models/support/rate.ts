import { formatStatus } from './shared.js';

export interface SupportRateViewModel {
  ticketId: string;
  rating: number;
  ratingLabel: string;
  ratingVisual: string;
  comment?: string;
  status: string;
  statusLabel: string;
  timestamp: string;
}

const RATING_LABELS: Record<number, string> = {
  0: '不满意',
  1: '一般',
  2: '满意',
};

const RATING_VISUALS: Record<number, string> = {
  0: '😥',
  1: '🙂',
  2: '😊',
};

const MAX_RATING = 2;

export function buildRatingVisual(rating: number): string {
  const clamped = clampRating(rating);
  return RATING_VISUALS[clamped] ?? '';
}

export function getRatingLabel(rating: number): string {
  return RATING_LABELS[clampRating(rating)] ?? '';
}

function clampRating(rating: number): number {
  if (!Number.isFinite(rating)) return 0;
  if (rating < 0) return 0;
  if (rating > MAX_RATING) return MAX_RATING;
  return Math.round(rating);
}

export function buildSupportRateViewModel(
  ticketId: string,
  rating: number,
  comment?: string,
  timestamp?: string,
): SupportRateViewModel {
  const normalizedComment = typeof comment === 'string' && comment.length > 0 ? comment : undefined;
  return {
    ticketId,
    rating,
    ratingLabel: getRatingLabel(rating),
    ratingVisual: buildRatingVisual(rating),
    comment: normalizedComment,
    status: 'score',
    statusLabel: formatStatus('score'),
    timestamp: timestamp ?? new Date().toISOString(),
  };
}
