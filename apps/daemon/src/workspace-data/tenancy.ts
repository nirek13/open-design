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
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  LOCAL_OWNER_USER_ID,
  isOpaqueUserId,
  isPlaceholderPersonName,
  parseUsername,
  roleAtLeast,
  usernameParseMessage,
  type CreateOrgInviteRequest,
  type CreateOrgTeamRequest,
  type Organization,
  type OrganizationMembershipView,
  type OrgInvite,
  type OrgInviteKind,
  type OrgMember,
  type OrgPendingInvite,
  type OrgRole,
  type OrgTeam,
  type UpdateOrgTeamRequest,
} from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import { reportsToWouldCycle } from './hierarchy.js';
import type { SqlExecutor } from '../storage/sql.js';

const ORG_COLS =
  'id, name, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt", website_url AS "websiteUrl", default_design_system_id AS "defaultDesignSystemId", setup_completed_at AS "setupCompletedAt"';

const MEMBER_COLS = `
  m.id, m.workspace_id AS "orgId", m.user_id AS "userId",
  u.display_name AS "displayName", u.email, u.username, u.bio,
  u.avatar_mime AS "avatarMime",
  m.role, m.status, m.reports_to AS "reportsTo",
  m.created_at AS "createdAt", m.updated_at AS "updatedAt"
`;

const INVITE_COLS = `
  id, workspace_id AS "orgId", role, kind,
  target_email AS "targetEmail", target_username AS "targetUsername",
  target_user_id AS "targetUserId", created_by AS "createdBy",
  expires_at AS "expiresAt", max_uses AS "maxUses", use_count AS "useCount",
  revoked_at AS "revokedAt", created_at AS "createdAt"
`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TARGETED_INVITE_TTL_MS = 14 * 24 * 3600_000;

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
  return {
    id: String(row.id),
    name: String(row.name),
    createdBy: String(row.createdBy),
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
    websiteUrl: typeof row.websiteUrl === 'string' && row.websiteUrl.trim() ? row.websiteUrl.trim() : null,
    defaultDesignSystemId:
      typeof row.defaultDesignSystemId === 'string' && row.defaultDesignSystemId.trim()
        ? row.defaultDesignSystemId.trim()
        : null,
    setupCompletedAt: row.setupCompletedAt == null || row.setupCompletedAt === '' ? null : num(row.setupCompletedAt),
  };
}

function normalizeMember(row: Record<string, any>): OrgMember {
  return {
    id: String(row.id),
    orgId: String(row.orgId),
    userId: String(row.userId),
    displayName: String(row.displayName),
    email: row.email ?? null,
    username: row.username ?? null,
    bio: row.bio ?? null,
    avatarUrl: profileAvatarUrl(String(row.userId), row.avatarMime ?? null),
    role: row.role,
    status: row.status,
    reportsTo: typeof row.reportsTo === 'string' && row.reportsTo.trim() ? String(row.reportsTo) : null,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

function asInviteKind(value: unknown): OrgInviteKind {
  return value === 'email' || value === 'username' ? value : 'link';
}

function normalizeInvite(row: Record<string, any>): OrgInvite {
  return {
    id: String(row.id),
    orgId: String(row.orgId),
    role: row.role as OrgRole,
    kind: asInviteKind(row.kind),
    targetEmail: row.targetEmail ?? null,
    targetUsername: row.targetUsername ?? null,
    targetUserId: row.targetUserId ?? null,
    createdBy: String(row.createdBy),
    expiresAt: row.expiresAt === null || row.expiresAt === undefined ? null : num(row.expiresAt),
    maxUses: row.maxUses === null || row.maxUses === undefined ? null : num(row.maxUses),
    useCount: num(row.useCount),
    revokedAt: row.revokedAt === null || row.revokedAt === undefined ? null : num(row.revokedAt),
    createdAt: num(row.createdAt),
  };
}

function inviteIsOpen(invite: Pick<OrgInvite, 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>): boolean {
  if (invite.revokedAt !== null) return false;
  if (invite.expiresAt !== null && invite.expiresAt <= Date.now()) return false;
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return false;
  return true;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function assertEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (!EMAIL_RE.test(email)) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'email must be a valid address');
  }
  return email;
}

