/**
 * SupportService — access to support ticket endpoints (read + write).
 */
import { randomUUID } from 'crypto';
import type { ApiClient } from '../api/api-client.js';
import type {
  RawListTicketsResponse,
  RawGetTicketResponse,
  RawListEnhancedMessageResponse,
  RawMessageItem,
  RawCategoryNode,
  RawGetCategoryTreeResponse,
  RawCategorySuggestion,
  RawSuggestCategoryResponse,
  RawCreateTicketResponse,
  RawIdentifyRiskWordResponse,
  SupportTicketDetail,
  SupportTicketListResult,
  SupportMessage,
  SupportMessagesResult,
  CategoryNode,
  CategorySuggestion,
  CreateTicketParams,
  RiskWordCheckResult,
  RateTicketResponse,
  AssessmentCardData,
  AssessmentCardMetadata,
} from '../types/support.js';
import { API_PRODUCT_WORKORDER } from '../types/api-routes.js';
import { site } from '../site.js';
import { getEffectiveConfig } from '../config/manager.js';
import { CliError, ticketNotFoundError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

// Default assessment tags (qianwenai overall block)
const DEFAULT_GOOD_TAGS = ['服务入口便捷', '处理速度快', '解决方案有效', '服务态度好'];
const DEFAULT_BAD_TAGS = ['找售后服务入口费力', '响应处理速度慢', '解决方案无效', '服务态度不好'];

const TICKET_STATUS_MAP: Record<string, string> = {
  wait_assign: 'Pending assignment',
  assigned: 'Assigned',
  dealing: 'Processing',
  wait_feedback: 'Pending feedback',
  feedback: 'Pending feedback',
  wait_confirm: 'Pending confirmation',
  wait_score: 'Pending rating',
  confirmed: 'Closed',
  score: 'Closed',
  robot_dealing: 'Processing',
  robot_waiting_confirmation: 'Pending confirmation',
  robot_processing: 'Processing',
};

export function mapTicketStatus(rawStatus: string): string {
  if (!rawStatus) return 'Unknown';
  const mapped = TICKET_STATUS_MAP[rawStatus];
  if (mapped) return mapped;
  return rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1).replace(/_/g, ' ');
}

const MESSAGE_PAGE_LIMIT = 100;

// Coerce numeric/string role identifiers to canonical tokens
function normalizeMessageRole(rawRole: unknown): string {
  if (typeof rawRole === 'number') {
    if (rawRole === 1) return 'system';
    if (rawRole === 2) return 'agent';
    if (rawRole === 3) return 'customer';
    return String(rawRole);
  }
  if (typeof rawRole === 'string') return rawRole;
  return '';
}

