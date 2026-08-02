// Organization registry: organizations, their members, and their invite links.
//
// Written against `SqlExecutor` rather than a concrete database, so the same
// code is the system of record whether the operator is running a local SQLite
// file (default, offline) or Supabase Postgres (shared, multi-machine). An
// organization whose members are on different laptops only works on the
// latter; see specs/current/organizations-on-supabase.md.
//
// Storage still names the tenant "workspace" (od_workspaces and friends)
// because those tables predate the org naming; Organization is the name at
// every boundary a caller touches. This module is the translation layer.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  LOCAL_OWNER_USER_ID,
  roleAtLeast,
  type CreateOrgInviteRequest,
  type Organization,
  type OrganizationMembershipView,
  type OrgInvite,
  type OrgMember,
  type OrgRole,
} from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';

const ORG_COLS =
  'id, name, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"';

const MEMBER_COLS = `
  m.id, m.workspace_id AS "orgId", m.user_id AS "userId",
  u.display_name AS "displayName", u.email,
  m.role, m.status, m.created_at AS "createdAt", m.updated_at AS "updatedAt"
`;

const INVITE_COLS = `
  id, workspace_id AS "orgId", role, created_by AS "createdBy",
  expires_at AS "expiresAt", max_uses AS "maxUses", use_count AS "useCount",
  revoked_at AS "revokedAt", created_at AS "createdAt"
`;

const ROLES = new Set<OrgRole>(['owner', 'admin', 'member']);

function assertRole(role: unknown): OrgRole {
  if (typeof role !== 'string' || !ROLES.has(role as OrgRole)) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'role must be one of: owner, admin, member');
  }
  return role as OrgRole;
}

/** Postgres returns BIGINT as a string to avoid precision loss. Epoch
 * milliseconds fit in a JS number comfortably, and the contracts type them
 * that way, so normalize at the boundary rather than leaking strings upward. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function normalizeOrg(row: Record<string, any>): Organization {
  return { ...(row as Organization), createdAt: num(row.createdAt), updatedAt: num(row.updatedAt) };
}

function normalizeMember(row: Record<string, any>): OrgMember {
  return {
    ...(row as OrgMember),
    email: row.email ?? null,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

function normalizeInvite(row: Record<string, any>): OrgInvite {
  return {
    ...(row as OrgInvite),
    expiresAt: row.expiresAt === null || row.expiresAt === undefined ? null : num(row.expiresAt),
    maxUses: row.maxUses === null || row.maxUses === undefined ? null : num(row.maxUses),
    useCount: num(row.useCount),
    revokedAt: row.revokedAt === null || row.revokedAt === undefined ? null : num(row.revokedAt),
    createdAt: num(row.createdAt),
  };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare so a token guess cannot be narrowed by timing. */
export function tokenHashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- Users ----------------------------------------------------------------

export interface DirectoryUser {
  id: string;
  displayName: string;
  email: string | null;
}

export async function ensureLocalOwnerUser(directory: SqlExecutor): Promise<string> {
  const existing = await directory.get<{ id: string }>('SELECT id FROM od_users WHERE id = ?', [
    LOCAL_OWNER_USER_ID,
  ]);
  if (existing) return existing.id;
  const now = Date.now();
  await directory.run(
    'INSERT INTO od_users (id, display_name, email, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    [LOCAL_OWNER_USER_ID, 'Local Owner', now, now],
  );
  return LOCAL_OWNER_USER_ID;
}

/** Find-or-create the directory user backing an external identity. Called on
 * every authenticated request, so it must stay idempotent and cheap. */
