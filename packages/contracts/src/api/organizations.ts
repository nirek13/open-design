// Organizations: the tenant every person, project, app, and table belongs to.
//
// An organization is the unit people join and share inside. It owns exactly
// one permanent database (see ./workspace-data.js) and any number of apps
// (see ./apps.js). One person can belong to several organizations and switches
// between them; everything the product shows — projects, apps, tables, audit —
// is scoped to the active one.
//
// NAMING: the storage layer calls this entity a "workspace" (od_workspaces and
// friends) because it predates this module. Organization is the name at every
// boundary a person or a caller touches: API, CLI, and UI. Do not confuse it
// with ./workspaces.js (agent scratch dirs) or the browser-style workspace tabs
// in the web client.

export type OrgRole = 'owner' | 'admin' | 'member';

/** Ordered least → most privileged, for `roleAtLeast` comparisons. */
export const ORG_ROLE_ORDER: readonly OrgRole[] = ['member', 'admin', 'owner'];

export function roleAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return ORG_ROLE_ORDER.indexOf(role) >= ORG_ROLE_ORDER.indexOf(minimum);
}

export type OrgMemberStatus = 'active' | 'removed';

/** Who performed an action. `user` is an interactive person; `agent` is an AI
 * run acting through the token-gated tool surface; `public-form` is an
 * anonymous submission; `system` is the platform itself. */
export type OrgActorKind = 'user' | 'agent' | 'public-form' | 'system';

export interface Organization {
  id: string;
  name: string;
  /** Member id of the creator. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Public website used to scrape workspace branding. */
  websiteUrl?: string | null;
  /** Design system extracted from the website; new work defaults to this. */
  defaultDesignSystemId?: string | null;
  /** When first-run brand setup finished (or was skipped). Null means pending. */
  setupCompletedAt?: number | null;
}

/** An organization as seen by the signed-in caller, carrying their standing
 * in it so the client never has to cross-reference a separate members call. */
export interface OrganizationMembershipView extends Organization {
  role: OrgRole;
  memberCount: number;
  /** The caller's membership row in this organization, when known. */
  memberId?: string;
}

/** A named group of members inside an organization — Finance, contractors,
 * the design pod. Privilege stays on OrgRole (owner/admin/member); a team is
 * how you talk about a subset of people when granting or sending an app. */
