// Apps: a generated tool, published so the rest of the organization can use it.
//
// A project is where someone builds; an app is what their coworkers open. The
// same HTML file can be iterated on daily inside its project while the app
// entry stays a stable thing people bookmark and return to.
//
// Visibility is deliberately a three-step ladder rather than a boolean:
//   private — only the publisher sees it in the org gallery
//   org     — every member of the organization can open it
//   link    — additionally reachable by anyone holding an unguessable link
//
// Access mode (orthogonal to visibility for org-visible apps):
//   org         — every member can view; creator + admins (+ edit grants) can edit
//   restricted  — only listed Viewers/Editors/teams (plus creator + admins) can see it
//
// Denials are a subtractive list that applies on top of either mode: a named
// person cannot open the app even if the rest of the org (or their team) can.
// Creator and admins still can. There is no way to hide an app from an admin.
//
// Link-shared apps are served WITHOUT access to the organization's database.
// Data-connected apps require a signed-in member, so an anonymous link can
// never become a hole into company records.

import type { AppDataScope } from './app-runtime.js';

export type AppVisibility = 'private' | 'org' | 'link';

export type AppStatus = 'active' | 'archived';

/** Who in the org may see the app when it is not private. */
export type AppAccessMode = 'org' | 'restricted';

/** Grant on a restricted (or optionally elevated) app. */
export type AppGrantRole = 'view' | 'edit';

export interface AppGrant {
  memberId: string;
  /** Display name when the daemon can resolve it. */
  memberName: string | null;
  role: AppGrantRole;
}

/** A whole named team granted view or edit, expanded at read time. */
export interface AppTeamGrant {
  teamId: string;
  teamName: string | null;
  role: AppGrantRole;
}

/** A person who must not open the app, even under org-wide or team access. */
export interface AppDenial {
  memberId: string;
  memberName: string | null;
}

/** Full audience policy: who is included, which teams, and who is excluded. */
export interface AppAccessPolicy {
  grants: AppGrant[];
  teamGrants: AppTeamGrant[];
  denials: AppDenial[];
}

export interface OrgApp {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  /** Project that owns the source file. */
  projectId: string;
  /** Entry file inside the project, e.g. "expense-form.html". */
  filePath: string;
  visibility: AppVisibility;
  status: AppStatus;
  /** Whole-org view vs selected members only. */
  accessMode: AppAccessMode;
  /** When true, the app appears under Apps in the entry nav rail. */
  pinned: boolean;
  pinnedAt: number | null;
  /** Member id of the publisher. */
  createdBy: string;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Most recent open, for "recently used" ordering. Null if never opened. */
  lastOpenedAt: number | null;
  openCount: number;
  /** Tables this app declared it needs, checked on every bridge request and
   * shown to a person before they run it. Empty means it touches no data. */
  dataScopes: AppDataScope[];
  /** Lasting public URL after one-click publish. Null until published to the web. */
  webUrl: string | null;
}

export interface PublishAppRequest {
  /** Tables the app needs. Malformed entries are dropped rather than failing
   * the publish — the result is less access, never more. */
  dataScopes?: AppDataScope[];
  name: string;
  description?: string;
  projectId: string;
  filePath: string;
  visibility?: AppVisibility;
  accessMode?: AppAccessMode;
  pinned?: boolean;
  /** Initial grants when accessMode is restricted (or to give edit beyond default). */
  grants?: Array<{ memberId: string; role: AppGrantRole }>;
  /** Grant a named org team rather than listing every member. */
  teamGrants?: Array<{ teamId: string; role: AppGrantRole }>;
  /** People who must not open the app, even if the rest of the org can. */
  denials?: Array<{ memberId: string }>;
}

export interface UpdateAppRequest {
  name?: string;
  description?: string;
  visibility?: AppVisibility;
  status?: AppStatus;
  /** Repoint the app at a different file in the same project. */
  filePath?: string;
  accessMode?: AppAccessMode;
  pinned?: boolean;
  /** Replace the tables this app may read or change. Omit to leave them
   * unchanged; pass `[]` to revoke every grant. Malformed entries drop. */
  dataScopes?: AppDataScope[];
}

export interface SetAppGrantsRequest {
  grants: Array<{ memberId: string; role: AppGrantRole }>;
  /** Omit to leave existing team grants unchanged. Pass [] to clear. */
  teamGrants?: Array<{ teamId: string; role: AppGrantRole }>;
  /** Omit to leave existing denials unchanged. Pass [] to clear. */
  denials?: Array<{ memberId: string }>;
}

export interface AppGrantsResponse extends AppAccessPolicy {}

/** A link-share on an app. The token is returned once, at creation. */
export interface AppShareLink {
  id: string;
  appId: string;
  createdBy: string;
  expiresAt: number | null;
  revokedAt: number | null;
  viewCount: number;
  createdAt: number;
}

export interface CreateAppShareLinkRequest {
  /** Hours until the link stops working. Omit for a link that never expires. */
  expiresInHours?: number;
}

export interface AppShareLinkCreatedResponse {
  share: AppShareLink;
  url: string;
  token: string;
}

export interface AppResponse {
  app: OrgApp;
}

export interface AppsResponse {
  apps: OrgApp[];
}

/** An app carrying the name of the organization it belongs to.
 *
 * Only needed by the cross-organization view: within one organization the
 * name is ambient, but a list spanning several is unreadable without saying
 * which is which. */
export interface OrgAppWithOrgName extends OrgApp {
  orgName: string;
}

export interface AllOrgAppsResponse {
  apps: OrgAppWithOrgName[];
}

export interface AppShareLinksResponse {
  shares: AppShareLink[];
}

/** One-click publish of an app-builder app onto the public web. */
export interface PublishAppToWebResponse {
  app: OrgApp;
  url: string;
}