export async function upsertExternalUser(
  directory: SqlExecutor,
  input: { externalId: string; displayName: string; email: string | null },
): Promise<DirectoryUser> {
  const existing = await directory.get<DirectoryUser>(
    'SELECT id, display_name AS "displayName", email FROM od_users WHERE clerk_user_id = ?',
    [input.externalId],
  );
  const now = Date.now();
  if (existing) {
    // Profile edits upstream should show up here without a separate sync.
    if (existing.displayName !== input.displayName || (existing.email ?? null) !== input.email) {
      await directory.run('UPDATE od_users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?', [
        input.displayName,
        input.email,
        now,
        existing.id,
      ]);
    }
    return { id: existing.id, displayName: input.displayName, email: input.email };
  }
  const id = `user-${randomUUID()}`;
  await directory.run(
    `INSERT INTO od_users (id, clerk_user_id, display_name, email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.externalId, input.displayName, input.email, now, now],
  );
  return { id, displayName: input.displayName, email: input.email };
}

export async function getUser(directory: SqlExecutor, userId: string): Promise<DirectoryUser | null> {
  const row = await directory.get<DirectoryUser>(
    'SELECT id, display_name AS "displayName", email FROM od_users WHERE id = ?',
    [userId],
  );
  return row ? { ...row, email: row.email ?? null } : null;
}

// --- Organizations --------------------------------------------------------

export async function createOrganization(
  directory: SqlExecutor,
  input: { name: string; ownerUserId: string },
): Promise<Organization> {
  const name = input.name.trim();
  if (!name) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'organization name is required');
  }
  const now = Date.now();
  const orgId = `ws-${randomUUID()}`;
  const memberId = `wsm-${randomUUID()}`;
  await directory.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO od_workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [orgId, name, memberId, now, now],
    );
    await tx.run(
      `INSERT INTO od_workspace_members
         (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
      [memberId, orgId, input.ownerUserId, now, now],
    );
  });
  return getOrganization(directory, orgId);
}

export async function listOrganizations(directory: SqlExecutor): Promise<Organization[]> {
  const rows = await directory.all<Record<string, any>>(
    `SELECT ${ORG_COLS} FROM od_workspaces ORDER BY created_at ASC`,
  );
  return rows.map(normalizeOrg);
}

/** Organizations the user actually belongs to, each carrying their role. This
 * is what the client bootstraps from — never the unfiltered list. */
export async function listOrganizationsForUser(
  directory: SqlExecutor,
  userId: string,
): Promise<OrganizationMembershipView[]> {
  const rows = await directory.all<Record<string, any>>(
    `SELECT w.id, w.name, w.created_by AS "createdBy",
            w.created_at AS "createdAt", w.updated_at AS "updatedAt",
            m.role,
            (SELECT COUNT(*) FROM od_workspace_members mc
              WHERE mc.workspace_id = w.id AND mc.status = 'active') AS "memberCount"
       FROM od_workspaces w
       JOIN od_workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND m.status = 'active'
      ORDER BY w.created_at ASC`,
    [userId],
  );
  return rows.map((row) => ({
    ...normalizeOrg(row),
    role: row.role as OrgRole,
    memberCount: num(row.memberCount),
  }));
}

export async function getOrganization(directory: SqlExecutor, orgId: string): Promise<Organization> {
  const row = await directory.get<Record<string, any>>(
    `SELECT ${ORG_COLS} FROM od_workspaces WHERE id = ?`,
    [orgId],
  );
  if (!row) {
    throw new WorkspaceDataError('ORG_NOT_FOUND', 404, `organization ${orgId} not found`);
  }
  return normalizeOrg(row);
}

export async function renameOrganization(
  directory: SqlExecutor,
  orgId: string,
  name: string,
): Promise<Organization> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'organization name is required');
  }
  await getOrganization(directory, orgId);
  await directory.run('UPDATE od_workspaces SET name = ?, updated_at = ? WHERE id = ?', [
    trimmed,
    Date.now(),
    orgId,
  ]);
  return getOrganization(directory, orgId);
}

// --- Members --------------------------------------------------------------

export async function listOrgMembers(directory: SqlExecutor, orgId: string): Promise<OrgMember[]> {
  await getOrganization(directory, orgId);
  const rows = await directory.all<Record<string, any>>(
    `SELECT ${MEMBER_COLS}
       FROM od_workspace_members m JOIN od_users u ON u.id = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY m.created_at ASC`,
    [orgId],
  );
  return rows.map(normalizeMember);
}

export async function getActiveMemberForUser(
  directory: SqlExecutor,
  orgId: string,
  userId: string,
): Promise<OrgMember | null> {
  const row = await directory.get<Record<string, any>>(
    `SELECT ${MEMBER_COLS}
       FROM od_workspace_members m JOIN od_users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.user_id = ? AND m.status = 'active'`,
    [orgId, userId],
  );
  return row ? normalizeMember(row) : null;
}

export async function getOrgMember(
  directory: SqlExecutor,
  orgId: string,
  memberId: string,
): Promise<OrgMember> {
  const row = await directory.get<Record<string, any>>(
    `SELECT ${MEMBER_COLS}
       FROM od_workspace_members m JOIN od_users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.id = ?`,
    [orgId, memberId],
  );
  if (!row) {
    throw new WorkspaceDataError('ORG_MEMBER_NOT_FOUND', 404, `member ${memberId} not found`);
  }
  return normalizeMember(row);
}

