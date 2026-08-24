// Organization-wide search: one box over every surface the caller can see.
//
// Visibility is the reporting chain. You see your own work, work from people
// you report to, and work from people who report to you (recursively). Peers
// outside that chain do not appear. Existing per-item ACLs (private apps,
// private chat channels) still apply on top.
//
// Matching is natural-language-friendly rather than a raw substring: stopwords
// drop out, remaining tokens score title/body, and kind words ("invoice",
// "slides", "page") bias the matching surface.

export const ORG_SEARCH_KINDS = [
  'project',
  'file',
  'page',
  'app',
  'chat',
  'record',
  'calendar',
] as const;

export type OrgSearchKind = (typeof ORG_SEARCH_KINDS)[number];

export interface OrgSearchHit {
  kind: OrgSearchKind;
  id: string;
  title: string;
  snippet: string | null;
  /** Client path to open this result. */
  href: string;
  ownerMemberId: string | null;
  ownerName: string | null;
  sourceLabel: string;
  score: number;
  updatedAt: number;
  projectId?: string;
  fileName?: string;
  pageId?: string;
  appId?: string;
  channelId?: string;
  tableName?: string;
  recordId?: string;
  eventId?: string;
}

export interface OrgSearchResponse {
  query: string;
  hits: OrgSearchHit[];
}
