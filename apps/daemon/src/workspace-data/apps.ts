// Apps: publishing a generated tool so coworkers can open it.
//
// Publishing does not copy or freeze anything — an app points at a project
// file, so the publisher keeps iterating in their project and everyone else
// keeps opening the same stable entry. Archiving hides an app from the
// gallery; nothing is destroyed, matching the rest of the data plane.
//
// Access:
//   visibility private — only the creator (list/get/open)
//   accessMode org     — every member can view unless they are on the denial list
//   accessMode restricted — only grants ∪ team grants ∪ creator ∪ admin can view
//   denials            — named people cannot open it (creator/admins still can)
//
// Every query carries the organization id explicitly. On SQLite that is
// redundant (the file is the organization) but harmless; on Supabase Postgres
// one database holds every organization and this is the only thing keeping
// them apart. One query shape, both engines.

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AppAccessMode,
  AppAccessPolicy,
  AppGrant,
  AppGrantRole,
  AppShareLink,
  AppVisibility,
  CreateAppShareLinkRequest,
  OrgApp,
  OrgRole,
  PublishAppRequest,
  SetAppGrantsRequest,
  UpdateAppRequest,
} from '@open-design/contracts';
import { normalizeAppScopes } from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { hashInviteToken, tokenHashesMatch } from './tenancy.js';
import type { SqlExecutor } from '../storage/sql.js';

const APP_COLS = `
  id, name, description, project_id AS "projectId", file_path AS "filePath",
  visibility, status, created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt", archived_at AS "archivedAt",
  last_opened_at AS "lastOpenedAt", open_count AS "openCount",
  data_scopes_json AS "dataScopesJson",
  COALESCE(access_mode, 'org') AS "accessMode",
  COALESCE(pinned, 0) AS "pinned",
  pinned_at AS "pinnedAt",
  web_url AS "webUrl"
`;

const SHARE_COLS = `
  id, app_id AS "appId", created_by AS "createdBy", expires_at AS "expiresAt",
  revoked_at AS "revokedAt", view_count AS "viewCount", created_at AS "createdAt"
`;

const VISIBILITIES = new Set<AppVisibility>(['private', 'org', 'link']);
const ACCESS_MODES = new Set<AppAccessMode>(['org', 'restricted']);
const GRANT_ROLES = new Set<AppGrantRole>(['view', 'edit']);

function parseScopes(raw: unknown): unknown {
  if (typeof raw !== 'string') return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Postgres returns BIGINT as a string; epoch milliseconds are numbers in the
 * contracts, so normalize at the boundary. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function asAccessMode(value: unknown): AppAccessMode {
  return value === 'restricted' ? 'restricted' : 'org';
}

function asPinned(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function normalizeApp(row: Record<string, any>, orgId: string, createdByName: string | null): OrgApp {
  const { dataScopesJson, pinned, pinnedAt, accessMode, webUrl, ...rest } = row;
  return {
    ...(rest as OrgApp),
    orgId,
    createdByName,
    accessMode: asAccessMode(accessMode),
    pinned: asPinned(pinned),
    pinnedAt: nullableNum(pinnedAt),
    // An app published before scopes existed reads and writes nothing, which
    // is the safe reading of a missing declaration.
    dataScopes: normalizeAppScopes(parseScopes(dataScopesJson)),
    description: row.description ?? null,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
    archivedAt: nullableNum(row.archivedAt),
    lastOpenedAt: nullableNum(row.lastOpenedAt),
    openCount: num(row.openCount),
    webUrl: typeof webUrl === 'string' && webUrl ? webUrl : null,
  };
}

function normalizeShare(row: Record<string, any>): AppShareLink {
  return {
    ...(row as AppShareLink),
    expiresAt: nullableNum(row.expiresAt),
    revokedAt: nullableNum(row.revokedAt),
    viewCount: num(row.viewCount),
    createdAt: num(row.createdAt),
  };
}

function isAdminRole(role: OrgRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** A project file path, constrained the same way the project file API
 * constrains it: relative, no traversal, no absolute roots. */
function assertFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw workspaceValidationError([{ path: 'filePath', message: 'filePath is required' }]);
  }
  const value = filePath.trim().replace(/^\/+/, '');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw workspaceValidationError([
      { path: 'filePath', message: 'filePath must be a relative path inside the project' },
    ]);
  }
  return value;
}