async function countActiveOwners(
  directory: SqlExecutor,
  orgId: string,
  excludingMemberId: string,
): Promise<number> {
  const row = await directory.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM od_workspace_members
      WHERE workspace_id = ? AND role = 'owner' AND status = 'active' AND id != ?`,
    [orgId, excludingMemberId],
  );
  return num(row?.n ?? 0);
}

/** Change a member's role or status. Refuses to strip the last owner —
 * an organization with no owner can never be administered again. */
export async function updateOrgMember(
  directory: SqlExecutor,
  orgId: string,
  memberId: string,
  patch: { role?: OrgRole; status?: 'active' | 'removed' },
): Promise<OrgMember> {
  const member = await getOrgMember(directory, orgId, memberId);
  const nextRole = patch.role === undefined ? member.role : assertRole(patch.role);
  const nextStatus = patch.status ?? member.status;
  const losesOwnership =
    member.role === 'owner' && member.status === 'active' && (nextRole !== 'owner' || nextStatus !== 'active');
  if (losesOwnership && (await countActiveOwners(directory, orgId, memberId)) === 0) {
    throw new WorkspaceDataError(
      'ORG_LAST_OWNER',
      409,
      'this is the only owner; promote another member to owner first',
    );
  }
  await directory.run('UPDATE od_workspace_members SET role = ?, status = ?, updated_at = ? WHERE id = ?', [
    nextRole,
    nextStatus,
    Date.now(),
    memberId,
  ]);
  return getOrgMember(directory, orgId, memberId);
}

export function assertMemberRole(member: OrgMember | null, minimum: OrgRole, orgId: string): OrgMember {
  if (!member) {
    throw new WorkspaceDataError(
      'ORG_MEMBERSHIP_REQUIRED',
      403,
      `you are not a member of organization ${orgId}`,
    );
  }
  if (!roleAtLeast(member.role, minimum)) {
    throw new WorkspaceDataError(
      'ORG_ROLE_REQUIRED',
      403,
      `this action requires the ${minimum} role; you are ${member.role}`,
      { required: minimum, actual: member.role },
    );
  }
  return member;
}

// --- Invites --------------------------------------------------------------

export interface CreatedInvite {
  invite: OrgInvite;
  token: string;
}

export async function createOrgInvite(
  directory: SqlExecutor,
  orgId: string,
  createdByMemberId: string,
  input: CreateOrgInviteRequest = {},
): Promise<CreatedInvite> {
  await getOrganization(directory, orgId);
  const role = input.role === undefined ? 'member' : assertRole(input.role);
  if (input.expiresInHours !== undefined) {
    if (!Number.isFinite(input.expiresInHours) || input.expiresInHours <= 0) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'expiresInHours must be a positive number');
    }
  }
  if (input.maxUses !== undefined) {
    if (!Number.isInteger(input.maxUses) || input.maxUses <= 0) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'maxUses must be a positive integer');
    }
  }
  const now = Date.now();
  const id = `inv-${randomUUID()}`;
  // 32 random bytes: the link is the entire credential, so it must be far
  // beyond guessing even when a stale link circulates in a chat thread.
  const token = randomBytes(32).toString('base64url');
  await directory.run(
    `INSERT INTO od_workspace_invites
       (id, workspace_id, token_hash, role, created_by, expires_at, max_uses, use_count, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    [
      id,
      orgId,
      hashInviteToken(token),
      role,
      createdByMemberId,
      input.expiresInHours === undefined ? null : now + input.expiresInHours * 3600_000,
      input.maxUses ?? null,
      now,
    ],
  );
  return { invite: await getOrgInvite(directory, id), token };
}

export async function getOrgInvite(directory: SqlExecutor, inviteId: string): Promise<OrgInvite> {
  const row = await directory.get<Record<string, any>>(
    `SELECT ${INVITE_COLS} FROM od_workspace_invites WHERE id = ?`,
    [inviteId],
  );
  if (!row) {
    throw new WorkspaceDataError('ORG_INVITE_INVALID', 404, 'invite not found');
  }
  return normalizeInvite(row);
}

