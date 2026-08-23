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
}

/** An organization as seen by the signed-in caller, carrying their standing
 * in it so the client never has to cross-reference a separate members call. */
export interface OrganizationMembershipView extends Organization {
  role: OrgRole;
  memberCount: number;
}

export interface OrgMember {
  id: string;
  orgId: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: OrgRole;
  status: OrgMemberStatus;
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
  /** Null when the caller is not signed in (only possible when mode is 'clerk'). */
  viewer: {
    userId: string;
    displayName: string;
    email: string | null;
  } | null;
  organizations: OrganizationMembershipView[];
}

export interface CreateOrganizationRequest {
  name: string;
}

export interface UpdateOrgMemberRequest {
  role?: OrgRole;
  status?: OrgMemberStatus;
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
  /** Username or display name as entered when `kind` is `username`. */
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
  /** Invite this username or display name. Mutually exclusive with `email`. */
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