function normalizeGrantInput(
  grants: Array<{ memberId: string; role: AppGrantRole }> | undefined,
): Array<{ memberId: string; role: AppGrantRole }> {
  if (!grants?.length) return [];
  const out: Array<{ memberId: string; role: AppGrantRole }> = [];
  const seen = new Set<string>();
  for (const grant of grants) {
    if (typeof grant.memberId !== 'string' || !grant.memberId.trim()) continue;
    if (!GRANT_ROLES.has(grant.role)) continue;
    const memberId = grant.memberId.trim();
    if (seen.has(memberId)) continue;
    seen.add(memberId);
    out.push({ memberId, role: grant.role });
  }
  return out;
}

async function replaceGrants(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  grants: Array<{ memberId: string; role: AppGrantRole }>,
): Promise<void> {
  await db.run('DELETE FROM od_app_grants WHERE app_id = ? AND workspace_id = ?', [appId, orgId]);
  const now = Date.now();
  for (const grant of grants) {
    await db.run(
      `INSERT INTO od_app_grants (app_id, workspace_id, member_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [appId, orgId, grant.memberId, grant.role, now],
    );
  }
}

function normalizeTeamGrantInput(
  grants: Array<{ teamId: string; role: AppGrantRole }> | undefined,
): Array<{ teamId: string; role: AppGrantRole }> {
  if (!grants?.length) return [];
  const out: Array<{ teamId: string; role: AppGrantRole }> = [];
  const seen = new Set<string>();
  for (const grant of grants) {
    if (typeof grant.teamId !== 'string' || !grant.teamId.trim()) continue;
    if (!GRANT_ROLES.has(grant.role)) continue;
    const teamId = grant.teamId.trim();
    if (seen.has(teamId)) continue;
    seen.add(teamId);
    out.push({ teamId, role: grant.role });
  }
  return out;
}

function normalizeDenialInput(
  denials: Array<{ memberId: string }> | undefined,
): string[] {
  if (!denials?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const denial of denials) {
    if (typeof denial.memberId !== 'string' || !denial.memberId.trim()) continue;
    const memberId = denial.memberId.trim();
    if (seen.has(memberId)) continue;
    seen.add(memberId);
    out.push(memberId);
  }
  return out;
}

async function replaceTeamGrants(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  grants: Array<{ teamId: string; role: AppGrantRole }>,
): Promise<void> {
  await db.run('DELETE FROM od_app_team_grants WHERE app_id = ? AND workspace_id = ?', [appId, orgId]);
  const now = Date.now();
  for (const grant of grants) {
    await db.run(
      `INSERT INTO od_app_team_grants (app_id, workspace_id, team_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [appId, orgId, grant.teamId, grant.role, now],
    );
  }
}

async function replaceDenials(db: SqlExecutor, orgId: string, appId: string, memberIds: string[]): Promise<void> {
  await db.run('DELETE FROM od_app_denials WHERE app_id = ? AND workspace_id = ?', [appId, orgId]);
  const now = Date.now();
  for (const memberId of memberIds) {
    await db.run(
      `INSERT INTO od_app_denials (app_id, workspace_id, member_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [appId, orgId, memberId, now],
    );
  }
}

export interface AppAccessResolvers {
  memberName?: (memberId: string) => string | null;
  teamName?: (teamId: string) => string | null;
}

export async function listAppAccess(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  resolve: AppAccessResolvers = {},
): Promise<AppAccessPolicy> {
  await getApp(db, orgId, appId);
  const [grantRows, teamRows, denialRows] = await Promise.all([
    db.all<{ memberId: string; role: AppGrantRole }>(
      `SELECT member_id AS "memberId", role FROM od_app_grants
        WHERE app_id = ? AND workspace_id = ? ORDER BY member_id`,
      [appId, orgId],
    ),
    db.all<{ teamId: string; role: AppGrantRole }>(
      `SELECT team_id AS "teamId", role FROM od_app_team_grants
        WHERE app_id = ? AND workspace_id = ? ORDER BY team_id`,
      [appId, orgId],
    ),
    db.all<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM od_app_denials
        WHERE app_id = ? AND workspace_id = ? ORDER BY member_id`,
      [appId, orgId],
    ),
  ]);
  return {
    grants: grantRows.map((row) => ({
      memberId: row.memberId,
      role: row.role === 'edit' ? 'edit' : 'view',
      memberName: resolve.memberName?.(row.memberId) ?? null,
    })),
    teamGrants: teamRows.map((row) => ({
      teamId: row.teamId,
      role: row.role === 'edit' ? 'edit' : 'view',
      teamName: resolve.teamName?.(row.teamId) ?? null,
    })),
    denials: denialRows.map((row) => ({
      memberId: row.memberId,
      memberName: resolve.memberName?.(row.memberId) ?? null,
    })),
  };
}