function assertUsername(raw: string): string {
  const parsed = parseUsername(raw);
  if (!parsed.ok) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, usernameParseMessage(parsed.error));
  }
  return parsed.username;
}

function seedUsername(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const parsed = parseUsername(raw);
  return parsed.ok ? parsed.username : null;
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
  username: string | null;
  bio: string | null;
  avatarMime: string | null;
}

const USER_COLS =
  'id, display_name AS "displayName", email, username, bio, avatar_mime AS "avatarMime"';

export function profileAvatarUrl(userId: string, avatarMime: string | null | undefined): string | null {
  return avatarMime ? `/api/users/${encodeURIComponent(userId)}/avatar` : null;
}

function normalizeUser(row: DirectoryUser): DirectoryUser {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email ?? null,
    username: row.username ?? null,
    bio: row.bio ?? null,
    avatarMime: row.avatarMime ?? null,
  };
}

/** Keep a chosen name when Clerk only has a generic fallback like "Member". */
function chooseDisplayName(existing: string | undefined, incoming: string): string {
  const incomingPlaceholder =
    !incoming.trim() || isOpaqueUserId(incoming) || isPlaceholderPersonName(incoming);
  const existingReal =
    Boolean(existing) && !isOpaqueUserId(existing) && !isPlaceholderPersonName(existing);
  if (incomingPlaceholder && existingReal) return existing!;
  return incoming.trim() || existing || 'Member';
}

async function usernameTakenByOther(
  directory: SqlExecutor,
  username: string,
  exceptUserId: string,
): Promise<boolean> {
  const row = await directory.get<{ id: string }>(
    'SELECT id FROM od_users WHERE lower(username) = lower(?) AND id != ?',
    [username, exceptUserId],
  );
  return Boolean(row);
}

export async function ensureLocalOwnerUser(directory: SqlExecutor): Promise<string> {
  const existing = await directory.get<{ id: string; username: string | null }>(
    'SELECT id, username FROM od_users WHERE id = ?',
    [LOCAL_OWNER_USER_ID],
  );
  if (existing) {
    if (!existing.username) {
      await directory.run('UPDATE od_users SET username = ? WHERE id = ? AND username IS NULL', [
        'local-owner',
        LOCAL_OWNER_USER_ID,
      ]);
    }
    return existing.id;
  }
  const now = Date.now();
  await directory.run(
    'INSERT INTO od_users (id, display_name, email, username, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
    [LOCAL_OWNER_USER_ID, 'Local Owner', 'local-owner', now, now],
  );
  return LOCAL_OWNER_USER_ID;
}

/** Find-or-create the directory user backing an external identity. Called on
 * every authenticated request, so it must stay idempotent and cheap. */
