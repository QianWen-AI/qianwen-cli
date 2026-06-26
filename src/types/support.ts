// Raw API response types

export interface RawTicketItem {
  vid: string;
  title: string;
  statTicketBiz: string;
  createTime: number; // millisecond timestamp
}

export interface RawListTicketsResponse {
  Data?: {
    DataInfo?: RawTicketItem[];
    Total?: number;
    Pagination?: { Page?: number; Limit?: number };
  };
  Message?: string;
  Code?: number;
  Success?: boolean;
}

// Support different field case variations in ticket detail responses.
export interface RawTicketStatusObject {
  value?: string | number;
  label?: string;
}

export interface RawTicketProcessStage {
  value?: number;
  label?: string;
}

export interface RawTicketValues {
  vid?: string;
  title?: string;
  status?: RawTicketStatusObject;
  Status?: RawTicketStatusObject;
  gmt_create?: number;
  GmtCreate?: number;
  category?: string;
  Category?: string;
  product_name?: string;
  ProductName?: string;
  process_stage?: RawTicketProcessStage;
  ProcessStage?: RawTicketProcessStage;
  description?: string;
  Description?: string;
}

export interface RawGetTicketResponse {
  Data?: {
    Values?: RawTicketValues;
    values?: RawTicketValues;
  };
  Message?: string;
  Code?: number;
  Success?: boolean;
}

// Handle multiple API response formats for message lists.
export interface RawMessageUserInfo {
  role?: string | number;
  Role?: string | number;
  displayName?: string;
  DisplayName?: string;
  nickName?: string;
  NickName?: string;
  userName?: string;
  UserName?: string;
}

export interface RawMessageDataInfo {
  content?: string;
  Content?: string;
  // System/template messages carry their text in a structured form schema
  // (JSON string) instead of Content.
  Schema?: string;
  schema?: string;
}

export interface RawMessageItem {
  userInfo?: RawMessageUserInfo;
  UserInfo?: RawMessageUserInfo;
  dataInfo?: RawMessageDataInfo;
  DataInfo?: RawMessageDataInfo;
  gmtCreate?: number;
  GmtCreate?: number;
  CreateTime?: number;
  Timestamp?: number;
}

export interface RawListEnhancedMessageResponse {
  Data?: {
    dataList?: RawMessageItem[];
    DataList?: RawMessageItem[];
  };
  Message?: string;
  Code?: number;
  Success?: boolean;
}

// Domain models

export interface SupportTicket {
  id: string;
  title: string;
  status: string;
  createdAt: number; // millisecond timestamp
}

export interface SupportMessage {
  role: string;
  nickName: string;
  content: string;
  createdAt: number; // millisecond timestamp
}

export interface SupportTicketDetail {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  category: string;
  description: string;
}

export interface SupportTicketListResult {
  tickets: SupportTicket[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SupportMessagesResult {
  messages: SupportMessage[];
  truncated: boolean;
}

// Category tree (returned by GetCategoryTreeByProductCodes)

export interface RawCategoryNode {
  id?: string | number;
  Id?: string | number;
  categoryId?: string | number;
  CategoryId?: string | number;
  name?: string;
  Name?: string;
  categoryName?: string;
  CategoryName?: string;
  children?: RawCategoryNode[];
  Children?: RawCategoryNode[];
  subCategoryList?: RawCategoryNode[];
  SubCategoryList?: RawCategoryNode[];
}

export interface RawGetCategoryTreeResponse {
  Data?: RawCategoryNode[] | { List?: RawCategoryNode[]; list?: RawCategoryNode[] };
  Message?: string;
  Code?: number;
  Success?: boolean;
}

export interface CategoryNode {
  id: string;
  name: string;
  helpUrl?: string;
  children?: CategoryNode[];
}

// Category suggestion (returned by SuggestCategoryNew)

export interface RawCategorySuggestion {
  categoryId?: string | number;
  CategoryId?: string | number;
  categoryName?: string;
  CategoryName?: string;
  categoryPath?: string;
  CategoryPath?: string;
  path?: string;
  Path?: string;
  score?: number;
  Score?: number;
}

export interface RawSuggestCategoryResponse {
  Data?:
    | RawCategorySuggestion[]
    | {
        List?: RawCategorySuggestion[];
        list?: RawCategorySuggestion[];
        Suggestions?: RawCategorySuggestion[];
        suggestions?: RawCategorySuggestion[];
        suggestCategoryDtos?: RawCategorySuggestion[];
        SuggestCategoryDtos?: RawCategorySuggestion[];
      };
  // Some gateways unwrap one level — payload may surface directly on the
  // response root rather than nested inside `Data`.
  traceId?: string;
  suggestCategoryDtos?: RawCategorySuggestion[];
  SuggestCategoryDtos?: RawCategorySuggestion[];
  Message?: string;
  Code?: number;
  Success?: boolean;
}

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  score?: number;
}

// Create ticket

export interface CreateTicketParams {
  categoryId: string;
  description: string;
}

export interface RawCreateTicketResponse {
  Data?: { vid?: string; Vid?: string } | string;
  Message?: string;
  Code?: number;
  Success?: boolean;
}

// Risk-word identification (IdentifyCustomerWord)

export interface RawIdentifyRiskWordResponse {
  Data?:
    | {
        hasRisk?: boolean;
        HasRisk?: boolean;
        words?: string[];
        Words?: string[];
        riskWords?: string[];
        RiskWords?: string[];
        hit?: boolean;
        Hit?: boolean;
      }
    | boolean
    | string[];
  Message?: string;
  Code?: number;
  Success?: boolean;
}

export interface RiskWordCheckResult {
  hasRisk: boolean;
  words?: string[];
}

// Rate ticket

export interface AssessmentCardData {
  editable: boolean; // Editable === 1 (rating flow can be entered)
  hasCard: boolean; // assessment card present (ticket closed with a rating card)
  alreadyRated: boolean; // already rated
  satisfaction?: number; // existing rating value 1-5; undefined when not yet rated
  schemaId: number;
  bizType: string;
  answerType: string;
  cardBizId: string;
  dialogId: number;
  ticketId: string;
  isStar: boolean;
  goodTags: string[];
  badTags: string[];
}

export type AssessmentCardMetadata = Omit<
  AssessmentCardData,
  'editable' | 'hasCard' | 'alreadyRated' | 'satisfaction' | 'goodTags' | 'badTags'
>;

export interface RateTicketParams {
  ticketId: string;
  rating: number; // 0-2
  comment?: string;
  metadata?: AssessmentCardMetadata;
  tags?: { good?: string[]; bad?: string[] };
}

export interface RateTicketResponse {
  ticketId: string;
  rating: number;
  status: string;
  timestamp?: string;
}
