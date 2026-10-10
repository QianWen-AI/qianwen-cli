import { site } from '../../site.js';
import type { TokenPlanEdition } from '../../types/tokenplan-subscription.js';
import { DecimalAmount } from '../../utils/decimal-amount.js';
import { CliError } from '../../utils/errors.js';
import { tokenPlanRecord } from './tokenplan-trade.js';

export interface TokenPlanCatalogPrice {
  price: string;
  originalPrice: string | null;
  currency: 'CNY';
  monthlyCredits: string | null;
}

interface CatalogTarget {
  tierKey: 'subscription_type' | 'plan_type';
  specCode: string;
  commodityCode: string;
  orderTime: string;
}

interface CatalogEntry {
  raw: Record<string, unknown>;
  properties: Map<string, string>;
  credits: unknown[];
}

function unknownPrice(): never {
  throw new CliError({
    code: 'TOKENPLAN_CATALOG_PRICE_UNKNOWN',
    message: 'Token Plan catalog price is missing, invalid or ambiguous.',
    exitCode: 4,
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  return tokenPlanRecord(value) ?? unknownPrice();
}

function assertSuccess(raw: Record<string, unknown>, allowQuantityLimit = false): void {
  for (const key of ['successResponse', 'success', 'Success']) {
    if (Object.hasOwn(raw, key) && raw[key] !== true) unknownPrice();
  }
  for (const key of ['code', 'Code']) {
    if (!Object.hasOwn(raw, key)) continue;
    // Article items use 'code' as a commodity identifier (e.g. "sfm_tokenplanteams_dp_cn"),
    // not as a status code. When an article marker ('articleItemCode' or 'articleItemName') is
    // present as a sibling field, skip the status-code assertion for the 'code' key.
    if (
      key === 'code' &&
      (Object.hasOwn(raw, 'articleItemCode') || Object.hasOwn(raw, 'articleItemName'))
    ) {
      continue;
    }
    const value = raw[key];
    if (
      typeof value !== 'string' ||
      (!['200', 'SUCCESS', 'Success'].includes(value) &&
        !(allowQuantityLimit && value === 'CURRENT_USER_QUANTITY_EXCEED'))
    ) {
      unknownPrice();
    }
  }
}

function setProperty(properties: Map<string, string>, code: unknown, value: unknown): void {
  if (code !== 'subscription_type' && code !== 'plan_type' && code !== 'ord_time') return;
  if (typeof value !== 'string' || !value || value.trim() !== value) unknownPrice();
  const previous = properties.get(code);
  if (previous !== undefined && previous !== value) unknownPrice();
  properties.set(code, value);
}

function catalogTarget(
  configuration: Record<string, unknown>,
  options: { edition: TokenPlanEdition; specCode: string },
): CatalogTarget {
  const tierKey = options.edition === 'individual' ? 'subscription_type' : 'plan_type';
  const commodityCode =
    options.edition === 'individual'
      ? site.features.tokenPlanCommodityCodes.soloBuy
      : site.features.tokenPlanCommodityCodes.teams;
  if (
    !['individual', 'team'].includes(options.edition) ||
    configuration.commodityCode !== commodityCode ||
    configuration.specCode !== commodityCode ||
    !Array.isArray(configuration.components)
  ) {
    return unknownPrice();
  }
  const properties = new Map<string, string>();
  for (const value of configuration.components) {
    const component = requireRecord(value);
    if (!Array.isArray(component.instanceProperty)) unknownPrice();
    for (const item of component.instanceProperty) {
      const property = requireRecord(item);
      setProperty(properties, property.code, property.value);
    }
  }
  const orderTime = `${configuration.duration}:${configuration.pricingCycle}`;
  if (
    properties.get(tierKey) !== options.specCode ||
    properties.has(tierKey === 'plan_type' ? 'subscription_type' : 'plan_type') ||
    !['1:Month', '3:Month', '1:Year'].includes(orderTime) ||
    (options.edition === 'team' && orderTime === '3:Month') ||
    (properties.has('ord_time') && properties.get('ord_time') !== orderTime)
  ) {
    return unknownPrice();
  }
  return { tierKey, specCode: options.specCode, commodityCode, orderTime };
}

function catalogEntry(value: unknown): CatalogEntry {
  const raw = requireRecord(value);
  const properties = new Map<string, string>();
  const credits: unknown[] = [];
  for (const key of ['subscription_type', 'plan_type', 'ord_time']) {
    if (Object.hasOwn(raw, key)) setProperty(properties, key, raw[key]);
  }
  for (const field of ['moduleResults', 'moduleInstance']) {
    if (!Object.hasOwn(raw, field)) continue;
    const modules = raw[field];
    if (!Array.isArray(modules)) unknownPrice();
    for (const value of modules) {
      const module = requireRecord(value);
      if (
        module.moduleCode !== undefined &&
        module.code !== undefined &&
        module.moduleCode !== module.code
      ) {
        unknownPrice();
      }
      const moduleCode = module.moduleCode ?? module.code;
      if (module.moduleAttributeMap !== undefined) {
        const attributes = requireRecord(module.moduleAttributeMap);
        for (const [code, value] of Object.entries(attributes)) {
          setProperty(properties, code, value);
          if (
            (moduleCode === 'credit_value' || moduleCode === 'subscription_spec') &&
            code === 'credit_value'
          ) {
            credits.push(value);
          }
        }
      }
      if (module.moduleAttrs !== undefined) {
        if (!Array.isArray(module.moduleAttrs)) unknownPrice();
        for (const value of module.moduleAttrs) {
          const attribute = requireRecord(value);
          setProperty(properties, attribute.code, attribute.value);
          if (
            (moduleCode === 'credit_value' || moduleCode === 'subscription_spec') &&
            attribute.code === 'credit_value'
          ) {
            credits.push(attribute.value);
          }
        }
      }
    }
  }
  return { raw, properties, credits };
}

function compatibleEntry(entry: CatalogEntry, target: CatalogTarget): boolean {
  const otherTierKey = target.tierKey === 'plan_type' ? 'subscription_type' : 'plan_type';
  const articleCodes = [entry.raw.commodityCode, entry.raw.articleItemCode];
  if (Object.hasOwn(entry.raw, 'articleItemCode') || Object.hasOwn(entry.raw, 'articleItemName')) {
    articleCodes.push(entry.raw.code);
  }
  const presentArticleCodes = articleCodes.filter((value) => value !== undefined);
  return (
    !entry.properties.has(otherTierKey) &&
    presentArticleCodes.every(
      (value) =>
        typeof value === 'string' &&
        value.trim() === value &&
        value.length > 0 &&
        value === target.commodityCode,
    ) &&
    (!entry.properties.has('ord_time') || entry.properties.get('ord_time') === target.orderTime) &&
    (!entry.properties.has(target.tierKey) ||
      entry.properties.get(target.tierKey) === target.specCode)
  );
}

function selectEntry(entries: CatalogEntry[], target: CatalogTarget): CatalogEntry | null {
  const candidates = entries.filter((entry) => compatibleEntry(entry, target));
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  return entries.length === 1 || candidate.properties.get(target.tierKey) === target.specCode
    ? candidate
    : null;
}

function minorAmount(value: unknown): DecimalAmount {
  const [integer, fraction = ''] = DecimalAmount.fromApi(value).toCanonicalString().split('.');
  const units = BigInt(integer);
  const decimals = `${(units % 100n).toString().padStart(2, '0')}${fraction}`;
  return DecimalAmount.parse(`${units / 100n}.${decimals}`);
}

/**
 * Use price.discountedTotalPrice as the current catalog amount.
 * Settlement fields do not represent catalog prices.
 */
function articleFinalAmount(entry: CatalogEntry | null): DecimalAmount | null {
  if (!entry) return null;
  try {
    const price = tokenPlanRecord(entry.raw.price);
    return price?.discountedTotalPrice === undefined
      ? null
      : minorAmount(price.discountedTotalPrice);
  } catch {
    unknownPrice();
  }
}

function articleOriginalAmount(
  entry: CatalogEntry | null,
  finalAmount: DecimalAmount,
): DecimalAmount | null {
  if (!entry) return null;
  try {
    const price = tokenPlanRecord(entry.raw.price);
    if (price?.totalPrice === undefined) return null;
    const originalAmount = minorAmount(price.totalPrice);
    return originalAmount.compare(finalAmount) >= 0 ? originalAmount : null;
  } catch {
    // The original price is optional display data. An invalid value must not hide a valid
    // current card price or turn a purchasable catalog row into a protocol failure.
    return null;
  }
}

function monthlyCredits(
  article: CatalogEntry | null,
  lines: CatalogEntry[],
  target: CatalogTarget,
): string | null {
  const line = selectEntry(lines, target);
  if (!line && lines.some((entry) => compatibleEntry(entry, target))) return null;
  const values = [...(article?.credits ?? []), ...(line?.credits ?? [])];
  if (values.length === 0) return null;
  try {
    const canonical = values.map((value) => DecimalAmount.fromApi(value).toCanonicalString());
    return canonical.every((value) => value === canonical[0]) ? canonical[0] : null;
  } catch {
    return null;
  }
}

export function parseTokenPlanCatalogPrice(
  data: unknown,
  configuration: Record<string, unknown>,
  options: { edition: TokenPlanEdition; specCode: string },
): TokenPlanCatalogPrice {
  const target = catalogTarget(configuration, options);
  const raw = requireRecord(data);
  const price = requireRecord(raw.price);
  const order = price.order == null ? null : requireRecord(price.order);
  assertSuccess(raw);
  assertSuccess(price);
  if (order) assertSuccess(order, true);
  const articleValues = price.articleItemResults === undefined ? [] : price.articleItemResults;
  if (!Array.isArray(articleValues)) unknownPrice();
  const articles = articleValues.map(catalogEntry);
  const lines =
    order?.orderLines == null
      ? []
      : Object.values(requireRecord(order.orderLines)).map(catalogEntry);
  if (site.features.currency !== 'CNY') unknownPrice();
  for (const source of [
    raw,
    price,
    order,
    ...articles.map((entry) => entry.raw),
    ...lines.map((entry) => entry.raw),
  ]) {
    if (!source) continue;
    const settlement = tokenPlanRecord(source.settlement);
    const nestedPrice = tokenPlanRecord(source.price);
    for (const currency of [
      source.currency,
      settlement?.settlementCurrency,
      settlement?.currency,
      nestedPrice?.currency,
    ]) {
      if (currency !== undefined && currency !== 'CNY') unknownPrice();
    }
  }
  const article = selectEntry(articles, target);
  if (articles.length > 0 && !article) unknownPrice();
  if (article) assertSuccess(article.raw);
  const amount = articleFinalAmount(article);
  if (!amount) unknownPrice();
  return {
    price: amount.toCanonicalString(),
    originalPrice: articleOriginalAmount(article, amount)?.toCanonicalString() ?? null,
    currency: 'CNY',
    monthlyCredits: monthlyCredits(article, lines, target),
  };
}

export function parseTokenPlanCatalogInventory(data: unknown): boolean {
  const raw = tokenPlanRecord(data);
  if (!raw || typeof raw.available !== 'boolean') {
    throw new CliError({
      code: 'TOKENPLAN_CATALOG_INVENTORY_UNKNOWN',
      message: 'Token Plan catalog inventory is missing or invalid.',
      exitCode: 4,
    });
  }
  assertSuccess(raw);
  return raw.available;
}