// Extract readable text from a system message's form schema
export function deriveSchemaText(schema: unknown): string {
  if (typeof schema !== 'string' || schema.trim().length === 0) return '';
  try {
    const parsed = JSON.parse(schema) as {
      properties?: Record<string, { 'x-component-props'?: Record<string, unknown> }>;
    };
    const properties = parsed?.properties;
    if (!properties || typeof properties !== 'object') return '';
    const parts: string[] = [];
    for (const key of Object.keys(properties)) {
      const componentProps = properties[key]?.['x-component-props'];
      if (!componentProps || typeof componentProps !== 'object') continue;
      const title = componentProps.title;
      const desc = componentProps.desc;
      if (typeof title === 'string' && title.trim()) parts.push(title.trim());
      if (typeof desc === 'string' && desc.trim()) parts.push(desc.trim());
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

export class SupportService {
  constructor(private readonly apiClient: ApiClient) {}

  async listTickets(opts: {
    page?: number;
    pageSize?: number;
    siteTag?: string;
  }): Promise<SupportTicketListResult> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.max(1, Math.min(10, opts.pageSize ?? 10));
    const siteTag = opts.siteTag ?? site.features.workorder.siteTag;

    const raw = await this.apiClient.callFlatApi<RawListTicketsResponse>({
      product: API_PRODUCT_WORKORDER,
      action: 'ListTickets',
      params: {
        Params: JSON.stringify({ CustomerLimit: false }),
        Page: page,
        PageSize: pageSize,
        IndependentSiteTag: siteTag,
      },
    });

    const list = Array.isArray(raw?.Data?.DataInfo) ? raw.Data.DataInfo : [];
    const tickets = list.map((item) => ({
      id: item.vid ?? '',
      title: item.title ?? '',
      status: item.statTicketBiz ?? '',
      createdAt: item.createTime ?? 0,
    }));
    const total = typeof raw?.Data?.Total === 'number' ? raw.Data.Total : tickets.length;

    return { tickets, total, page, pageSize };
  }

  async getTicket(ticketId: string): Promise<SupportTicketDetail> {
    const raw = await this.apiClient.callFlatApi<RawGetTicketResponse>({
      product: API_PRODUCT_WORKORDER,
      action: 'GetTicket',
      params: {
        TicketId: ticketId,
        Region: '7',
      },
    });

    const values = raw?.Data?.Values ?? raw?.Data?.values;
    if (
      !values ||
      typeof values !== 'object' ||
      (values.vid == null && values.status == null && values.Status == null)
    ) {
      throw ticketNotFoundError(ticketId);
    }

    const statusObj = values.status ?? values.Status;
    let status = '';
    if (statusObj && typeof statusObj === 'object') {
      if (typeof statusObj.value === 'string' && statusObj.value.length > 0) {
        status = statusObj.value;
      } else if (typeof statusObj.label === 'string') {
        status = statusObj.label;
      }
    }

    const category =
      values.category ??
      values.Category ??
      values.product_name ??
      values.ProductName ??
      values.process_stage?.label ??
      values.ProcessStage?.label ??
      '';

    const gmtCreate = values.gmt_create ?? values.GmtCreate;
    const createdAt = typeof gmtCreate === 'number' ? gmtCreate : 0;

    return {
      id: values.vid ?? ticketId,
      title: values.title ?? '',
      status,
      createdAt,
      category,
      description: values.description ?? values.Description ?? '',
    };
  }

  async listMessages(ticketId: string): Promise<SupportMessagesResult> {
    const raw = await this.apiClient.callFlatApi<RawListEnhancedMessageResponse>({
      product: API_PRODUCT_WORKORDER,
      action: 'ListEnhancedMessage',
      params: {
        TicketId: ticketId,
        PageLimit: MESSAGE_PAGE_LIMIT,
      },
    });

    const dataListRaw = raw?.Data?.DataList ?? raw?.Data?.dataList;
    const dataList: RawMessageItem[] = Array.isArray(dataListRaw) ? dataListRaw : [];

    const messages: SupportMessage[] = dataList.map((item) => {
      const userInfo = item.UserInfo ?? item.userInfo ?? {};
      const dataInfo = item.DataInfo ?? item.dataInfo ?? {};
      const rawRole = userInfo.Role ?? userInfo.role;
      const role = normalizeMessageRole(rawRole);
      const nickName =
        userInfo.UserName ??
        userInfo.userName ??
        userInfo.NickName ??
        userInfo.nickName ??
        userInfo.DisplayName ??
        userInfo.displayName ??
        '';
      const content =
        dataInfo.Content ??
        dataInfo.content ??
        deriveSchemaText(dataInfo.Schema ?? dataInfo.schema);
      const createdAt = item.CreateTime ?? item.GmtCreate ?? item.gmtCreate ?? item.Timestamp ?? 0;

      return {
        role,
        nickName,
        content,
        createdAt: typeof createdAt === 'number' ? createdAt : 0,
      };
    });

    return {
      messages,
      truncated: dataList.length >= MESSAGE_PAGE_LIMIT,
    };
  }

  /**
   * Fetch full ticket detail and messages concurrently.
   */
  async getTicketDetail(
    ticketId: string,
  ): Promise<{ detail: SupportTicketDetail; messages: SupportMessagesResult }> {
    const [detail, messagesResult] = await Promise.all([
      this.getTicket(ticketId),
      this.listMessages(ticketId),
    ]);

    return { detail, messages: messagesResult };
  }

  async getCategoryTree(): Promise<CategoryNode[]> {
    const source = getEffectiveConfig()['support.categorySource'];

    // Strategy 1: empty → embedded local snapshot (no network).
    if (!source) {
      return DEFAULT_CATEGORY_TREE;
    }

    // Strategy 2: 'cli-api' → legacy Workorder gateway.
    if (source === 'cli-api') {
      const raw = await this.apiClient.callFlatApi<RawGetCategoryTreeResponse>({
        product: API_PRODUCT_WORKORDER,
        action: 'GetCategoryTreeByProductCodes',
        params: {
          ProductCodes: JSON.stringify(site.features.workorder.productCodes),
        },
      });

      const data = raw?.Data;
      let nodes: RawCategoryNode[] = [];
      if (Array.isArray(data)) {
        nodes = data;
      } else if (data && typeof data === 'object') {
        nodes = data.List ?? data.list ?? [];
      }

      return nodes.map((n) => normalizeCategoryNode(n));
    }

    // Strategy 3: http(s) URL → CDN-hosted static JSON.
    let json: unknown;
    try {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      json = await response.json();
    } catch (err) {
      throw new CliError({
        code: 'SUPPORT_CATEGORY_SOURCE_FETCH_FAILED',
        message: `Failed to fetch support category source from ${source}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }
    return normalizeCdnCategoryTree(json);
  }

  async suggestCategory(content: string): Promise<CategorySuggestion[]> {
    const raw = await this.apiClient.callFlatApi<RawSuggestCategoryResponse>({
      product: API_PRODUCT_WORKORDER,
      action: 'SuggestCategoryNew',
      params: {
        Channel: 'ticket_pc_v2',
        Content: content,
        EventMethod: 'input',
        AnswerView: 5,
        TraceId: randomUUID(),
        BusinessId: randomUUID(),
        SceneCategoryMode: 'KNOWLEDGE',
      },
    });

    let items: RawCategorySuggestion[] = [];
    const data = raw?.Data;
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      items =
        data.suggestCategoryDtos ??
        data.SuggestCategoryDtos ??
        data.List ??
        data.list ??
        data.Suggestions ??
        data.suggestions ??
        [];
    }
    // Some gateways unwrap one extra level — `raw` itself may carry the list.
    if (items.length === 0) {
      const top = raw as
        | {
            suggestCategoryDtos?: RawCategorySuggestion[];
            SuggestCategoryDtos?: RawCategorySuggestion[];
          }
        | undefined;
      items = top?.suggestCategoryDtos ?? top?.SuggestCategoryDtos ?? [];
    }

    return items.slice(0, 5).map((s) => ({
      categoryId: stringifyId(s.categoryId ?? s.CategoryId),
      categoryName: s.categoryName ?? s.CategoryName ?? '',
      categoryPath: s.categoryPath ?? s.CategoryPath ?? s.path ?? s.Path ?? '',
      score: typeof s.score === 'number' ? s.score : s.Score,
    }));
  }

  async createTicket(params: CreateTicketParams): Promise<{ vid: string }> {
    const raw = await this.apiClient.callFlatApi<RawCreateTicketResponse>({
      product: API_PRODUCT_WORKORDER,
      action: 'CreateTicketNew',
      params: {
        CategoryId: params.categoryId,
        Severity: '1',
        Description: params.description,
        ServiceLinkVersion: 'V2',
        DirectLabor: 'true',
        IfServiceQuota: 'true',
        IndependentSiteTag: site.features.workorder.siteTag,
      },
    });

    let vid = '';
    const data = raw?.Data;
    if (typeof data === 'string') {
      vid = data;
    } else if (data && typeof data === 'object') {
      vid = data.vid ?? data.Vid ?? '';
    }
    return { vid };
  }

  async createMessage(ticketId: string, content: string): Promise<void> {
    await this.apiClient.callFlatApi<unknown>({
      product: API_PRODUCT_WORKORDER,
      action: 'CreateMessage',
      params: {
        TicketId: ticketId,
        Content: content,
      },
    });
  }

  async identifyRiskWord(ticketId: string, content: string): Promise<RiskWordCheckResult> {
    const raw = await this.apiClient.callFlatApi<RawIdentifyRiskWordResponse>({
      product: API_PRODUCT_WORKORDER,
      action: 'IdentifyCustomerWord',
      params: {
        TicketId: ticketId,
        Content: content,
      },
    });

    const data = raw?.Data;
    if (typeof data === 'boolean') {
      return { hasRisk: data };
    }
    if (Array.isArray(data)) {
      return { hasRisk: data.length > 0, words: data };
    }
    if (data && typeof data === 'object') {
      const words = data.words ?? data.Words ?? data.riskWords ?? data.RiskWords;
      const hasRiskField = data.hasRisk ?? data.HasRisk ?? data.hit ?? data.Hit;
      const hasRisk =
        typeof hasRiskField === 'boolean' ? hasRiskField : Array.isArray(words) && words.length > 0;
      return { hasRisk, words: Array.isArray(words) ? words : undefined };
    }
    return { hasRisk: false };
  }

  async cancelTicket(ticketId: string): Promise<void> {
    await this.apiClient.callFlatApi<unknown>({
      product: API_PRODUCT_WORKORDER,
      action: 'CancelTicket',
      params: { TicketId: ticketId },
    });
  }


  async getAssessmentCard(ticketId: string): Promise<AssessmentCardData> {
    const raw = await this.apiClient.callFlatApi<{
      Data?: {
        DataInfo?: {
          Editable?: number;
          DialogId?: number;
          Props?: Array<{
            name?: string;
            value?: {
              schema?: {
                properties?: Record<
                  string,
                  {
                    'x-component-props'?: {
                      goodDataSource?: string[];
                      badDataSource?: string[];
                      isStar?: boolean;
                    };
                  }
                >;
              };
              disableEvaluate?: boolean;
            };
          }>;
          Values?: {
            schemaId?: number;
            biz_type?: string;
            answerType?: string;
            cardBizId?: string;
            dialogId?: number;
            ticketId?: string;
            satisfaction?: number;
          };
        };
      };
    }>({
      product: API_PRODUCT_WORKORDER,
      action: 'GetAssessmentCard',
      params: { TicketId: ticketId },
    });
    const dataInfo = raw?.Data?.DataInfo;
    const values = dataInfo?.Values;

    // Parse tags from Props schema (overall block's x-component-props).
    // qianwen-specific tag-selection rating UI; not present upstream.
    let goodTags: string[] = [];
    let badTags: string[] = [];
    let isStar = false;
    try {
      const props = dataInfo?.Props;
      if (Array.isArray(props)) {
        for (const prop of props) {
          const schema = prop?.value?.schema;
          const properties = schema?.properties;
          if (!properties) continue;
          // Look for the 'overall' block or iterate all blocks
          for (const block of Object.values(properties)) {
            const xProps = block?.['x-component-props'];
            if (!xProps) continue;
            if (Array.isArray(xProps.goodDataSource)) {
              const tags = toStringTags(xProps.goodDataSource);
              if (tags.length > 0) goodTags = tags;
            }
            if (Array.isArray(xProps.badDataSource)) {
              const tags = toStringTags(xProps.badDataSource);
              if (tags.length > 0) badTags = tags;
            }
            if (typeof xProps.isStar === 'boolean') {
              isStar = xProps.isStar;
            }
          }
        }
      }
    } catch {
      // Parse failure — fall through to defaults below.
    }

    // Fallback to default Chinese tags if parsing yielded nothing.
    if (goodTags.length === 0) {
      goodTags = DEFAULT_GOOD_TAGS;
    }
    if (badTags.length === 0) {
      badTags = DEFAULT_BAD_TAGS;
    }

    // iter-75 three-state: distinguish no-card / editable / already-rated.
    const hasCard = dataInfo != null;
    const editable = dataInfo?.Editable === 1;
    const satisfaction = typeof values?.satisfaction === 'number' ? values.satisfaction : undefined;
    const disableEvaluate = dataInfo?.Props?.[0]?.value?.disableEvaluate === true;
    const alreadyRated =
      typeof satisfaction === 'number' || disableEvaluate || dataInfo?.Editable === 2;

    return {
      editable,
      hasCard,
      alreadyRated,
      satisfaction,
      schemaId: values?.schemaId ?? 0,
      bizType: values?.biz_type ?? '',
      answerType: values?.answerType ?? '',
      cardBizId: values?.cardBizId ?? '',
      dialogId: dataInfo?.DialogId ?? values?.dialogId ?? 0,
      ticketId: values?.ticketId ?? ticketId,
      isStar,
      goodTags,
      badTags,
    };
  }

  async rateTicket(
    ticketId: string,
    rating: number,
    comment?: string,
    metadata?: AssessmentCardMetadata,
    tags?: { good?: string[]; bad?: string[] },
  ): Promise<RateTicketResponse> {
    const postParam: Record<string, unknown> = {
      schemaId: metadata?.schemaId ?? 0,
      biz_type: metadata?.bizType ?? '',
      answerType: metadata?.answerType ?? '',
      cardBizId: metadata?.cardBizId ?? '',
      dialogId: metadata?.dialogId ?? 0,
      ticketId,
      satisfaction: rating,
      isStar: metadata?.isStar ?? false,
    };
    if (comment) {
      postParam.suggest = comment;
    }
    if (rating >= 2 && tags?.good?.length) {
      postParam.tagfilter_goodlabel = tags.good;
    }
    if (rating < 2 && tags?.bad?.length) {
      postParam.tagfilter_badlabel = tags.bad;
    }
    await this.apiClient.callFlatApi<unknown>({
      product: API_PRODUCT_WORKORDER,
      action: 'SubmitCard',
      params: { PostParam: JSON.stringify(postParam) },
    });
    return {
      ticketId,
      rating,
      status: 'score',
      timestamp: new Date().toISOString(),
    };
  }
}

function stringifyId(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Coerce a raw assessment tag list into plain strings. The gateway is
 * documented to return `string[]`, but some schema variants wrap each tag as an
 * object (`{ label }` / `{ value }` / `{ text }`). Non-string, non-extractable
 * entries are dropped — otherwise they reach the Ink `<Text>` tag picker as raw
 * objects and crash the renderer ("Objects are not valid as a React child").
 */
function toStringTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push(item);
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const label = rec.label ?? rec.value ?? rec.text ?? rec.name;
      if (typeof label === 'string' && label.length > 0) out.push(label);
    }
  }
  return out;
}

function normalizeCategoryNode(raw: RawCategoryNode): CategoryNode {
  const id = stringifyId(raw.id ?? raw.Id ?? raw.categoryId ?? raw.CategoryId);
  const name = raw.name ?? raw.Name ?? raw.categoryName ?? raw.CategoryName ?? '';
  const childrenRaw = raw.children ?? raw.Children ?? raw.subCategoryList ?? raw.SubCategoryList;
  const node: CategoryNode = { id, name };
  if (Array.isArray(childrenRaw) && childrenRaw.length > 0) {
    node.children = childrenRaw.map((c) => normalizeCategoryNode(c));
  }
  return node;
}

/**
 * Local copy of the production CDN category snapshot. Used when
 * `support.categorySource` is empty (the default) so the CLI never has to
 * issue a network request just to render the category picker.
 */
const DEFAULT_CATEGORY_TREE: CategoryNode[] = [
  {
    id: '__app_group_0',
    name: '模型',
    children: [
      { id: '582262', name: '账单计费' },
      { id: '582263', name: '发票咨询' },
      { id: '582264', name: '模型功能咨询' },
      { id: '582265', name: 'API/SDK调用' },
      { id: '582266', name: '工具集成' },
    ],
  },
  {
    id: '__app_group_1',
    name: '应用',
    children: [
      { id: 'miaowu', name: '秒悟', helpUrl: 'https://meoo.com' },
      { id: 'wanxiang', name: '万相', helpUrl: 'https://tongyi.aliyun.com/wan' },
      { id: 'wukong', name: '悟空', helpUrl: 'https://wukong.dingtalk.com' },
      { id: 'qianwen', name: '千问', helpUrl: 'https://www.qianwen.com' },
      { id: 'qoder', name: 'Qoder', helpUrl: 'https://qoder.com' },
      { id: 'qoderwork', name: 'QoderWork', helpUrl: 'https://qoder.com' },
    ],
  },
];

/**
 * Shape of the CDN JSON snapshot we map into `CategoryNode[]`. Fields are
 * intentionally permissive so partial / future-extended payloads still parse.
 */
interface RawCdnCategoryNode {
  value?: string | number;
  label?: string;
  helpUrl?: string;
  children?: RawCdnCategoryNode[];
}

interface RawCdnCategoryTree {
  list?: RawCdnCategoryNode[];
}

/**
 * Map the CDN payload (`{ list: [{ value, label, helpUrl, children }] }`) to
 * the canonical `CategoryNode[]` shape consumed by the rest of the CLI.
 */
function normalizeCdnCategoryTree(raw: unknown): CategoryNode[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as RawCdnCategoryTree).list;
  if (!Array.isArray(list)) return [];
  return list.map((n) => normalizeCdnCategoryNode(n));
}

function normalizeCdnCategoryNode(raw: RawCdnCategoryNode): CategoryNode {
  const id = stringifyId(raw.value);
  const name = raw.label ?? '';
  const node: CategoryNode = { id, name };
  if (typeof raw.helpUrl === 'string' && raw.helpUrl.length > 0) {
    node.helpUrl = raw.helpUrl;
  }
  if (Array.isArray(raw.children) && raw.children.length > 0) {
    node.children = raw.children.map((c) => normalizeCdnCategoryNode(c));
  }
  return node;
}
