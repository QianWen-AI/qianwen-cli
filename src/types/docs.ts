// Docs search response

/** Raw single SearchAll item — fields use actual upstream names. */
export interface RawSearchAllItem {
  // Actual API response fields
  title?: string | null;
  content?: string | null; // highlighted content with <em> tags
  description?: string | null; // alternative summary field
  subBizType?: string | null;
  url?: string | null;
  nodesInfo?: string | null; // JSON string: [{nodeName, nodeUrl}]
  extInfo?: string | null; // JSON string with paragraph metadata
  id?: string | null;
  // Normalized / legacy field names (backward compat)
  highlightedTitle?: string | null;
  summary?: string | null;
  highlightedSummary?: string | null;
  breadcrumb?: string[] | null;
}

/** Raw response type (uses upstream field naming). */
export interface RawSearchAllResponse {
  // Actual API response (PascalCase)
  TotalCount?: number | null;
  PageNo?: number | null;
  Info?: RawSearchAllItem[] | null;
  ErrorCode?: string | null;
  Message?: string | null;
  // Legacy / normalized field names (backward compat with tests)
  totalCount?: number | null;
  pageNo?: number | null;
  pageSize?: number | null;
  items?: RawSearchAllItem[] | null;
}

/** Normalized single docs search item consumed by the view-model layer. */
export interface DocsSearchItem {
  title: string;
  highlightedTitle: string;
  subBizType: string;
  url: string;
  summary: string;
  highlightedSummary: string;
  breadcrumb: string[];
}

export interface DocsSearchResponse {
  totalCount: number;
  page: number;
  pageSize: number;
  items: DocsSearchItem[];
  rawItems?: RawSearchAllItem[];
}

export interface DocContentResult {
  url: string;
  resolvedMarkdownUrl: string;
  content: string | null;
  error: string | null;
  anchor: string | null;
}

/** A single entry parsed from the upstream llms.txt directory index. */
export interface DocsIndexEntry {
  path: string;
  fullUrl: string;
  title: string;
  description: string;
  section: string;
}

/** Result of resolving a user-supplied docs path against the index. */
export type ResolveResult =
  | { type: 'exact'; url: string }
  | { type: 'ambiguous'; candidates: DocsIndexEntry[] }
  | { type: 'notfound'; suggestions: DocsIndexEntry[] };
