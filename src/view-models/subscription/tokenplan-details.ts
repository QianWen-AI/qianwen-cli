import { stripVTControlCharacters } from 'node:util';
import type { TokenPlanListSection } from '../../types/tokenplan-catalog.js';
import type { TokenPlanSupportedModel } from '../../types/tokenplan-benefits.js';
import type { TokenPlanStatusResult } from '../../types/tokenplan-subscription.js';
import { formatAsiaShanghaiDate } from '../../utils/date.js';
import { DecimalAmount } from '../../utils/decimal-amount.js';
import { sortTokenPlanSeats } from './tokenplan-seat-details.js';

export interface TokenPlanDisplayTable {
  title: string;
  headers: string[];
  rows: string[][];
  emptyMessage: string;
  layout?: 'matrix' | 'records';
  edition?: 'individual' | 'team';
  note?: string;
}

// Match the China frontend's labels without changing the capability codes in JSON.
const CAPABILITY_LABELS = new Map<string, string>([
  ['TG', '文本生成'],
  ['ASR', '语音识别'],
  ['TTS', '语音合成'],
  ['IU', '图片理解'],
  ['VU', '视觉理解'],
  ['IG', '图片生成'],
  ['VG', '视频生成'],
  ['IP', '图片处理'],
  ['TR', '向量模型'],
  ['ME', '多模态向量'],
  ['RK', '排序模型'],
  ['AU', '音频理解'],
  ['OMNI', '全模态'],
  ['Reasoning', '推理模型'],
  ['QwQ', '推理模型'],
  ['Realtime-Text-to-Speech', '实时语音合成'],
  ['Realtime-Omni', '实时全模态'],
  ['Realtime-Voice-Replication', '实时语音复制'],
  ['Multimodal-Omni', '全模态'],
  ['Realtime-ASR', '实时语音识别'],
  ['Realtime-Audio-Translate', '实时语音翻译'],
  ['Realtime-Chatting', '实时对话'],
]);

function modelCapabilityText(capabilities: readonly string[]): string {
  return [
    ...new Set(
      capabilities
        .filter(Boolean)
        .map((capability) => CAPABILITY_LABELS.get(capability) ?? capability),
    ),
  ].join('、');
}

function modelTagText(model: TokenPlanSupportedModel): string | null {
  const tags = [
    ...(model.isNew === true ? ['New'] : []),
    ...(model.badgeLabel ? [model.badgeLabel] : []),
  ];
  return tags.length > 0 ? tags.join('、') : null;
}

export function tokenPlanDisplayText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Array.from(stripVTControlCharacters(String(value)))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join('');
}

export function tokenPlanDisplayDate(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? `${formatAsiaShanghaiDate(value, 'datetime')} (Asia/Shanghai)`
    : '—';
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100) / 100}%`;
}

function harnessRemainingPercent(
  totalQuota: string | null | undefined,
  remainingQuota: string | null | undefined,
): string {
  if (totalQuota == null || remainingQuota == null) return '—';
  const quotaUnits = (value: string): bigint => {
    const [integer, fraction = ''] = DecimalAmount.parse(value).toCanonicalString().split('.');
    return BigInt(integer + fraction.padEnd(12, '0'));
  };
  try {
    const total = quotaUnits(totalQuota);
    const remaining = quotaUnits(remainingQuota);
    if (total === 0n) return '0%';
    const capped = remaining > total ? total : remaining;
    // Match the frontend's BigNumber division (20 decimal places), then its one-decimal display.
    const ratio = (capped * 10n ** 20n + total / 2n) / total;
    return `${Number(`${ratio}e-18`).toFixed(1).replace(/\.0$/, '')}%`;
  } catch {
    return '—';
  }
}

export function buildTokenPlanCatalogDetails(
  section: TokenPlanListSection,
): TokenPlanDisplayTable[] {
  const plan = section.plans?.[0];
  if (!plan) return [];
  const tables: TokenPlanDisplayTable[] = [];
  if (plan.supportedModels !== undefined) {
    tables.push({
      title: 'SUPPORTED MODELS',
      layout: 'records',
      headers: ['MODEL BRAND', 'MODEL NAME', 'CAPABILITIES', 'TAG'],
      rows: (plan.supportedModels ?? []).map((model) =>
        [
          model.modelBrand,
          model.modelId,
          modelCapabilityText(model.capabilities),
          modelTagText(model),
        ].map(tokenPlanDisplayText),
      ),
      emptyMessage:
        plan.supportedModels === null
          ? 'Supported model information unavailable. Please try again later.'
          : 'No supported models available.',
    });
  }
  return tables;
}

export function buildTokenPlanStatusDetails(
  result: TokenPlanStatusResult,
): TokenPlanDisplayTable[] {
  const tables: TokenPlanDisplayTable[] = [];
  const individual = result.individual;
  if (individual?.status !== 'not_subscribed' && individual?.tiers) {
    tables.push({
      title: 'INDIVIDUAL CREDIT WINDOWS',
      edition: 'individual',
      layout: 'records',
      headers: ['TIER', 'WINDOW', 'USED (%)', 'REMAINING (%)', 'RESET AT'],
      rows: individual.tiers.map((tier) => [
        tokenPlanDisplayText(tier.tier),
        tier.windowType,
        percent(tier.usedPct),
        percent(tier.remainingPct),
        tokenPlanDisplayDate(tier.resetAt),
      ]),
      emptyMessage: 'No confirmed credit window available.',
    });
  }
  if (individual && Object.hasOwn(individual, 'subscriptionId') && individual.status === 'active') {
    tables.push({
      title: 'PERSONAL HARNESS ALLOWANCES',
      edition: 'individual',
      layout: 'records',
      headers: ['TOOL', 'TOTAL QUOTA', 'REMAINING QUOTA', 'UNIT', 'REMAINING (%)'],
      rows: (individual.harnessAllowances ?? []).map((tool) => [
        ...[tool.toolName, tool.totalQuota, tool.remainingQuota, tool.quotaUnit].map(
          tokenPlanDisplayText,
        ),
        harnessRemainingPercent(tool.totalQuota, tool.remainingQuota),
      ]),
      emptyMessage:
        individual.harnessAllowances === undefined || individual.harnessAllowances === null
          ? 'Harness allowance information unavailable. Please try again later.'
          : individual.harnessHasResourcePack === true
            ? 'Harness benefits are being issued. Please check back later.'
            : 'No granted Harness allowances found for this account.',
    });
  }
  if (result.team?.status !== 'not_subscribed' && result.team?.seatSummaries) {
    const showRemainingCredits = result.team.seatSummaries.some(
      (seat) => seat.remainingCredits != null,
    );
    tables.push({
      title: 'TEAM CREDIT SUMMARY',
      edition: 'team',
      layout: 'records',
      headers: [
        'SEAT TYPE',
        'SEAT COUNT',
        'TOTAL CREDITS',
        ...(showRemainingCredits ? ['REMAINING CREDITS'] : []),
        'REMAINING (%)',
        'RESET AT',
      ],
      rows: sortTokenPlanSeats(result.team.seatSummaries, (seat) => seat.seatType).map((seat) => [
        tokenPlanDisplayText(seat.seatType),
        tokenPlanDisplayText(seat.seatCount),
        tokenPlanDisplayText(seat.totalCredits),
        ...(showRemainingCredits ? [tokenPlanDisplayText(seat.remainingCredits)] : []),
        percent(seat.remainingPct),
        tokenPlanDisplayDate(seat.resetAt),
      ]),
      emptyMessage: 'No confirmed team credit summary available.',
    });
  }
  return tables;
}
