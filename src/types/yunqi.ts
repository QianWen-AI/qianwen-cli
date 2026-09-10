/** Forum types for the yunqi command group. */

/**
 * Inner business envelope shared by every MaasPortal POP action. The API layer
 * unwraps the outer gateway envelope (`code === '200'`); `Code` here is the
 * backend's own status and must be checked before `Data` is read.
 */
export interface RawMaasPortalEnvelope<TData> {
  Code?: number | string | null;
  Message?: string | null;
  Data?: TData | null;
  RequestId?: string | null;
}

export interface Forum {
  id: string;
  name: string;
  theme?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  industryList?: string[];
  interestList?: string[];
  technicalLevel?: string;
  topicList?: ForumTopic[];
  liveAddress?: string;
  subscribable?: boolean;
  extJson?: string;
}

export interface ForumTopic {
  durationMinutes?: string;
  topicTitle?: string;
  description?: string;
  guests?: ForumGuest[];
}

export interface ForumGuest {
  guestName?: string;
  guestTitle?: string;
  guestCompany?: string;
}

export interface ListForumsOptions {
  page?: number;
  pageSize?: number;
  industry?: string;
  interest?: string;
  location?: string;
  forumId?: string;
  keyword?: string;
  forumName?: string;
  memberName?: string;
  themeName?: string;
  topicName?: string;
  guestName?: string;
  companyName?: string;
}

export interface ForumListResult {
  forums: Forum[];
  page: number;
  pageSize: number;
  total: number;
}

/** Hall, zone and booth all arrive as the same `{ Code, Name }` pair. */
export interface ExhibitLocation {
  code?: string;
  name?: string;
}

export interface Exhibit {
  exhibitId?: string;
  exhibitCode?: string;
  name?: string;
  description?: string;
  hall?: ExhibitLocation;
  zone?: ExhibitLocation;
  booth?: ExhibitLocation;
}

/**
 * An exhibitor record carries no identity of its own — the backend reduced it to
 * a container for its booths, so every displayable field lives on `Exhibit`.
 */
export interface Exhibitor {
  exhibits?: Exhibit[];
  extJson?: string;
}

export interface ListExhibitorsOptions {
  page?: number;
  pageSize?: number;
  keyword?: string;
  companyName?: string;
  hallName?: string;
  zoneName?: string;
  boothName?: string;
  exhibitName?: string;
  enabled?: boolean;
}

export interface ExhibitorListResult {
  exhibitors: Exhibitor[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ForumSubscribeResult {
  success: boolean;
}

export interface ForumSubscription {
  forumId: string;
  forumName: string;
  forumStartTime: string;
  forumEndTime: string;
  status: string;
  statusText: string;
  viewed: boolean;
  extJson?: string;
}

export interface ForumSubscriptionCounts {
  notStartedCount: number;
  inProgressCount: number;
  summaryPreparingCount: number;
  summaryReadyCount: number;
  unviewedCount: number;
}

export interface ForumSubscriptionListResult extends ForumSubscriptionCounts {
  subscriptions: ForumSubscription[];
  extJson?: string;
}

export interface ForumSummary {
  forumId: string;
  summary: string;
  extJson?: string;
}