export async function upsertExternalUser(
  directory: SqlExecutor,
  input: { externalId: string; displayName: string; email: string | null; username?: string | null },
): Promise<DirectoryUser> {
  const existing = await directory.get<DirectoryUser>(
    `SELECT ${USER_COLS} FROM od_users WHERE clerk_user_id = ?`,
    [input.externalId],
  );
  const now = Date.now();
  const seededUsername = seedUsername(input.username);
  if (existing) {
    // A claimed handle is the person's public alias. Clerk may send a
    // username on every request; never overwrite one they already chose.
    const username = existing.username
      ? existing.username
      : seededUsername && !(await usernameTakenByOther(directory, seededUsername, existing.id))
        ? seededUsername
        : existing.username;
    const displayName = chooseDisplayName(existing.displayName, input.displayName);
    // Clerk session JWTs often omit email. Never blank a stored address — that
    // is how targeted email invites decide who may redeem the link.
    const email = input.email ?? existing.email;
    if (
      existing.displayName !== displayName ||
      (existing.email ?? null) !== (email ?? null) ||
      (existing.username ?? null) !== (username ?? null)
    ) {
      await directory.run(
        'UPDATE od_users SET display_name = ?, email = ?, username = ?, updated_at = ? WHERE id = ?',
        [displayName, email, username, now, existing.id],
      );
    }
    return {
      id: existing.id,
      displayName,
      email,
      username,
      bio: existing.bio,
      avatarMime: existing.avatarMime,
    };
  }
  const id = `user-${randomUUID()}`;
  const username =
    seededUsername && !(await usernameTakenByOther(directory, seededUsername, id))
      ? seededUsername
      : null;
  const displayName = chooseDisplayName(undefined, input.displayName);
  await directory.run(
    `INSERT INTO od_users (id, clerk_user_id, display_name, email, username, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.externalId, displayName, input.email, username, now, now],
  );
  return { id, displayName, email: input.email, username, bio: null, avatarMime: null };
}

export async function getUser(directory: SqlExecutor, userId: string): Promise<DirectoryUser | null> {
  const row = await directory.get<DirectoryUser>(`SELECT ${USER_COLS} FROM od_users WHERE id = ?`, [userId]);
  return row ? normalizeUser(row) : null;
}

export async function getUserByUsername(
  directory: SqlExecutor,
  username: string,
): Promise<DirectoryUser | null> {
  const parsed = parseUsername(username);
  if (!parsed.ok) return null;
  const row = await directory.get<DirectoryUser>(
    `SELECT ${USER_COLS} FROM od_users WHERE username IS NOT NULL AND lower(username) = ?`,
    [parsed.username],
  );
  return row ? normalizeUser(row) : null;
}

/** Claim or change the caller's public username. Unique across the directory. */
export async function setUserUsername(
  directory: SqlExecutor,
  userId: string,
  raw: string,
): Promise<DirectoryUser> {
  const username = assertUsername(raw);
  const existing = await getUser(directory, userId);
  if (!existing) {
    throw new WorkspaceDataError('NOT_FOUND', 404, `user ${userId} not found`);
  }
  if (existing.username === username) return existing;
  if (await usernameTakenByOther(directory, username, userId)) {
    throw new WorkspaceDataError('USERNAME_TAKEN', 409, `@${username} is already taken`);
  }
  const now = Date.now();
  try {
    await directory.run('UPDATE od_users SET username = ?, updated_at = ? WHERE id = ?', [
      username,
      now,
      userId,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed|duplicate key value|odx_users_username/i.test(message)) {
      throw new WorkspaceDataError('USERNAME_TAKEN', 409, `@${username} is already taken`);
    }
    throw err;
  }
  return { ...existing, username };
}

export async function updateUserProfile(
  directory: SqlExecutor,
  userId: string,
  patch: { username?: string; displayName?: string; bio?: string | null },
): Promise<DirectoryUser> {
  let user = await getUser(directory, userId);
  if (!user) {
    throw new WorkspaceDataError('NOT_FOUND', 404, `user ${userId} not found`);
  }
  if (typeof patch.username === 'string') {
    user = await setUserUsername(directory, userId, patch.username);
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  if (typeof patch.displayName === 'string') {
    const displayName = patch.displayName.trim();
    if (!displayName) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'display name is required');
    }
    if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      throw new WorkspaceDataError(
        'VALIDATION_FAILED',
        422,
        `display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
      );
    }
    if (isOpaqueUserId(displayName)) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'display name cannot be a user id');
    }
    updates.push('display_name = ?');
    params.push(displayName);
    user = { ...user, displayName };
  }
  if (patch.bio !== undefined) {
    const bio = (patch.bio ?? '').trim();
    if (bio.length > BIO_MAX_LENGTH) {
      throw new WorkspaceDataError(
        'VALIDATION_FAILED',
        422,
        `bio must be at most ${BIO_MAX_LENGTH} characters`,
      );
    }
    const stored = bio || null;
    updates.push('bio = ?');
    params.push(stored);
    user = { ...user, bio: stored };
  }
  if (updates.length > 0) {
    const now = Date.now();
    updates.push('updated_at = ?');
    params.push(now, userId);
    await directory.run(`UPDATE od_users SET ${updates.join(', ')} WHERE id = ?`, params);
  }
  return user;
}

