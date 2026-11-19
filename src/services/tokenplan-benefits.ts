import { randomUUID } from 'node:crypto';
import type { ApiClient } from '../api/api-client.js';
import { GatewayShapeError } from '../api/request-adapter.js';
import {
  API_TOKENPLAN_MODEL_PROVIDERS,
  API_TOKENPLAN_SUPPORTED_MODELS,
  API_TOKENPLAN_TOOL_CATALOG,
  API_TOKENPLAN_TOOL_EQUITY,
} from '../types/api-routes.js';
import type {
  TokenPlanHarnessAllowance,
  TokenPlanHarnessCatalogItem,
  TokenPlanSupportedModel,
} from '../types/tokenplan-benefits.js';
import { DecimalAmount } from '../utils/decimal-amount.js';

type Edition = 'individual' | 'team';

interface CatalogDefinition {
  output: TokenPlanHarnessCatalogItem;
  planCodes: string[];
}

interface HarnessCatalog {
  definitions: CatalogDefinition[];
  configuredPlanCodes: Set<string>;
}

interface Equity {
  equityType: string;
  totalQuota: string | null;
  remainingQuota: string | null;
  startAt: string | null;
  endAt: string | null;
}

interface Provider {
  name: string;
  order: number;
}

export interface TokenPlanBenefitsReader {
  loadModels(edition: Edition): Promise<TokenPlanSupportedModel[]>;
  loadHarnessCatalog(): Promise<TokenPlanHarnessCatalogItem[]>;
  loadHarnessAllowances(): Promise<TokenPlanHarnessAllowance[]>;
  loadHarnessBenefits(): Promise<TokenPlanHarnessBenefits>;
}