export async function listAppGrants(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  resolveMemberName?: (memberId: string) => string | null,
): Promise<AppGrant[]> {
  const access = await listAppAccess(
    db,
    orgId,
    appId,
    resolveMemberName ? { memberName: resolveMemberName } : {},
  );
  return access.grants;
}

export async function setAppGrants(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  input: SetAppGrantsRequest,
  resolve: AppAccessResolvers | ((memberId: string) => string | null) = {},
): Promise<AppAccessPolicy> {
  await getApp(db, orgId, appId);
  const resolvers: AppAccessResolvers =
    typeof resolve === 'function' ? { memberName: resolve } : resolve;
  const grants = normalizeGrantInput(input.grants);
  await replaceGrants(db, orgId, appId, grants);
  if (input.teamGrants !== undefined) {
    await replaceTeamGrants(db, orgId, appId, normalizeTeamGrantInput(input.teamGrants));
  }
  if (input.denials !== undefined) {
    await replaceDenials(db, orgId, appId, normalizeDenialInput(input.denials));
  }
  return listAppAccess(db, orgId, appId, resolvers);
}

async function grantRoleFor(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  memberId: string,
): Promise<AppGrantRole | null> {
  const row = await db.get<{ role: string }>(
    `SELECT role FROM od_app_grants WHERE app_id = ? AND workspace_id = ? AND member_id = ?`,
    [appId, orgId, memberId],
  );
  if (!row) return null;
  return row.role === 'edit' ? 'edit' : 'view';
}

async function teamGrantRoleFor(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  teamIds: readonly string[] | undefined,
): Promise<AppGrantRole | null> {
  if (!teamIds?.length) return null;
  const placeholders = teamIds.map(() => '?').join(', ');
  const rows = await db.all<{ role: string }>(
    `SELECT role FROM od_app_team_grants
      WHERE app_id = ? AND workspace_id = ? AND team_id IN (${placeholders})`,
    [appId, orgId, ...teamIds],
  );
  if (rows.some((row) => row.role === 'edit')) return 'edit';
  if (rows.length > 0) return 'view';
  return null;
}

async function isDeniedMember(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  memberId: string,
): Promise<boolean> {
  const row = await db.get<{ memberId: string }>(
    `SELECT member_id AS "memberId" FROM od_app_denials
      WHERE app_id = ? AND workspace_id = ? AND member_id = ?`,
    [appId, orgId, memberId],
  );
  return row !== null;
}

export interface AppViewerContext {
  memberId: string;
  role: OrgRole;
  /** Named teams this person belongs to, used to expand team grants. */
  teamIds?: readonly string[];
}

export interface AppAccessCheck {
  denied?: boolean;
  teamGrant?: AppGrantRole | null;
}

export function strongerGrant(
  left: AppGrantRole | null | undefined,
  right: AppGrantRole | null | undefined,
): AppGrantRole | null {
  if (left === 'edit' || right === 'edit') return 'edit';
  if (left === 'view' || right === 'view') return 'view';
  return null;
}

export function canViewApp(
  app: OrgApp,
  viewer: AppViewerContext,
  grant: AppGrantRole | null,
  extras: AppAccessCheck = {},
): boolean {
  if (app.createdBy === viewer.memberId || isAdminRole(viewer.role)) return true;
  if (extras.denied) return false;
  if (app.visibility === 'private') return false;
  if (app.accessMode === 'restricted') return strongerGrant(grant, extras.teamGrant) !== null;
  return true;
}

export function canEditApp(
  app: OrgApp,
  viewer: AppViewerContext,
  grant: AppGrantRole | null,
  extras: AppAccessCheck = {},
): boolean {
  if (app.createdBy === viewer.memberId || isAdminRole(viewer.role)) return true;
  if (extras.denied) return false;
  return strongerGrant(grant, extras.teamGrant) === 'edit';
}