export interface OrgTeam {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string | null;
  memberIds: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrgTeamRequest {
  name: string;
  description?: string;
  memberIds?: string[];
}

export interface UpdateOrgTeamRequest {
  name?: string;
  description?: string;
  /** Replace membership. Omit to leave members unchanged. */
  memberIds?: string[];
}

export interface OrgTeamsResponse {
  teams: OrgTeam[];
}

export interface OrgTeamResponse {
  team: OrgTeam;
}

export interface OrgMember {
  id: string;
  orgId: string;
  userId: string;
  displayName: string;
  email: string | null;
  /** Unique public handle teammates use to @mention and invite this person. */
  username: string | null;
  bio: string | null;
  /** Authenticated image URL when this person has uploaded a photo. */
  avatarUrl: string | null;
  role: OrgRole;
  status: OrgMemberStatus;
  /** Member id of this person's manager. Null if they sit at the top of the
   * org chart or have not been placed yet. Search (and any other hierarchy
   * scope) treats "above" as walking this pointer and "below" as everyone
   * who eventually points here. */
  reportsTo: string | null;
  createdAt: number;
  updatedAt: number;
}

/** How the daemon authenticated the current caller. `local-owner` is the
 * keyless single-user mode the local dev loop runs in. */
export type AuthMode = 'local-owner' | 'clerk';

/** Bootstrap payload for the client: how to authenticate, who the caller is,
 * and which organizations they can act in. Served unauthenticated so the SPA
 * can decide whether to render a sign-in screen. */
export interface AuthContextResponse {
  mode: AuthMode;
  /** Present when mode is 'clerk' — the browser SDK needs it to start a session. */
  publishableKey?: string;
  /**
   * HTTP(S) origin of the SPA. Packaged Electron windows load `od://app`,
   * which Clerk rejects as `redirect_url`; the client substitutes this origin.
   */
  appOrigin?: string;
  /** Null when the caller is not signed in (only possible when mode is 'clerk'). */
  viewer: {
    userId: string;
    displayName: string;
    email: string | null;
    username: string | null;
    bio: string | null;
    avatarUrl: string | null;
  } | null;
  organizations: OrganizationMembershipView[];
}

export interface CreateOrganizationRequest {
  name: string;
}

export interface UpdateOrganizationRequest {
  name?: string;
  websiteUrl?: string | null;
  defaultDesignSystemId?: string | null;
  /** Set true to mark first-run brand setup finished. */
  setupCompleted?: boolean;
}

/**
 * Turn a pasted invite into the raw token the accept endpoint expects.
 * Accepts a full `/join/<token>` URL, a path, or the token/code itself.
 */
export function parseJoinInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    const joinAt = parts.lastIndexOf('join');
    const token = joinAt >= 0 ? parts[joinAt + 1] : undefined;
    if (token) {
      return decodeURIComponent(token.replace(/\/+$/, ''));
    }
  } catch {
    // Not an absolute URL — fall through to path / bare token handling.
  }
  const pathMatch = /(?:^|\/)join\/([^/?#]+)/i.exec(trimmed);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1].replace(/\/+$/, ''));
  return trimmed;
}

export interface UpdateOrgMemberRequest {
  role?: OrgRole;
  status?: OrgMemberStatus;
  /** Set the manager. Null clears it. Must be another active member and must
   * not create a reporting cycle. */
  reportsTo?: string | null;
}

/** How an invite chooses its recipient. `link` is anyone who has the URL;
 * `email` and `username` are bound to one person and default to a single use. */
export type OrgInviteKind = 'link' | 'email' | 'username';

/** An invite is a shareable credential. The token is shown exactly once, at
 * creation; only its hash is stored. Email and username invites are also
 * redeemable by the matching signed-in person without the raw token. */
export interface OrgInvite {
  id: string;
  orgId: string;
  role: OrgRole;
  kind: OrgInviteKind;
  /** Lowercased email when `kind` is `email`. */
  targetEmail: string | null;
  /** Public username as entered when `kind` is `username`. */
  targetUsername: string | null;
  /** Directory user the invite was bound to, when one already existed. */
  targetUserId: string | null;
  createdBy: string;
  expiresAt: number | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface CreateOrgInviteRequest {
  role?: OrgRole;
  /** Hours until the invite stops working. Omit for a link that never expires,
   * or for a 14-day default on email/username invites. */
  expiresInHours?: number;
  /** How many people may join. Omit for unlimited links, or a single use on
   * email/username invites. */
  maxUses?: number;
  /** Invite this address. Mutually exclusive with `username`. */
  email?: string;
  /** Invite this public username. Mutually exclusive with `email`. */
  username?: string;
  /** When inviting by email, send the join link through the connected Gmail
   * account. Defaults to true. Creation still succeeds if sending fails. */
  sendEmail?: boolean;
}

export interface OrgInviteCreatedResponse {
  invite: OrgInvite;
  /** The full join URL, including the token. Shown once — never retrievable again. */
  url: string;
  token: string;
  /** True when the invite was actually emailed via the connected Gmail account. */
  emailed?: boolean;
  /** Present when we tried to email and Gmail refused. The invite still exists. */
  emailError?: string;
}

/** What an invite link shows before the visitor commits to joining. Safe to
 * serve unauthenticated: it names the organization but exposes no member data. */
export interface OrgInvitePreview {
  orgName: string;
  role: OrgRole;
  valid: boolean;
  /** True when only the named recipient may redeem this invite. Does not
   * reveal the email or username. */
  restricted?: boolean;
  /** Present when valid is false: 'expired' | 'revoked' | 'exhausted' | 'not-found'. */
  reason?: string;
}

/** A targeted invite waiting on the signed-in caller. No token — they join
 * because their email or username matches, not because they have the link. */
export interface OrgPendingInvite {
  id: string;
  orgId: string;
  orgName: string;
  role: OrgRole;
  kind: Exclude<OrgInviteKind, 'link'>;
  createdAt: number;
}

export interface OrgPendingInvitesResponse {
  invites: OrgPendingInvite[];
}

export interface OrganizationResponse {
  organization: Organization;
}

export interface OrganizationsResponse {
  organizations: OrganizationMembershipView[];
}

export interface OrgMembersResponse {
  members: OrgMember[];
}

export interface OrgInvitesResponse {
  invites: OrgInvite[];
}

export interface OrgInviteAcceptedResponse {
  organization: Organization;
  member: OrgMember;
}

/** Header the client sends to pin which organization a request acts in. */
export const ORG_HEADER = 'x-od-org';

/** Stable id of the synthesized local owner in keyless mode. All
 * unauthenticated interactive requests resolve to this identity, so audit
 * attribution stays coherent when real authentication is switched on later. */
export const LOCAL_OWNER_USER_ID = 'user-local-owner';

/** Clerk subject ids look like `user_2abc…`. They are identifiers, not names. */
const OPAQUE_USER_ID = /^user_[A-Za-z0-9]+$/;

export function isOpaqueUserId(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return !trimmed || OPAQUE_USER_ID.test(trimmed);
}

/** Clerk-less accounts are stored as "Member" / "Someone". Those are
 * placeholders, not names a teammate can use to tell people apart. */
const PLACEHOLDER_PERSON_NAMES = new Set(['member', 'someone']);

export function isPlaceholderPersonName(value: string | null | undefined): boolean {
  return PLACEHOLDER_PERSON_NAMES.has((value?.trim() ?? '').toLowerCase());
}

/** Pick a name a teammate can read. Never returns a Clerk user id or a
 * generic placeholder when a username or email is available. */
export function personLabel(
  input: {
    displayName?: string | null;
    username?: string | null;
    email?: string | null;
  },
  fallback = 'Member',
): string {
  const display = input.displayName?.trim() ?? '';
  if (display && !isOpaqueUserId(display) && !isPlaceholderPersonName(display)) {
    const at = display.indexOf('@');
    if (at > 0) return display.slice(0, at);
    return display;
  }
  const username = input.username?.trim() ?? '';
  if (username && !isOpaqueUserId(username)) return username;
  const email = input.email?.trim() ?? '';
  const at = email.indexOf('@');
  if (at > 0) return email.slice(0, at);
  if (email) return email;
  return fallback;
}

/** Sidebar / switcher label. Personal orgs created from a Clerk id look like
 * `user_abc… Organization` and should not be shown as a workspace name. */
export function workspaceLabel(name: string | null | undefined, fallback = 'Workspace'): string {
  const trimmed = name?.trim() ?? '';
  if (!trimmed || trimmed.startsWith('user_')) return fallback;
  return trimmed;
}