export interface TokenPlanHarnessBenefits {
  allowances: TokenPlanHarnessAllowance[];
  hasResourcePack: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayShapeError(`Invalid Token Plan ${label}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function requiredText(value: unknown, label: string): string {
  const result = text(value);
  if (result === null) throw new GatewayShapeError(`Invalid Token Plan ${label}`);
  return result;
}

function decimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return DecimalAmount.fromApi(value).toCanonicalString();
  } catch {
    return null;
  }
}

function timestamp(value: unknown): string | null {
  const milliseconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds) || milliseconds < 0)
    return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Query interrupted', 'AbortError');
}

function catalogDefinitions(value: unknown): HarnessCatalog {
  const data = record(value, 'Harness catalog data');
  if (!Array.isArray(data.items))
    throw new GatewayShapeError('Token Plan Harness catalog items are missing');
  const definitions = data.items.flatMap((value): CatalogDefinition[] => {
    const item = record(value, 'Harness catalog item');
    if (item.hasResourcePack !== true) return [];
    const codes = item.planCodes ?? [];
    if (!Array.isArray(codes) || codes.some((code) => text(code) === null)) {
      throw new GatewayShapeError('Invalid Token Plan Harness planCodes');
    }
    const price =
      item.priceInfo === undefined || item.priceInfo === null
        ? {}
        : record(item.priceInfo, 'Harness price');
    return [
      {
        planCodes: [...new Set(codes as string[])],
        output: {
          toolId: text(item.type),
          toolName: requiredText(item.title, 'Harness title'),
          freeQuota: null,
          quotaUnit: text(item.quotaUnit) ?? text(price.unit),
          discount: null,
          discountType: null,
        },
      },
    ];
  });
  return {
    definitions,
    // The frontend excludes grants configured by any directory item from the fallback rows.
    configuredPlanCodes: new Set(
      data.items.flatMap((value) => {
        const codes = record(value, 'Harness catalog item').planCodes;
        return Array.isArray(codes)
          ? codes.filter((code): code is string => text(code) !== null)
          : [];
      }),
    ),
  };
}

function equities(value: unknown): Equity[] {
  const data = record(value, 'Harness equity data');
  if (!Array.isArray(data.tokenPlanEquityInfos))
    throw new GatewayShapeError('Token Plan Harness equity list is missing');
  return data.tokenPlanEquityInfos.map((value) => {
    const item = record(value, 'Harness equity item');
    return {
      equityType: requiredText(item.equityType, 'equity type'),
      totalQuota: decimal(item.totalQuota),
      remainingQuota: decimal(item.availableQuota),
      startAt: timestamp(item.instanceStartTime),
      endAt: timestamp(item.instanceEndTime),
    };
  });
}

function allowance(equity: Equity, tool?: TokenPlanHarnessCatalogItem): TokenPlanHarnessAllowance {
  return {
    toolId: tool?.toolId ?? null,
    toolName: tool?.toolName ?? equity.equityType,
    totalQuota: equity.totalQuota,
    remainingQuota: equity.remainingQuota,
    quotaUnit: tool?.quotaUnit ?? null,
    startAt: equity.startAt,
    endAt: equity.endAt,
  };
}

function joinAllowances(catalog: HarnessCatalog, entries: Equity[]): TokenPlanHarnessAllowance[] {
  const result: TokenPlanHarnessAllowance[] = [];
  for (const tool of catalog.definitions) {
    // The UI selects the first matching grant; separate grants must not be summed.
    const equity = entries.find((item) => tool.planCodes.includes(item.equityType));
    if (equity) result.push(allowance(equity, tool.output));
  }
  const seen = new Set<string>();
  for (const equity of entries) {
    if (catalog.configuredPlanCodes.has(equity.equityType) || seen.has(equity.equityType)) continue;
    seen.add(equity.equityType);
    result.push(allowance(equity));
  }
  return result;
}

function localizedName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try {
    const localized = record(JSON.parse(value), 'localized model name');
    return text(localized['zh-CN']) ?? text(localized['en-US']) ?? fallback;
  } catch {
    return fallback;
  }
}

function modelCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((capability) => text(capability) === null)) {
    throw new GatewayShapeError('Invalid Token Plan model capabilities');
  }
  const priority = ['TG', 'Reasoning', 'VU'];
  return [...new Set(value as string[])].sort((left, right) => {
    const leftRank = priority.indexOf(left);
    const rightRank = priority.indexOf(right);
    return (
      (leftRank < 0 ? priority.length : leftRank) - (rightRank < 0 ? priority.length : rightRank)
    );
  });
}

function providerLookup(value: unknown): Map<string, Provider> {
  const business = record(value, 'provider business envelope');
  if (!Array.isArray(business.data))
    throw new GatewayShapeError('Token Plan provider tree is missing');
  const lookup = new Map<string, Provider>();
  const visit = (nodes: unknown[], depth: number): void => {
    if (depth > 32) throw new GatewayShapeError('Token Plan provider tree is too deep');
    for (const value of nodes) {
      const node = record(value, 'provider');
      if (node.items !== undefined && !Array.isArray(node.items))
        throw new GatewayShapeError('Invalid Token Plan provider items');
      if (Array.isArray(node.items) && node.items.length > 0) {
        visit(node.items, depth + 1);
        continue;
      }
      const id = requiredText(node.providerId, 'provider ID');
      if (lookup.has(id)) throw new GatewayShapeError('Duplicate Token Plan provider ID');
      lookup.set(id, { name: text(node.displayName) ?? id, order: lookup.size });
    }
  };
  visit(business.data, 0);
  return lookup;
}

async function supportedModels(
  apiClient: ApiClient,
  edition: Edition,
  providers: Promise<Map<string, Provider>>,
  signal?: AbortSignal,
): Promise<TokenPlanSupportedModel[]> {
  if (edition !== 'individual' && edition !== 'team')
    throw new GatewayShapeError('Invalid Token Plan model edition');
  const lookup = await providers;
  const result: Array<TokenPlanSupportedModel & { providerId: string }> = [];
  const seen = new Set<string>();
  const unknownBrands = new Map<string, number>();
  let expectedTotal: number | null = null;
  for (let pageNo = 1; pageNo <= 100; pageNo++) {
    checkSignal(signal);
    const page = await apiClient.callCsDataApi({
      api: API_TOKENPLAN_SUPPORTED_MODELS,
      data: {
        input: { pageNo, pageSize: 100, edition: edition === 'individual' ? 'PERSONAL' : 'TEAM' },
      },
      authMode: 'none',
      signal,
      parse: (business) => record(record(business, 'models business envelope').data, 'models data'),
    });
    if (!Array.isArray(page.list)) throw new GatewayShapeError('Token Plan model list is missing');
    if (page.list.length > 100)
      throw new GatewayShapeError('Token Plan model page exceeds page size');
    if (page.pageNo !== pageNo || page.pageSize !== 100)
      throw new GatewayShapeError('Token Plan model page mismatch');
    if (!Number.isSafeInteger(page.total) || Number(page.total) < 0)
      throw new GatewayShapeError('Invalid Token Plan model total');
    if (expectedTotal !== null && expectedTotal !== page.total)
      throw new GatewayShapeError('Token Plan model total changed while paging');
    expectedTotal = Number(page.total);
    for (const value of page.list) {
      const model = record(value, 'model');
      const modelId = requiredText(model.modelId, 'model ID');
      if (seen.has(modelId)) throw new GatewayShapeError('Duplicate Token Plan model while paging');
      seen.add(modelId);
      const providerId = requiredText(model.provider, 'model provider ID');
      if (!lookup.has(providerId) && !unknownBrands.has(providerId)) {
        unknownBrands.set(providerId, lookup.size + unknownBrands.size);
      }
      result.push({
        modelId,
        providerId,
        modelBrand: lookup.get(providerId)?.name ?? providerId,
        modelName: localizedName(model.name, modelId),
        capabilities: modelCapabilities(model.capabilities),
        ...(typeof model.badgeLabel === 'string' ? { badgeLabel: model.badgeLabel } : {}),
        ...(typeof model.badgeDescription === 'string'
          ? { badgeDescription: model.badgeDescription }
          : {}),
        ...(typeof model.isNew === 'boolean' ? { isNew: model.isNew } : {}),
      });
    }
    if (expectedTotal !== null && result.length > expectedTotal)
      throw new GatewayShapeError('Token Plan model total is inconsistent');
    const complete = result.length === expectedTotal;
    if (complete) {
      result.sort(
        (left, right) =>
          (lookup.get(left.providerId)?.order ?? unknownBrands.get(left.providerId)!) -
          (lookup.get(right.providerId)?.order ?? unknownBrands.get(right.providerId)!),
      );
      return result.map(({ providerId: _providerId, ...model }) => model);
    }
    if (page.list.length === 0)
      throw new GatewayShapeError('Token Plan model paging made no progress');
  }
  throw new GatewayShapeError('Token Plan model page budget exceeded');
}

/** Cache public metadata only for this command invocation, including failed reads. */
export function createTokenPlanBenefitsReader(
  apiClient: ApiClient,
  signal?: AbortSignal,
): TokenPlanBenefitsReader {
  let providers: Promise<Map<string, Provider>> | undefined;
  let catalog: Promise<HarnessCatalog> | undefined;
  let benefits: Promise<TokenPlanHarnessBenefits> | undefined;
  const models = new Map<Edition, Promise<TokenPlanSupportedModel[]>>();
  const loadDefinitions = (): Promise<HarnessCatalog> => {
    catalog ??= apiClient
      .callEnvelopeApi<unknown>({
        api: API_TOKENPLAN_TOOL_CATALOG,
        dataMode: 'flat',
        data: {},
        signal,
      })
      .then(catalogDefinitions);
    return catalog;
  };
  const loadHarnessBenefits = (): Promise<TokenPlanHarnessBenefits> => {
    benefits ??= Promise.all([
      loadDefinitions(),
      apiClient
        .callEnvelopeApi<unknown>({
          api: API_TOKENPLAN_TOOL_EQUITY,
          dataMode: 'flat',
          data: { queryTokenPlanEquityInfoRequest: { requestId: randomUUID() } },
          signal,
        })
        .then(equities),
    ]).then(([definitions, entries]) => ({
      allowances: joinAllowances(definitions, entries),
      // Definitions retain every strict hasResourcePack=true item, even without planCodes.
      hasResourcePack: definitions.definitions.length > 0,
    }));
    return benefits;
  };
  return {
    loadModels(edition) {
      if (edition !== 'individual' && edition !== 'team') {
        return Promise.reject(new GatewayShapeError('Invalid Token Plan model edition'));
      }
      if (!models.has(edition)) {
        providers ??= apiClient.callCsDataApi({
          api: API_TOKENPLAN_MODEL_PROVIDERS,
          data: {},
          authMode: 'none',
          signal,
          parse: providerLookup,
        });
        models.set(edition, supportedModels(apiClient, edition, providers, signal));
      }
      return models.get(edition)!;
    },
    async loadHarnessCatalog() {
      return (await loadDefinitions()).definitions.map((item) => ({ ...item.output }));
    },
    loadHarnessAllowances() {
      return loadHarnessBenefits().then((value) => value.allowances);
    },
    loadHarnessBenefits,
  };
}

export function fetchTokenPlanSupportedModels(
  apiClient: ApiClient,
  edition: Edition,
  signal?: AbortSignal,
): Promise<TokenPlanSupportedModel[]> {
  return createTokenPlanBenefitsReader(apiClient, signal).loadModels(edition);
}

export function fetchTokenPlanHarnessCatalog(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<TokenPlanHarnessCatalogItem[]> {
  return createTokenPlanBenefitsReader(apiClient, signal).loadHarnessCatalog();
}

export function fetchTokenPlanHarnessAllowances(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<TokenPlanHarnessAllowance[]> {
  return createTokenPlanBenefitsReader(apiClient, signal).loadHarnessAllowances();
}
