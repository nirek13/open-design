// One-click hosting: publishing a project file to a public web address.
//
// Distinct from `api/deploy.ts`, which drives the bring-your-own-token Vercel
// and Cloudflare Pages path. That one puts a site on infrastructure the user
// owns and pays for; this one puts it on Open Design's, with no setup. Both
// stay available, and the vocabulary is kept apart on purpose — "deploy" means
// your own provider, "publish" means ours.
//
// The authority for everything below is cloud-side (Supabase Postgres, keyed on
// Clerk identity). The daemon holds no source of truth for a site; it reads
// project files, uploads bytes, and mirrors state for display.

/** Who can open a hosted site. */
export type SiteVisibility = 'public' | 'org';

export type SiteStatus =
  /** Live and serving. */
  | 'active'
  /** Taken down by the owner; the slug stays reserved to them. */
  | 'unpublished'
  /** Taken down by an operator after an abuse report. */
  | 'suspended';

export type PublishPhase =
  | 'preparing'
  | 'uploading'
  | 'committing'
  | 'live'
  | 'failed';

export interface HostedSite {
  id: string;
  slug: string;
  /** Fully-qualified public address, e.g. `https://my-app.od-sites.dev`. */
  url: string;
  visibility: SiteVisibility;
  status: SiteStatus;
  /** Clerk user id of the owner. */
  ownerUserId: string;
  /** Clerk organization id when published into an org; null when personal. */
  orgId: string | null;
  /** Project the site was published from. Provenance for the UI, not authority. */
  projectId: string | null;
  entryFile: string;
  liveVersionId: string | null;
  liveVersionNumber: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface HostedSiteVersion {
  id: string;
  siteId: string;
  versionNumber: number;
  fileCount: number;
  totalBytes: number;
  createdBy: string;
  createdAt: number;
  /** True for the version the live pointer currently references. */
  isLive: boolean;
}

// ---- Publishing ------------------------------------------------------------

export interface PublishSiteRequest {
  /** Entry file inside the project, e.g. `index.html`. */
  fileName: string;
  /** Omit on first publish to accept the suggested slug. */
  slug?: string;
  /** Defaults to `public`. `org` requires Clerk mode. */
  visibility?: SiteVisibility;
}

/** Progress for an in-flight publish, delivered over SSE and pollable. */
export interface PublishProgress {
  siteId: string | null;
  phase: PublishPhase;
  /** Blobs uploaded so far in this publish. */
  uploaded: number;
  /** Blobs this publish needs to upload; excludes ones already stored. */
  total: number;
  message: string | null;
}

export interface PublishSiteResponse {
  /** Correlates SSE progress events with this publish. */
  publishId: string;
  site: HostedSite | null;
  progress: PublishProgress;
}

export interface PublishResultResponse {
  site: HostedSite;
  version: HostedSiteVersion;
}

// ---- Management ------------------------------------------------------------

export interface UpdateSiteRequest {
  slug?: string;
  visibility?: SiteVisibility;
}

export interface RollbackSiteRequest {
  /** Version to make live. Must belong to this site. */
  versionId: string;
}

export interface SlugAvailabilityResponse {
  slug: string;
  available: boolean;
  /** Present when unavailable or malformed; safe to show verbatim. */
  reason: string | null;
  /** A valid alternative when the requested slug cannot be used. */
  suggestion: string | null;
}

export interface HostedSiteResponse {
  site: HostedSite;
}

export interface HostedSitesResponse {
  sites: HostedSite[];
}

export interface HostedSiteVersionsResponse {
  versions: HostedSiteVersion[];
}

// ---- Configuration ---------------------------------------------------------

/**
 * Whether publishing is usable on this daemon, and why not when it is not.
 *
 * The UI needs this to decide between showing a Publish button, a disabled
 * button with an explanation, or nothing at all. Failing at click time with an
 * opaque error would be the worse experience.
 */
export interface HostingCapability {
  /** Cloud hosting is configured on this daemon. */
  configured: boolean;
  /** The caller is signed in and may publish. */
  canPublish: boolean;
  /** `org` visibility is offered. False outside Clerk mode. */
  canPublishToOrg: boolean;
  /** Public site domain, e.g. `od-sites.dev`. Null when unconfigured. */
  sitesDomain: string | null;
  /** Why `canPublish` is false; null when it is true. */
  reason: HostingUnavailableReason | null;
}

export type HostingUnavailableReason =
  /** No hosting endpoint configured on this daemon. */
  | 'not-configured'
  /** Publishing needs a real identity; local-owner mode has none. */
  | 'sign-in-required'
  /** Signed in, but the account is over its site or storage allowance. */
  | 'quota-exceeded';

export interface HostingCapabilityResponse {
  hosting: HostingCapability;
}