export async function setUserAvatarMime(
  directory: SqlExecutor,
  userId: string,
  mime: string | null,
): Promise<DirectoryUser> {
  const existing = await getUser(directory, userId);
  if (!existing) {
    throw new WorkspaceDataError('NOT_FOUND', 404, `user ${userId} not found`);
  }
  await directory.run('UPDATE od_users SET avatar_mime = ?, updated_at = ? WHERE id = ?', [
    mime,
    Date.now(),
    userId,
  ]);
  return { ...existing, avatarMime: mime };
}

async function findUsersByEmail(directory: SqlExecutor, email: string): Promise<DirectoryUser[]> {
  const rows = await directory.all<DirectoryUser>(
    `SELECT ${USER_COLS} FROM od_users WHERE email IS NOT NULL AND lower(email) = ?`,
    [normalizeEmail(email)],
  );
  return rows.map(normalizeUser);
}

async function findUsersByUsername(directory: SqlExecutor, username: string): Promise<DirectoryUser[]> {
  const match = await getUserByUsername(directory, username);
  return match ? [match] : [];
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
            w.website_url AS "websiteUrl",
            w.default_design_system_id AS "defaultDesignSystemId",
            w.setup_completed_at AS "setupCompletedAt",
            m.role, m.id AS "memberId",
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
    ...(typeof row.memberId === 'string' ? { memberId: row.memberId } : {}),
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

export async function updateOrganization(
  directory: SqlExecutor,
  orgId: string,
  patch: {
    name?: string;
    websiteUrl?: string | null;
    defaultDesignSystemId?: string | null;
    setupCompleted?: boolean;
  },
): Promise<Organization> {
  await getOrganization(directory, orgId);
  const now = Date.now();
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'organization name is required');
    }
    await directory.run('UPDATE od_workspaces SET name = ?, updated_at = ? WHERE id = ?', [
      trimmed,
      now,
      orgId,
    ]);
  }
  if (patch.websiteUrl !== undefined) {
    const websiteUrl = patch.websiteUrl?.trim() ? patch.websiteUrl.trim() : null;
    await directory.run('UPDATE od_workspaces SET website_url = ?, updated_at = ? WHERE id = ?', [
      websiteUrl,
      now,
      orgId,
    ]);
  }
  if (patch.defaultDesignSystemId !== undefined) {
    const designSystemId = patch.defaultDesignSystemId?.trim() ? patch.defaultDesignSystemId.trim() : null;
    await directory.run(
      'UPDATE od_workspaces SET default_design_system_id = ?, updated_at = ? WHERE id = ?',
      [designSystemId, now, orgId],
    );
  }
  if (patch.setupCompleted === true) {
    await directory.run(
      'UPDATE od_workspaces SET setup_completed_at = ?, updated_at = ? WHERE id = ?',
      [now, now, orgId],
    );
  }
  return getOrganization(directory, orgId);
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
  patch: { role?: OrgRole; status?: 'active' | 'removed'; reportsTo?: string | null },
): Promise<OrgMember> {
  const member = await getOrgMember(directory, orgId, memberId);
  const nextRole = patch.role === undefined ? member.role : assertRole(patch.role);
  const nextStatus = patch.status ?? member.status;
  const nextReportsTo = patch.reportsTo === undefined ? member.reportsTo : patch.reportsTo;
  const losesOwnership =
    member.role === 'owner' && member.status === 'active' && (nextRole !== 'owner' || nextStatus !== 'active');
  if (losesOwnership && (await countActiveOwners(directory, orgId, memberId)) === 0) {
    throw new WorkspaceDataError(
      'ORG_LAST_OWNER',
      409,
      'this is the only owner; promote another member to owner first',
    );
  }
  if (nextReportsTo) {
    const manager = await getOrgMember(directory, orgId, nextReportsTo);
    if (manager.status !== 'active') {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'manager must be an active member of this organization');
    }
    const roster = await listOrgMembers(directory, orgId);
    if (reportsToWouldCycle(roster, memberId, nextReportsTo)) {
      throw new WorkspaceDataError(
        'ORG_REPORTS_CYCLE',
        409,
        'that manager would create a reporting cycle',
      );
    }
  }
  await directory.run(
    'UPDATE od_workspace_members SET role = ?, status = ?, reports_to = ?, updated_at = ? WHERE id = ?',
    [nextRole, nextStatus, nextReportsTo, Date.now(), memberId],
  );
  if (nextStatus === 'removed' && member.status === 'active') {
    await directory.run('DELETE FROM od_org_team_members WHERE workspace_id = ? AND member_id = ?', [
      orgId,
      memberId,
    ]);
    await directory.run(
      'UPDATE od_workspace_members SET reports_to = NULL, updated_at = ? WHERE workspace_id = ? AND reports_to = ?',
      [Date.now(), orgId, memberId],
    );
  }
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

