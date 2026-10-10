import { GatewayShapeError } from '../request-adapter.js';
import { site } from '../../site.js';
import {
  TOKEN_PLAN_INDIVIDUAL_TIERS,
  isTokenPlanIndividualTier,
  type TokenPlanIndividualTier,
} from '../../types/tokenplan-tiers.js';
import type { TokenPlanBillingCycle } from '../../types/tokenplan-catalog.js';

export type SoloTier = TokenPlanIndividualTier;

export interface SoloSubscription {
  instanceCode: string;
  specCode: SoloTier;
  remainingDays: number;
  startTime: number;
  endTime: number;
  autoRenewFlag: boolean;
  status: 'VALID';
}

export interface SoloSubscriptionResult {
  status: 'active' | 'none' | 'unknown';
  subscription: SoloSubscription | null;
  reason?: string;
}

export interface SoloCatalogSubscription {
  status: 'active' | 'none';
  instanceCode: string | null;
  specCode: SoloTier | null;
}

export type SoloQuotaConfig = Partial<Record<SoloTier, { weekly?: number; monthly?: number }>>;

export interface SoloUsage {
  /** Explicit backend window; monthly is the current production contract, weekly is legacy. */
  cycle: 'weekly' | 'monthly';
  /** Used ratio in 0..1. */
  usedRatio: number;
  resetTime?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayShapeError('Invalid personal Token Plan response');
  }
  return value as Record<string, unknown>;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
  return nonNegativeNumber(value) && Number.isSafeInteger(value) && value <= 8_640_000_000_000_000;
}

function unknownSubscription(reason: string): SoloSubscriptionResult {
  return { status: 'unknown', subscription: null, reason };
}

/**
 * Catalog subscription status is active only when the service returns VALID.
 * Other statuses are treated as not subscribed. Purchase validation uses a
 * separate parser with stricter requirements.
 */
