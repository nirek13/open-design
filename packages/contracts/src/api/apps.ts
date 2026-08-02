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
// Link-shared apps are served WITHOUT access to the organization's database.
// Data-connected apps require a signed-in member, so an anonymous link can
// never become a hole into company records.

export type AppVisibility = 'private' | 'org' | 'link';

export type AppStatus = 'active' | 'archived';

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
  /** Member id of the publisher. */
  createdBy: string;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Most recent open, for "recently used" ordering. Null if never opened. */
  lastOpenedAt: number | null;
  openCount: number;
}

export interface PublishAppRequest {
  name: string;
  description?: string;
  projectId: string;
  filePath: string;
  visibility?: AppVisibility;
}

export interface UpdateAppRequest {
  name?: string;
  description?: string;
  visibility?: AppVisibility;
  status?: AppStatus;
  /** Repoint the app at a different file in the same project. */
  filePath?: string;
}

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

export interface AppShareLinksResponse {
  shares: AppShareLink[];
}