// --- Teams ----------------------------------------------------------------

const TEAM_COLS = `
  id, workspace_id AS "orgId", slug, name, description,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
`;

function slugifyTeamName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'team';
}

function normalizeTeam(row: Record<string, any>, memberIds: string[]): OrgTeam {
  return {
    id: String(row.id),
    orgId: String(row.orgId),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ?? null,
    memberIds,
    createdBy: String(row.createdBy),
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

async function memberIdsForTeams(
  directory: SqlExecutor,
  orgId: string,
  teamIds: string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  for (const id of teamIds) grouped.set(id, []);
  if (teamIds.length === 0) return grouped;
  const placeholders = teamIds.map(() => '?').join(', ');
  const rows = await directory.all<{ teamId: string; memberId: string }>(
    `SELECT team_id AS "teamId", member_id AS "memberId" FROM od_org_team_members
      WHERE workspace_id = ? AND team_id IN (${placeholders})
      ORDER BY member_id`,
    [orgId, ...teamIds],
  );
  for (const row of rows) {
    grouped.get(row.teamId)?.push(row.memberId);
  }
  return grouped;
}

async function uniqueTeamSlug(
  directory: SqlExecutor,
  orgId: string,
  name: string,
  exceptId?: string,
): Promise<string> {
  const base = slugifyTeamName(name);
  for (let n = 0; n < 50; n += 1) {
    const slug = n === 0 ? base : `${base.slice(0, 40)}-${n + 1}`;
    const row = await directory.get<{ id: string }>(
      'SELECT id FROM od_org_teams WHERE workspace_id = ? AND slug = ?',
      [orgId, slug],
    );
    if (!row || row.id === exceptId) return slug;
  }
  return `${base.slice(0, 24)}-${randomUUID().slice(0, 8)}`;
}

async function replaceTeamMembers(
  directory: SqlExecutor,
  orgId: string,
  teamId: string,
  memberIds: string[] | undefined,
): Promise<void> {
  if (memberIds === undefined) return;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of memberIds) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const member = await getOrgMember(directory, orgId, id);
    if (member.status !== 'active') continue;
    unique.push(id);
  }
  await directory.run('DELETE FROM od_org_team_members WHERE team_id = ? AND workspace_id = ?', [teamId, orgId]);
  const now = Date.now();
  for (const memberId of unique) {
    await directory.run(
      `INSERT INTO od_org_team_members (team_id, workspace_id, member_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [teamId, orgId, memberId, now],
    );
  }
}

export async function listOrgTeams(directory: SqlExecutor, orgId: string): Promise<OrgTeam[]> {
  await getOrganization(directory, orgId);
  const rows = await directory.all<Record<string, any>>(
    `SELECT ${TEAM_COLS} FROM od_org_teams WHERE workspace_id = ? ORDER BY name ASC, created_at ASC`,
    [orgId],
  );
  const grouped = await memberIdsForTeams(
    directory,
    orgId,
    rows.map((row) => String(row.id)),
  );
  return rows.map((row) => normalizeTeam(row, grouped.get(String(row.id)) ?? []));
}

export async function getOrgTeam(directory: SqlExecutor, orgId: string, teamId: string): Promise<OrgTeam> {
  const row = await directory.get<Record<string, any>>(
    `SELECT ${TEAM_COLS} FROM od_org_teams WHERE workspace_id = ? AND id = ?`,
    [orgId, teamId],
  );
  if (!row) {
    throw new WorkspaceDataError('ORG_TEAM_NOT_FOUND', 404, `team ${teamId} not found`);
  }
  const grouped = await memberIdsForTeams(directory, orgId, [String(row.id)]);
  return normalizeTeam(row, grouped.get(String(row.id)) ?? []);
}

export async function listTeamIdsForMember(
  directory: SqlExecutor,
  orgId: string,
  memberId: string,
): Promise<string[]> {
  const rows = await directory.all<{ teamId: string }>(
    `SELECT team_id AS "teamId" FROM od_org_team_members
      WHERE workspace_id = ? AND member_id = ?`,
    [orgId, memberId],
  );
  return rows.map((row) => row.teamId);
}

export async function createOrgTeam(
  directory: SqlExecutor,
  orgId: string,
  createdByMemberId: string,
  input: CreateOrgTeamRequest,
): Promise<OrgTeam> {
  await getOrganization(directory, orgId);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'team name is required');
  }
  if (name.length > 80) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'team name must be 80 characters or fewer');
  }
  const description =
    typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null;
  if (description && description.length > 280) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'team description must be 280 characters or fewer');
  }
  await getOrgMember(directory, orgId, createdByMemberId);
  const now = Date.now();
  const id = `team-${randomUUID()}`;
  const slug = await uniqueTeamSlug(directory, orgId, name);
  await directory.run(
    `INSERT INTO od_org_teams
       (id, workspace_id, slug, name, description, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, slug, name, description, createdByMemberId, now, now],
  );
  await replaceTeamMembers(directory, orgId, id, input.memberIds);
  return getOrgTeam(directory, orgId, id);
}

export async function updateOrgTeam(
  directory: SqlExecutor,
  orgId: string,
  teamId: string,
  patch: UpdateOrgTeamRequest,
): Promise<OrgTeam> {
  const current = await getOrgTeam(directory, orgId, teamId);
  const name = patch.name === undefined ? current.name : patch.name.trim();
  if (!name) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'team name is required');
  }
  if (name.length > 80) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'team name must be 80 characters or fewer');
  }
  const description =
    patch.description === undefined
      ? current.description
      : patch.description.trim()
        ? patch.description.trim()
        : null;
  if (description && description.length > 280) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'team description must be 280 characters or fewer');
  }
  const slug = name === current.name ? current.slug : await uniqueTeamSlug(directory, orgId, name, teamId);
  await directory.run(
    `UPDATE od_org_teams SET name = ?, slug = ?, description = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [name, slug, description, Date.now(), teamId, orgId],
  );
  await replaceTeamMembers(directory, orgId, teamId, patch.memberIds);
  return getOrgTeam(directory, orgId, teamId);
}

export async function deleteOrgTeam(directory: SqlExecutor, orgId: string, teamId: string): Promise<OrgTeam> {
  const team = await getOrgTeam(directory, orgId, teamId);
  await directory.run('DELETE FROM od_org_teams WHERE id = ? AND workspace_id = ?', [teamId, orgId]);
  return team;
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

  const emailRaw = input.email?.trim() ?? '';
  const usernameRaw = input.username?.trim() ?? '';
  if (emailRaw && usernameRaw) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'invite by email or username, not both');
  }

  let kind: OrgInviteKind = 'link';
  let targetEmail: string | null = null;
  let targetUsername: string | null = null;
  let targetUserId: string | null = null;

  if (emailRaw) {
    kind = 'email';
    targetEmail = assertEmail(emailRaw);
    const matches = await findUsersByEmail(directory, targetEmail);
    if (matches.length === 1) {
      const member = await getActiveMemberForUser(directory, orgId, matches[0]!.id);
      if (member) {
        throw new WorkspaceDataError(
          'VALIDATION_FAILED',
          409,
          `${targetEmail} is already a member of this organization`,
        );
      }
      targetUserId = matches[0]!.id;
    }
  } else if (usernameRaw) {
    kind = 'username';
    targetUsername = assertUsername(usernameRaw);
    const matches = await findUsersByUsername(directory, targetUsername);
    if (matches.length > 1) {
      throw new WorkspaceDataError(
        'VALIDATION_FAILED',
        422,
        'that username matches more than one person; invite by email instead',
      );
    }
    if (matches.length === 1) {
      const member = await getActiveMemberForUser(directory, orgId, matches[0]!.id);
      if (member) {
        throw new WorkspaceDataError(
          'VALIDATION_FAILED',
          409,
          `${targetUsername} is already a member of this organization`,
        );
      }
      targetUserId = matches[0]!.id;
    }
  }

  const targeted = kind !== 'link';
  if (targeted) {
    const existing = (await listOrgInvites(directory, orgId)).find((invite) => {
      if (!inviteIsOpen(invite) || invite.kind !== kind) return false;
      if (kind === 'email') return invite.targetEmail === targetEmail;
      return (
        invite.targetUsername?.toLowerCase() === targetUsername?.toLowerCase() ||
        (targetUserId !== null && invite.targetUserId === targetUserId)
      );
    });
    if (existing) {
      throw new WorkspaceDataError(
        'ORG_INVITE_DUPLICATE',
        409,
        'an open invite to this person already exists',
      );
    }
  }

  const now = Date.now();
  const id = `inv-${randomUUID()}`;
  // 32 random bytes: the link is the entire credential, so it must be far
  // beyond guessing even when a stale link circulates in a chat thread.
  const token = randomBytes(32).toString('base64url');
  const expiresAt =
    input.expiresInHours === undefined
      ? targeted
        ? now + TARGETED_INVITE_TTL_MS
        : null
      : now + input.expiresInHours * 3600_000;
  const maxUses = input.maxUses ?? (targeted ? 1 : null);
  await directory.run(
    `INSERT INTO od_workspace_invites
       (id, workspace_id, token_hash, role, kind, target_email, target_username, target_user_id,
        created_by, expires_at, max_uses, use_count, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    [
      id,
      orgId,
      hashInviteToken(token),
      role,
      kind,
      targetEmail,
      targetUsername,
      targetUserId,
      createdByMemberId,
      expiresAt,
      maxUses,
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

function throwInviteRejection(reason: InviteRejection): never {
  if (reason === 'expired') {
    throw new WorkspaceDataError('ORG_INVITE_EXPIRED', 410, 'this invite link has expired');
  }
  if (reason === 'exhausted') {
    throw new WorkspaceDataError('ORG_INVITE_EXHAUSTED', 410, 'this invite link has reached its limit');
  }
  throw new WorkspaceDataError('ORG_INVITE_INVALID', 404, 'this invite link is not valid');
}

function inviteMatchesViewer(invite: OrgInvite, user: DirectoryUser): boolean {
  if (invite.kind === 'link') return true;
  if (invite.kind === 'email') {
    return Boolean(user.email && invite.targetEmail && normalizeEmail(user.email) === invite.targetEmail);
  }
  if (invite.targetUserId && invite.targetUserId === user.id) return true;
  const needle = (invite.targetUsername ?? '').trim().toLowerCase();
  if (!needle) return false;
  return user.username?.toLowerCase() === needle || user.displayName.toLowerCase() === needle;
}

async function assertInviteRecipient(directory: SqlExecutor, invite: OrgInvite, userId: string): Promise<void> {
  if (invite.kind === 'link') return;
  const user = await getUser(directory, userId);
  if (!user || !inviteMatchesViewer(invite, user)) {
    throw new WorkspaceDataError(
      'ORG_INVITE_WRONG_RECIPIENT',
      403,
      'this invite was sent to someone else',
    );
  }
}

async function redeemInvite(
  directory: SqlExecutor,
  invite: OrgInvite,
  org: Organization,
  userId: string,
): Promise<AcceptedInvite> {
  const existing = await getActiveMemberForUser(directory, org.id, userId);
  if (existing) return { organization: org, member: existing };

  await assertInviteRecipient(directory, invite, userId);

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

/** Redeem an invite for a user. Already-members are returned as-is rather than
 * erroring, so re-opening a link is harmless and does not burn a use. */
export async function acceptOrgInvite(
  directory: SqlExecutor,
  token: string,
  userId: string,
): Promise<AcceptedInvite> {
  const lookup = await lookupInviteByToken(directory, token);
  if (!lookup.ok) throwInviteRejection(lookup.reason);
  return redeemInvite(directory, lookup.value.invite, lookup.value.org, userId);
}

/** Targeted invites the signed-in person can join without the raw token. */
export async function listPendingInvitesForUser(
  directory: SqlExecutor,
  userId: string,
): Promise<OrgPendingInvite[]> {
  const user = await getUser(directory, userId);
  if (!user) return [];
  const rows = await directory.all<Record<string, any>>(
    `SELECT
       i.id, i.workspace_id AS "orgId", i.role, i.kind,
       i.target_email AS "targetEmail", i.target_username AS "targetUsername",
       i.target_user_id AS "targetUserId", i.created_by AS "createdBy",
       i.expires_at AS "expiresAt", i.max_uses AS "maxUses", i.use_count AS "useCount",
       i.revoked_at AS "revokedAt", i.created_at AS "createdAt",
       w.name AS "orgName"
     FROM od_workspace_invites i
     JOIN od_workspaces w ON w.id = i.workspace_id
     WHERE i.kind IN ('email', 'username')
       AND i.revoked_at IS NULL
     ORDER BY i.created_at DESC`,
  );
  const pending: OrgPendingInvite[] = [];
  for (const row of rows) {
    const invite = normalizeInvite(row);
    if (!inviteIsOpen(invite)) continue;
    if (!inviteMatchesViewer(invite, user)) continue;
    if (await getActiveMemberForUser(directory, invite.orgId, userId)) continue;
    pending.push({
      id: invite.id,
      orgId: invite.orgId,
      orgName: String(row.orgName ?? ''),
      role: invite.role,
      kind: invite.kind === 'link' ? 'email' : invite.kind,
      createdAt: invite.createdAt,
    });
  }
  return pending;
}

/** Redeem a targeted invite by id. Link invites cannot use this path — the
 * token is the credential, and invite ids are visible to admins. */
export async function acceptPendingInvite(
  directory: SqlExecutor,
  inviteId: string,
  userId: string,
): Promise<AcceptedInvite> {
  const invite = await getOrgInvite(directory, inviteId);
  if (invite.kind === 'link' || !inviteIsOpen(invite)) {
    throw new WorkspaceDataError('ORG_INVITE_INVALID', 404, 'this invite is not valid');
  }
  const org = await getOrganization(directory, invite.orgId);
  return redeemInvite(directory, invite, org, userId);
}

/** Boot-time invariant: the daemon always has at least one organization owned
 * by the local owner, so keyless single-user mode works with zero setup. */
export async function ensureDefaultOrganization(directory: SqlExecutor): Promise<Organization> {
  const ownerUserId = await ensureLocalOwnerUser(directory);
  const first = (await listOrganizations(directory))[0];
  if (first) return first;
  return createOrganization(directory, { name: 'My Organization', ownerUserId });
}

/** Default name for the organization a new account lands in. */
export function personalOrganizationName(displayName: string): string {
  const name = displayName.trim();
  if (
    !name ||
    name.includes('@') ||
    name.length > 48 ||
    isOpaqueUserId(name) ||
    name.toLowerCase() === 'member'
  ) {
    return 'My Organization';
  }
  return `${name}'s Organization`;
}

/** Rename a leftover personal org whose name was derived from a Clerk user id.
 * Does not create an organization — after sign-up the person chooses join or
 * create, so a brand-new account is allowed to have none. */
export async function ensurePersonalOrganization(
  directory: SqlExecutor,
  input: { userId: string; displayName: string },
): Promise<Organization | null> {
  const existing = await listOrganizationsForUser(directory, input.userId);
  if (!existing[0]) return null;
  if (existing[0].name.startsWith('user_')) {
    const next = personalOrganizationName(input.displayName);
    if (next !== existing[0].name) {
      return renameOrganization(directory, existing[0].id, next);
    }
  }
  return getOrganization(directory, existing[0].id);
}