export async function assertCanViewApp(
  db: SqlExecutor,
  orgId: string,
  app: OrgApp,
  viewer: AppViewerContext,
): Promise<void> {
  const [grant, teamGrant, denied] = await Promise.all([
    grantRoleFor(db, orgId, app.id, viewer.memberId),
    teamGrantRoleFor(db, orgId, app.id, viewer.teamIds),
    isDeniedMember(db, orgId, app.id, viewer.memberId),
  ]);
  if (!canViewApp(app, viewer, grant, { teamGrant, denied })) {
    throw new WorkspaceDataError('APP_FORBIDDEN', 403, 'you do not have access to this app');
  }
}

export async function assertCanEditApp(
  db: SqlExecutor,
  orgId: string,
  app: OrgApp,
  viewer: AppViewerContext,
): Promise<void> {
  const [grant, teamGrant, denied] = await Promise.all([
    grantRoleFor(db, orgId, app.id, viewer.memberId),
    teamGrantRoleFor(db, orgId, app.id, viewer.teamIds),
    isDeniedMember(db, orgId, app.id, viewer.memberId),
  ]);
  if (!canEditApp(app, viewer, grant, { teamGrant, denied })) {
    throw new WorkspaceDataError('APP_FORBIDDEN', 403, 'you cannot edit this app');
  }
}

export async function publishApp(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  memberName: string | null,
  input: PublishAppRequest,
): Promise<OrgApp> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw workspaceValidationError([{ path: 'name', message: 'name is required' }]);
  }
  if (typeof input.projectId !== 'string' || !input.projectId.trim()) {
    throw workspaceValidationError([{ path: 'projectId', message: 'projectId is required' }]);
  }
  const filePath = assertFilePath(input.filePath);
  const visibility = input.visibility ?? 'org';
  if (!VISIBILITIES.has(visibility)) {
    throw workspaceValidationError([
      { path: 'visibility', message: 'visibility must be private, org, or link' },
    ]);
  }
  const accessMode = input.accessMode ?? 'org';
  if (!ACCESS_MODES.has(accessMode)) {
    throw workspaceValidationError([
      { path: 'accessMode', message: 'accessMode must be org or restricted' },
    ]);
  }
  const grants = normalizeGrantInput(input.grants);
  if (accessMode === 'restricted' && grants.length === 0) {
    // Creator always retains access; empty grants means only creator + admins.
  }
  // Malformed entries are dropped rather than failing the publish; dropping
  // is the safe direction, since the result is less access, never more.
  const dataScopes = normalizeAppScopes(input.dataScopes);
  const now = Date.now();
  const pinned = Boolean(input.pinned);
  const id = `app-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_apps
       (id, workspace_id, name, description, project_id, file_path, visibility, status,
        created_by, created_at, updated_at, open_count, data_scopes_json,
        access_mode, pinned, pinned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      name,
      input.description?.trim() || null,
      input.projectId.trim(),
      filePath,
      visibility,
      memberId,
      now,
      now,
      JSON.stringify(dataScopes),
      accessMode,
      pinned ? 1 : 0,
      pinned ? now : null,
    ],
  );
  if (grants.length) await replaceGrants(db, orgId, id, grants);
  const teamGrants = normalizeTeamGrantInput(input.teamGrants);
  if (teamGrants.length) await replaceTeamGrants(db, orgId, id, teamGrants);
  const denials = normalizeDenialInput(input.denials);
  if (denials.length) await replaceDenials(db, orgId, id, denials);
  return getApp(db, orgId, id, memberName);
}

export async function getApp(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  createdByName: string | null = null,
): Promise<OrgApp> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${APP_COLS} FROM od_apps WHERE id = ? AND workspace_id = ?`,
    [appId, orgId],
  );
  if (!row) {
    throw new WorkspaceDataError('APP_NOT_FOUND', 404, `app ${appId} not found`);
  }
  return normalizeApp(row, orgId, createdByName);
}

export interface ListAppsOptions {
  includeArchived?: boolean;
  /** Member id of the viewer. Private / restricted apps are filtered here. */
  viewerMemberId?: string | null;
  viewerRole?: OrgRole | null;
  /** Named teams the viewer belongs to, used to expand team grants. */
  viewerTeamIds?: readonly string[];
  /** Only apps pinned to the sidebar. */
  pinnedOnly?: boolean;
  /** Resolves member ids to display names for the gallery byline. */
  resolveMemberName?: (memberId: string) => string | null;
}