export function parseSoloCatalogSubscription(business: unknown): SoloCatalogSubscription {
  const envelope = object(business);
  if (!Object.hasOwn(envelope, 'data') || envelope.data == null) {
    return { status: 'none', instanceCode: null, specCode: null };
  }
  const entity = object(envelope.data);
  if (entity.status !== 'VALID') {
    return { status: 'none', instanceCode: null, specCode: null };
  }
  if (
    typeof entity.instanceCode !== 'string' ||
    !entity.instanceCode.trim() ||
    !isTokenPlanIndividualTier(entity.specCode)
  ) {
    throw new GatewayShapeError('Personal Token Plan catalog subscription is invalid');
  }
  return {
    status: 'active',
    instanceCode: entity.instanceCode,
    specCode: entity.specCode,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function billingCycle(duration: number, unit: 'Month' | 'Year'): TokenPlanBillingCycle | null {
  const months = unit === 'Year' ? duration * 12 : duration;
  if (months === 1) return 'monthly';
  if (months === 3) return 'quarterly';
  if (months === 12) return 'yearly';
  return null;
}

function normalizedPeriod(value: unknown): TokenPlanBillingCycle | null {
  if (typeof value !== 'string') return null;
  const match = /^([1-9]\d*):(Month|Quarter|Year)$/iu.exec(value.trim());
  if (!match) return null;
  const duration = Number(match[1]);
  if (!Number.isSafeInteger(duration) || duration <= 0) return null;
  const unit = match[2]!.toLowerCase();
  if (unit === 'year') return billingCycle(duration, 'Year');
  const months = unit === 'quarter' ? duration * 3 : duration;
  return Number.isSafeInteger(months) ? billingCycle(months, 'Month') : null;
}

function orderTimeExpression(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return record(value);
}

/** Resolve the active personal subscription cycle from instance fields. */
export function parseSoloCatalogBillingCycle(instance: unknown): TokenPlanBillingCycle | null {
  const entity = record(instance);
  if (!entity) return null;
  if (Array.isArray(entity.instanceComponents)) {
    for (const componentValue of entity.instanceComponents) {
      const component = record(componentValue);
      if (component?.componentCode !== 'ord_time' || !Array.isArray(component.instanceProperty)) {
        continue;
      }
      for (const propertyValue of component.instanceProperty) {
        const property = record(propertyValue);
        if (property?.code !== 'ord_time') continue;
        const cycle = normalizedPeriod(property.value);
        if (cycle) return cycle;
      }
    }
  }

  const purchaseParams = record(entity.purchaseParams);
  const expression = orderTimeExpression(purchaseParams?.orderTimeExpression);
  if (!expression) return null;
  const upgraded =
    (typeof purchaseParams?.tradeType === 'string' &&
      purchaseParams.tradeType.toLowerCase() === 'upgrade') ||
    purchaseParams?.upgradeProdToken != null;
  if (upgraded) {
    const months = expression.diffMonth;
    return typeof months === 'number' &&
      Number.isSafeInteger(months) &&
      [1, 3, 6, 12].includes(months)
      ? billingCycle(months, 'Month')
      : null;
  }
  const duration = expression.originQuantity;
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) return null;
  if (expression.originCycleUnit === 1) return billingCycle(duration, 'Year');
  if (expression.originCycleUnit === 2) return billingCycle(duration, 'Month');
  return null;
}

export function parseSoloSubscription(business: unknown): SoloSubscriptionResult {
  const envelope = object(business);
  if (
    !Object.hasOwn(envelope, 'data') &&
    envelope.code === 'SUCCESS' &&
    envelope.success === true
  ) {
    return { status: 'none', subscription: null, reason: 'no_subscription' };
  }
  if (!Object.hasOwn(envelope, 'data') || envelope.data === undefined) {
    return unknownSubscription('missing_data');
  }
  if (envelope.data === null) return unknownSubscription('null_data');
  const entity = object(envelope.data);
  if (Object.keys(entity).length === 0) return unknownSubscription('empty_data');
  if (typeof entity.status !== 'string') {
    throw new GatewayShapeError('Personal Token Plan status is missing or invalid');
  }
  if (entity.status !== 'VALID') return unknownSubscription('unconfirmed_status');
  if (
    typeof entity.instanceCode !== 'string' ||
    !entity.instanceCode.trim() ||
    !isTokenPlanIndividualTier(entity.specCode) ||
    !nonNegativeNumber(entity.remainingDays) ||
    !timestamp(entity.startTime) ||
    !timestamp(entity.endTime) ||
    entity.endTime <= entity.startTime ||
    typeof entity.autoRenewFlag !== 'boolean' ||
    ('commodityCode' in entity &&
      entity.commodityCode !== site.features.tokenPlanCommodityCodes.soloBuy)
  ) {
    throw new GatewayShapeError('Personal Token Plan subscription fields are invalid');
  }
  const now = Date.now();
  if (now < entity.startTime || now >= entity.endTime) {
    return unknownSubscription('inconsistent_period');
  }
  return {
    status: 'active',
    subscription: {
      instanceCode: entity.instanceCode,
      specCode: entity.specCode,
      remainingDays: entity.remainingDays,
      startTime: entity.startTime,
      endTime: entity.endTime,
      autoRenewFlag: entity.autoRenewFlag,
      status: 'VALID',
    },
  };
}

export function parseSoloQuotaConfig(business: unknown): SoloQuotaConfig {
  const entity = object(object(business).data);
  const result: SoloQuotaConfig = {};
  // Tier whitelist iteration keeps non-tier keys such as addon_quota out of the result.
  for (const { specCode } of TOKEN_PLAN_INDIVIDUAL_TIERS) {
    if (!Object.hasOwn(entity, specCode)) continue;
    const quota = object(entity[specCode]);
    const weekly = nonNegativeNumber(quota.weekly) ? quota.weekly : null;
    const monthly = nonNegativeNumber(quota.monthly) ? quota.monthly : null;
    if (weekly === null && monthly === null) {
      throw new GatewayShapeError('Personal Token Plan quota configuration is invalid');
    }
    result[specCode] = {
      ...(weekly === null ? {} : { weekly }),
      ...(monthly === null ? {} : { monthly }),
    };
  }
  return result;
}

const USAGE_CYCLES = [
  { cycle: 'monthly', percentage: 'per1MonthPercentage', resetTime: 'per1MonthResetTime' },
  { cycle: 'weekly', percentage: 'per1WeekPercentage', resetTime: 'per1WeekResetTime' },
] as const;

/**
 * The cycle is taken verbatim from the field the backend returned; monthly and
 * weekly are never conflated and neither silently falls back to the other (TP-184).
 */
export function parseSoloUsage(business: unknown): SoloUsage | null {
  const envelope = object(business);
  if (!Object.hasOwn(envelope, 'data') || envelope.data === null) return null;
  const entity = object(envelope.data);
  for (const { cycle, percentage, resetTime } of USAGE_CYCLES) {
    if (!Object.hasOwn(entity, percentage)) continue;
    const ratio = entity[percentage];
    if (!nonNegativeNumber(ratio) || ratio > 1) {
      throw new GatewayShapeError('Personal Token Plan usage is invalid');
    }
    const reset = entity[resetTime];
    if (reset !== undefined && reset !== null && !timestamp(reset)) {
      throw new GatewayShapeError('Personal Token Plan usage is invalid');
    }
    return {
      cycle,
      usedRatio: ratio,
      ...(timestamp(reset) ? { resetTime: reset } : {}),
    };
  }
  return null;
}