export async function listOrgInvites(directory: SqlExecutor, orgId: string): Promise<OrgInvite[]> {
  await getOrganization(directory, orgId);
  const rows = await directory.all<Record<string, any>>(
    `SELECT ${INVITE_COLS} FROM od_workspace_invites WHERE workspace_id = ? ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.map(normalizeInvite);
}

export async function revokeOrgInvite(
  directory: SqlExecutor,
  orgId: string,
  inviteId: string,
): Promise<OrgInvite> {
  const invite = await getOrgInvite(directory, inviteId);
  if (invite.orgId !== orgId) {
    throw new WorkspaceDataError('ORG_INVITE_INVALID', 404, 'invite not found');
  }
  await directory.run('UPDATE od_workspace_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    Date.now(),
    inviteId,
  ]);
  return getOrgInvite(directory, inviteId);
}

export type InviteRejection = 'not-found' | 'revoked' | 'expired' | 'exhausted';

export interface InviteLookup {
  invite: OrgInvite;
  org: Organization;
}

/** Resolve a raw token to a usable invite, or explain why it is not usable.
 * Shared by the unauthenticated preview endpoint and the accept endpoint so
 * both agree on what "valid" means. */
export async function lookupInviteByToken(
  directory: SqlExecutor,
  token: string,
): Promise<{ ok: true; value: InviteLookup } | { ok: false; reason: InviteRejection }> {
  const tokenHash = hashInviteToken(token);
  const row = await directory.get<Record<string, any>>(
    `SELECT ${INVITE_COLS}, token_hash AS "tokenHash" FROM od_workspace_invites WHERE token_hash = ?`,
    [tokenHash],
  );
  if (!row || !tokenHashesMatch(String(row.tokenHash), tokenHash)) {
    return { ok: false, reason: 'not-found' };
  }
  const invite = normalizeInvite(row);
  if (invite.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (invite.expiresAt !== null && invite.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true, value: { invite, org: await getOrganization(directory, invite.orgId) } };
}

export interface AcceptedInvite {
  organization: Organization;
  member: OrgMember;
}

/** Redeem an invite for a user. Already-members are returned as-is rather than
 * erroring, so re-opening a link is harmless and does not burn a use. */
export async function acceptOrgInvite(
  directory: SqlExecutor,
  token: string,
  userId: string,
): Promise<AcceptedInvite> {
  const lookup = await lookupInviteByToken(directory, token);
  if (!lookup.ok) {
    if (lookup.reason === 'expired') {
      throw new WorkspaceDataError('ORG_INVITE_EXPIRED', 410, 'this invite link has expired');
    }
    if (lookup.reason === 'exhausted') {
      throw new WorkspaceDataError('ORG_INVITE_EXHAUSTED', 410, 'this invite link has reached its limit');
    }
    throw new WorkspaceDataError('ORG_INVITE_INVALID', 404, 'this invite link is not valid');
  }
  const { invite, org } = lookup.value;
  const existing = await getActiveMemberForUser(directory, org.id, userId);
  if (existing) return { organization: org, member: existing };

  const now = Date.now();
  const memberId = `wsm-${randomUUID()}`;
  await directory.transaction(async (tx) => {
    // Re-check the use count inside the transaction so two people clicking a
    // single-use link at the same time cannot both get in.
    const fresh = await tx.get<Record<string, any>>(
      'SELECT use_count AS "useCount", max_uses AS "maxUses", revoked_at AS "revokedAt" FROM od_workspace_invites WHERE id = ?',
      [invite.id],
    );
    if (!fresh || fresh.revokedAt !== null) {
      throw new WorkspaceDataError('ORG_INVITE_INVALID', 404, 'this invite link is not valid');
    }
    if (fresh.maxUses !== null && num(fresh.useCount) >= num(fresh.maxUses)) {
      throw new WorkspaceDataError('ORG_INVITE_EXHAUSTED', 410, 'this invite link has reached its limit');
    }
    await tx.run(
      `INSERT INTO od_workspace_members
         (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [memberId, org.id, userId, invite.role, now, now],
    );
    await tx.run('UPDATE od_workspace_invites SET use_count = use_count + 1 WHERE id = ?', [invite.id]);
  });
  return { organization: org, member: await getOrgMember(directory, org.id, memberId) };
}

/** Boot-time invariant: the daemon always has at least one organization owned
 * by the local owner, so keyless single-user mode works with zero setup. */
export async function ensureDefaultOrganization(directory: SqlExecutor): Promise<Organization> {
  const ownerUserId = await ensureLocalOwnerUser(directory);
  const first = (await listOrganizations(directory))[0];
  if (first) return first;
  return createOrganization(directory, { name: 'My Organization', ownerUserId });
}