export async function listApps(
  db: SqlExecutor,
  orgId: string,
  options: ListAppsOptions = {},
): Promise<OrgApp[]> {
  const where = [
    options.includeArchived ? '' : " AND status = 'active'",
    options.pinnedOnly ? ' AND pinned = 1' : '',
  ].join('');
  const rows = await db.all<Record<string, any>>(
    `SELECT ${APP_COLS} FROM od_apps WHERE workspace_id = ?${where} ORDER BY updated_at DESC`,
    [orgId],
  );
  const viewerId = options.viewerMemberId ?? null;
  const viewerRole = options.viewerRole ?? null;
  const viewerTeamIds = options.viewerTeamIds ?? [];
  const grantRows =
    viewerId == null
      ? []
      : await db.all<{ appId: string; role: string }>(
          `SELECT app_id AS "appId", role FROM od_app_grants
            WHERE workspace_id = ? AND member_id = ?`,
          [orgId, viewerId],
        );
  const grants = new Map<string, AppGrantRole>(
    grantRows.map((row) => [row.appId, row.role === 'edit' ? 'edit' : 'view']),
  );
  const deniedRows =
    viewerId == null
      ? []
      : await db.all<{ appId: string }>(
          `SELECT app_id AS "appId" FROM od_app_denials
            WHERE workspace_id = ? AND member_id = ?`,
          [orgId, viewerId],
        );
  const denied = new Set(deniedRows.map((row) => row.appId));
  const teamGrantRows =
    viewerId == null || viewerTeamIds.length === 0
      ? []
      : await db.all<{ appId: string; role: string }>(
          `SELECT app_id AS "appId", role FROM od_app_team_grants
            WHERE workspace_id = ? AND team_id IN (${viewerTeamIds.map(() => '?').join(', ')})`,
          [orgId, ...viewerTeamIds],
        );
  const teamGrants = new Map<string, AppGrantRole>();
  for (const row of teamGrantRows) {
    const next = strongerGrant(teamGrants.get(row.appId) ?? null, row.role === 'edit' ? 'edit' : 'view');
    if (next) teamGrants.set(row.appId, next);
  }

  const out: OrgApp[] = [];
  for (const row of rows) {
    const app = normalizeApp(row, orgId, options.resolveMemberName?.(row.createdBy) ?? null);
    if (viewerId) {
      const viewer: AppViewerContext = {
        memberId: viewerId,
        role: viewerRole ?? 'member',
        teamIds: viewerTeamIds,
      };
      if (
        !canViewApp(app, viewer, grants.get(app.id) ?? null, {
          denied: denied.has(app.id),
          teamGrant: teamGrants.get(app.id) ?? null,
        })
      ) {
        continue;
      }
    }
    out.push(app);
  }
  if (options.pinnedOnly) {
    out.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  }
  return out.slice(0, options.pinnedOnly ? 8 : out.length);
}

export async function deleteAppTeamGrants(db: SqlExecutor, orgId: string, teamId: string): Promise<void> {
  await db.run('DELETE FROM od_app_team_grants WHERE workspace_id = ? AND team_id = ?', [orgId, teamId]);
}

