// Apps: publishing a generated tool so coworkers can open it.
//
// Publishing does not copy or freeze anything — an app points at a project
// file, so the publisher keeps iterating in their project and everyone else
// keeps opening the same stable entry. Archiving hides an app from the
// gallery; nothing is destroyed, matching the rest of the data plane.
//
// Every query carries the organization id explicitly. On SQLite that is
// redundant (the file is the organization) but harmless; on Supabase Postgres
// one database holds every organization and this is the only thing keeping
// them apart. One query shape, both engines.

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AppShareLink,
  AppVisibility,
  CreateAppShareLinkRequest,
  OrgApp,
  PublishAppRequest,
  UpdateAppRequest,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { hashInviteToken, tokenHashesMatch } from './tenancy.js';
import type { SqlExecutor } from '../storage/sql.js';

const APP_COLS = `
  id, name, description, project_id AS "projectId", file_path AS "filePath",
  visibility, status, created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt", archived_at AS "archivedAt",
  last_opened_at AS "lastOpenedAt", open_count AS "openCount"
`;

const SHARE_COLS = `
  id, app_id AS "appId", created_by AS "createdBy", expires_at AS "expiresAt",
  revoked_at AS "revokedAt", view_count AS "viewCount", created_at AS "createdAt"
`;

const VISIBILITIES = new Set<AppVisibility>(['private', 'org', 'link']);

/** Postgres returns BIGINT as a string; epoch milliseconds are numbers in the
 * contracts, so normalize at the boundary. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function normalizeApp(row: Record<string, any>, orgId: string, createdByName: string | null): OrgApp {
  return {
    ...(row as OrgApp),
    orgId,
    createdByName,
    description: row.description ?? null,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
    archivedAt: nullableNum(row.archivedAt),
    lastOpenedAt: nullableNum(row.lastOpenedAt),
    openCount: num(row.openCount),
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
  const now = Date.now();
  const id = `app-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_apps
       (id, workspace_id, name, description, project_id, file_path, visibility, status,
        created_by, created_at, updated_at, open_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0)`,
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
    ],
  );
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
  /** Member id of the viewer. Private apps are only listed for their creator. */
  viewerMemberId?: string | null;
  /** Resolves member ids to display names for the gallery byline. */
  resolveMemberName?: (memberId: string) => string | null;
}

export async function listApps(
  db: SqlExecutor,
  orgId: string,
  options: ListAppsOptions = {},
): Promise<OrgApp[]> {
  const where = options.includeArchived ? '' : " AND status = 'active'";
  const rows = await db.all<Record<string, any>>(
    `SELECT ${APP_COLS} FROM od_apps WHERE workspace_id = ?${where} ORDER BY updated_at DESC`,
    [orgId],
  );
  return rows
    .filter((row) => row.visibility !== 'private' || row.createdBy === options.viewerMemberId)
    .map((row) => normalizeApp(row, orgId, options.resolveMemberName?.(row.createdBy) ?? null));
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
  };
  if (!next.name) {
    throw workspaceValidationError([{ path: 'name', message: 'name cannot be empty' }]);
  }
  if (!VISIBILITIES.has(next.visibility)) {
    throw workspaceValidationError([
      { path: 'visibility', message: 'visibility must be private, org, or link' },
    ]);
  }
  const now = Date.now();
  await db.run(
    `UPDATE od_apps
        SET name = ?, description = ?, file_path = ?, visibility = ?, status = ?,
            archived_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    [
      next.name,
      next.description,
      next.filePath,
      next.visibility,
      next.status,
      next.status === 'archived' ? (existing.archivedAt ?? now) : null,
      now,
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
