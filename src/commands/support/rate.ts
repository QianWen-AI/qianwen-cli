import React from 'react';
import { resolveFormat } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError, HandledError, invalidArgError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { createServices } from '../../services/index.js';
import { withSpinner } from '../../ui/spinner.js';
import { renderInteractive } from '../../ui/render.js';
import { releaseOrKeepStdin } from '../../utils/stdin-control.js';
import { multilineInput } from '../../utils/multiline-input.js';
import { RatingSelector } from '../../ui/RatingSelector.js';
import { TagSelector } from '../../ui/TagSelector.js';
import { buildSupportRateViewModel } from '../../view-models/support/index.js';
import type { SupportRateViewModel } from '../../view-models/support/index.js';
import type { AssessmentCardData } from '../../types/support.js';

const COMMENT_MAX_LENGTH = 500;

export interface SupportRateOptions {
  rating?: string | number;
  comment?: string;
  format?: string;
}

export async function supportRateAction(
  ticketId: string,
  options: SupportRateOptions,
): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    const ratingFlag = parseRatingFlag(options.rating);
    let comment = sanitizeComment(options.comment);

    if (ratingFlag === undefined && !process.stdin.isTTY) {
      throw invalidArgError('Rating is required in non-interactive mode. Use --rating <0-2>.');
    }

    ensureAuthenticated();
    const services = createServices();
    const { supportService } = services;

    const ticket = await withSpinner(
      'Fetching ticket',
      () => supportService.getTicket(ticketId),
      format,
    );
    if (!ticket || !ticket.id) {
      throw invalidArgError(`Ticket not found: ${ticketId}`);
    }

    const cardData: AssessmentCardData = await withSpinner(
      'Checking rating eligibility',
      () => supportService.getAssessmentCard(ticketId),
      format,
    );
    if (cardData.alreadyRated) {
      notifyAlreadyRated(ticketId, cardData.satisfaction, format);
      throw new HandledError(EXIT_CODES.SUCCESS);
    }
    if (!cardData.hasCard) {
      throw invalidArgError(
        `Ticket ${ticketId} is not awaiting rating (it may not be closed yet).`,
      );
    }
    if (!cardData.editable) {
      throw invalidArgError(`Ticket ${ticketId} is not available for rating.`);
    }

    const isInteractive = ratingFlag === undefined;

    let rating: number;
    if (ratingFlag !== undefined) {
      rating = ratingFlag;
    } else {
      const interactive = await promptRatingInteractive();
      if (interactive === null) {
        notifyCancelled(ticketId, format);
        return;
      }
      rating = interactive;
    }

    let tags: { good?: string[]; bad?: string[] } | undefined;
    if (isInteractive) {
      if (rating < 2) {
        const selectedTags = await promptTagsInteractive(cardData.badTags, true);
        if (selectedTags === null) {
          notifyCancelled(ticketId, format);
          return;
        }
        if (selectedTags.length > 0) {
          tags = { bad: selectedTags };
        }
      } else {
        const selectedTags = await promptTagsInteractive(cardData.goodTags, false);
        if (selectedTags === null) {
          notifyCancelled(ticketId, format);
          return;
        }
        if (selectedTags.length > 0) {
          tags = { good: selectedTags };
        }
      }
    }

    if (isInteractive && !comment) {
      comment = await promptCommentInteractive();
    }

    const {
      editable: _editable,
      hasCard: _hasCard,
      alreadyRated: _alreadyRated,
      satisfaction: _satisfaction,
      goodTags: _goodTags,
      badTags: _badTags,
      ...metadata
    } = cardData;
    void _editable;
    void _hasCard;
    void _alreadyRated;
    void _satisfaction;
    void _goodTags;
    void _badTags;
    const result = await withSpinner(
      'Submitting rating',
      () => supportService.rateTicket(ticketId, rating, comment, metadata, tags),
      format,
    );

    const vm = buildSupportRateViewModel(ticketId, rating, comment, result?.timestamp);
    emitResult(vm, format);
  } catch (error) {
    if (error instanceof HandledError) throw error;
    handleError(error, format);
  }
}

function parseRatingFlag(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 2) {
    throw invalidArgError('Invalid --rating value. Must be an integer between 0 and 2.');
  }
  return value;
}

function sanitizeComment(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= COMMENT_MAX_LENGTH) return trimmed;
  process.stderr.write(
    `Warning: Comment exceeds ${COMMENT_MAX_LENGTH} characters and was truncated.\n`,
  );
  return trimmed.slice(0, COMMENT_MAX_LENGTH);
}

async function promptRatingInteractive(): Promise<number | null> {
  let chosen: number | null = null;
  await renderInteractive(
    React.createElement(RatingSelector, {
      onSelect: (value: number) => {
        chosen = value;
      },
      onCancel: () => {
        chosen = null;
      },
    }),
  );

  // Yield one tick so Ink releases stdin before downstream readline runs.
  await new Promise((resolve) => setImmediate(resolve));
  releaseOrKeepStdin();
  return chosen;
}

async function promptTagsInteractive(
  tagOptions: string[],
  required: boolean,
): Promise<string[] | null> {
  let chosen: string[] | null = null;
  let cancelled = false;
  await renderInteractive(
    React.createElement(TagSelector, {
      tags: tagOptions,
      required,
      onSelect: (selected: string[]) => {
        chosen = selected;
      },
      onCancel: () => {
        cancelled = true;
        chosen = null;
      },
    }),
  );

  await new Promise((resolve) => setImmediate(resolve));
  releaseOrKeepStdin();
  return cancelled ? null : (chosen ?? []);
}

async function promptCommentInteractive(): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;

  const raw = await multilineInput({
    title: '添加评论（可选）',
    placeholder: '在此输入评论。Tab 切换到按钮，Enter 提交。',
  });
  return sanitizeComment(raw);
}

function emitResult(vm: SupportRateViewModel, format: 'json' | 'table' | 'text'): void {
  if (format === 'json') {
    printJSON({
      ticketId: vm.ticketId,
      rating: vm.rating,
      ratingLabel: vm.ratingLabel,
      comment: vm.comment ?? null,
      status: vm.status,
      statusLabel: vm.statusLabel,
      timestamp: vm.timestamp,
    });
    return;
  }

  if (format === 'text') {
    console.log(`Rating submitted for ticket ${vm.ticketId}`);
    console.log(`Rating: ${vm.rating}/2 (${vm.ratingLabel})`);
    console.log(`Comment: ${vm.comment ?? '(none)'}`);
    console.log(`Status: ${vm.statusLabel}`);
    return;
  }

  // table
  console.log(`\u2714  Ticket ${vm.ticketId} rated successfully`);
  console.log(`  Rating:  ${vm.ratingVisual} ${vm.ratingLabel}`);
  if (vm.comment) {
    console.log(`  Comment: ${vm.comment}`);
  }
  console.log(`  Status:  ${vm.statusLabel}`);
}

function notifyCancelled(ticketId: string, format: 'json' | 'table' | 'text'): void {
  if (format === 'json') {
    printJSON({ ticketId, cancelled: true });
    return;
  }
  console.log('Operation cancelled.');
}

function notifyAlreadyRated(
  ticketId: string,
  satisfaction: number | undefined,
  format: 'json' | 'table' | 'text',
): void {
  if (format === 'json') {
    printJSON({ ticketId, alreadyRated: true, satisfaction });
    return;
  }
  console.log(`Ticket ${ticketId} has already been rated (${satisfaction}/2).`);
}