export async function updateApp(
  db: SqlExecutor,
  orgId: string,
  appId: string,
  patch: UpdateAppRequest,
): Promise<OrgApp> {
  const existing = await getApp(db, orgId, appId);
  const next = {
    name: patch.name === undefined ? existing.name : patch.name.trim(),
    description:
      patch.description === undefined ? existing.description : patch.description.trim() || null,
    filePath: patch.filePath === undefined ? existing.filePath : assertFilePath(patch.filePath),
    visibility: patch.visibility ?? existing.visibility,
    status: patch.status ?? existing.status,
    accessMode: patch.accessMode ?? existing.accessMode,
    pinned: patch.pinned === undefined ? existing.pinned : Boolean(patch.pinned),
  };
  if (!next.name) {
    throw workspaceValidationError([{ path: 'name', message: 'name cannot be empty' }]);
  }
  if (!VISIBILITIES.has(next.visibility)) {
    throw workspaceValidationError([
      { path: 'visibility', message: 'visibility must be private, org, or link' },
    ]);
  }
  if (!ACCESS_MODES.has(next.accessMode)) {
    throw workspaceValidationError([
      { path: 'accessMode', message: 'accessMode must be org or restricted' },
    ]);
  }
  const now = Date.now();
  let pinnedAt = existing.pinnedAt;
  if (patch.pinned !== undefined) {
    pinnedAt = next.pinned ? (existing.pinned ? existing.pinnedAt : now) : null;
  }
  await db.run(
    `UPDATE od_apps
        SET name = ?, description = ?, file_path = ?, visibility = ?, status = ?,
            archived_at = ?, updated_at = ?, access_mode = ?, pinned = ?, pinned_at = ?
      WHERE id = ? AND workspace_id = ?`,
    [
      next.name,
      next.description,
      next.filePath,
      next.visibility,
      next.status,
      next.status === 'archived' ? (existing.archivedAt ?? now) : null,
      now,
      next.accessMode,
      next.pinned ? 1 : 0,
      pinnedAt,
      appId,
      orgId,
    ],
  );
  return getApp(db, orgId, appId);
}

/** Bump usage counters when someone actually opens the app. Deliberately not
 * part of GET so merely listing the gallery does not inflate the numbers. */
export async function recordAppOpen(db: SqlExecutor, appId: string): Promise<void> {
  await db.run('UPDATE od_apps SET last_opened_at = ?, open_count = open_count + 1 WHERE id = ?', [
    Date.now(),
    appId,
  ]);
}

// --- Share links ----------------------------------------------------------

export interface CreatedAppShare {
  share: AppShareLink;
  token: string;
}

export async function createAppShareLink(
  db: SqlExecutor,
  directory: SqlExecutor,
  orgId: string,
  appId: string,
  memberId: string,
  input: CreateAppShareLinkRequest = {},
): Promise<CreatedAppShare> {
  const app = await getApp(db, orgId, appId);
  if (input.expiresInHours !== undefined) {
    if (!Number.isFinite(input.expiresInHours) || input.expiresInHours <= 0) {
      throw workspaceValidationError([
        { path: 'expiresInHours', message: 'expiresInHours must be a positive number' },
      ]);
    }
  }
  const now = Date.now();
  const id = `shr-${randomUUID()}`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashInviteToken(token);
  await db.run(
    `INSERT INTO od_app_shares
       (id, workspace_id, app_id, token_hash, created_by, expires_at, revoked_at, view_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
    [
      id,
      orgId,
      appId,
      tokenHash,
      memberId,
      input.expiresInHours === undefined ? null : now + input.expiresInHours * 3600_000,
      now,
    ],
  );
  // Global route so the public viewer can find the owning organization from
  // the token alone.
  await directory.run(
    'INSERT INTO od_share_routes (token_hash, workspace_id, app_id, created_at) VALUES (?, ?, ?, ?)',
    [tokenHash, orgId, appId, now],
  );
  // A link share only means something if the app is actually link-visible.
  if (app.visibility !== 'link') {
    await db.run("UPDATE od_apps SET visibility = 'link', updated_at = ? WHERE id = ?", [now, appId]);
  }
  return { share: await getAppShareLink(db, id), token };
}

/** Keep the `/s/:token` path, move the origin to whatever is publicly reachable now. */
function relocateShareUrl(storedUrl: string, publicBaseUrl: string): string {
  try {
    const parsed = new URL(storedUrl);
    if (!parsed.pathname.startsWith('/s/')) return storedUrl;
    const origin = publicBaseUrl.replace(/\/+$/u, '');
    return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return storedUrl;
  }
}

/** Create a lasting public URL for an app-builder app, or return the one it already has. */
export async function publishAppToWeb(
  db: SqlExecutor,
  directory: SqlExecutor,
  orgId: string,
  appId: string,
  memberId: string,
  publicBaseUrl: string,
): Promise<{ app: OrgApp; url: string }> {
  const existing = await getApp(db, orgId, appId);
  if (existing.webUrl) {
    const url = relocateShareUrl(existing.webUrl, publicBaseUrl);
    if (url === existing.webUrl) {
      return { app: existing, url: existing.webUrl };
    }
    const now = Date.now();
    await db.run(
      `UPDATE od_apps SET web_url = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      [url, now, appId, orgId],
    );
    return { app: await getApp(db, orgId, appId), url };
  }
  const created = await createAppShareLink(db, directory, orgId, appId, memberId, {});
  const url = `${publicBaseUrl.replace(/\/+$/u, '')}/s/${created.token}`;
  const now = Date.now();
  await db.run(
    `UPDATE od_apps SET web_url = ?, visibility = 'link', updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [url, now, appId, orgId],
  );
  return { app: await getApp(db, orgId, appId), url };
}

export async function getAppShareLink(db: SqlExecutor, shareId: string): Promise<AppShareLink> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${SHARE_COLS} FROM od_app_shares WHERE id = ?`,
    [shareId],
  );
  if (!row) {
    throw new WorkspaceDataError('APP_SHARE_INVALID', 404, 'share link not found');
  }
  return normalizeShare(row);
}

export async function listAppShareLinks(
  db: SqlExecutor,
  orgId: string,
  appId: string,
): Promise<AppShareLink[]> {
  await getApp(db, orgId, appId);
  const rows = await db.all<Record<string, any>>(
    `SELECT ${SHARE_COLS} FROM od_app_shares WHERE app_id = ? AND workspace_id = ? ORDER BY created_at DESC`,
    [appId, orgId],
  );
  return rows.map(normalizeShare);
}

export async function revokeAppShareLink(
  db: SqlExecutor,
  directory: SqlExecutor,
  orgId: string,
  appId: string,
  shareId: string,
): Promise<AppShareLink> {
  const share = await getAppShareLink(db, shareId);
  if (share.appId !== appId) {
    throw new WorkspaceDataError('APP_SHARE_INVALID', 404, 'share link not found');
  }
  await getApp(db, orgId, appId);
  const row = await db.get<{ tokenHash: string }>(
    'SELECT token_hash AS "tokenHash" FROM od_app_shares WHERE id = ?',
    [shareId],
  );
  await db.run('UPDATE od_app_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    Date.now(),
    shareId,
  ]);
  // Drop the routing row so a revoked token stops resolving immediately
  // rather than resolving and then being refused.
  if (row) {
    await directory.run('DELETE FROM od_share_routes WHERE token_hash = ?', [row.tokenHash]);
  }
  return getAppShareLink(db, shareId);
}

export interface ShareRoute {
  orgId: string;
  appId: string;
  tokenHash: string;
}

export async function resolveShareRoute(
  directory: SqlExecutor,
  token: string,
): Promise<ShareRoute | null> {
  const tokenHash = hashInviteToken(token);
  const row = await directory.get<ShareRoute>(
    'SELECT token_hash AS "tokenHash", workspace_id AS "orgId", app_id AS "appId" FROM od_share_routes WHERE token_hash = ?',
    [tokenHash],
  );
  if (!row || !tokenHashesMatch(String(row.tokenHash), tokenHash)) return null;
  return row;
}

export interface ResolvedShare {
  app: OrgApp;
  share: AppShareLink;
}

/** Validate a share token against the organization's data and return what it
 * points at. Throws APP_SHARE_INVALID for every failure mode so a probe cannot
 * tell an expired link from a revoked or unknown one. */
export async function resolveShareToken(
  db: SqlExecutor,
  orgId: string,
  token: string,
): Promise<ResolvedShare> {
  const tokenHash = hashInviteToken(token);
  const row = await db.get<Record<string, any>>(
    `SELECT ${SHARE_COLS}, token_hash AS "tokenHash" FROM od_app_shares WHERE token_hash = ?`,
    [tokenHash],
  );
  const invalid = () => new WorkspaceDataError('APP_SHARE_INVALID', 404, 'this share link is not valid');
  if (!row || !tokenHashesMatch(String(row.tokenHash), tokenHash)) throw invalid();
  const share = normalizeShare(row);
  if (share.revokedAt !== null) throw invalid();
  if (share.expiresAt !== null && share.expiresAt <= Date.now()) throw invalid();
  const app = await getApp(db, orgId, share.appId);
  if (app.status !== 'active' || app.visibility !== 'link') throw invalid();
  return { app, share };
}

export async function recordShareView(db: SqlExecutor, shareId: string): Promise<void> {
  await db.run('UPDATE od_app_shares SET view_count = view_count + 1 WHERE id = ?', [shareId]);
}
