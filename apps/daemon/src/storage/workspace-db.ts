// Storage backend for the Workspace Database (the permanent structured data
// plane). Two SQLite layouts, both derived from the resolved daemon data root:
//
// - one global "directory" DB holding tenant registry state (users,
//   workspaces, members, invites), and
// - one data DB per workspace holding that workspace's tables, records,
//   revisions, and audit trail. Per-workspace files give clean tenant
//   isolation and single-file backup/export.
//
// Unlike app.sqlite (idempotent bootstrap in db.ts), these are fresh files
// with no legacy, so they use real versioned migrations via PRAGMA
// user_version from day one.
//
// This module also introduces the repo's only SQLite triggers: BEFORE
// UPDATE/DELETE guards that make audit events and record revisions
// append-only BELOW the app layer. "Nothing truly deletes" is the product
// promise of this feature; a service-layer-only guarantee would be one
// refactor away from being a lie. Keep triggers confined to workspace DBs —
// never add them to app.sqlite.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

import { SqliteExecutor, type SqlExecutor } from './sql.js';

type SqliteDb = Database.Database;

const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSafeWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_PATTERN.test(id);
}

function openSqlite(file: string): SqliteDb {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function runVersionedMigrations(
  db: SqliteDb,
  migrations: ReadonlyArray<(db: SqliteDb) => void>,
): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  for (let version = current; version < migrations.length; version += 1) {
    const migration = migrations[version];
    if (!migration) break;
    const apply = db.transaction(() => {
      migration(db);
      db.pragma(`user_version = ${version + 1}`);
    });
    apply();
  }
}

const DIRECTORY_MIGRATIONS: ReadonlyArray<(db: SqliteDb) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE od_users (
        id TEXT PRIMARY KEY,
        clerk_user_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE od_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE od_workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES od_workspaces(id),
        user_id TEXT NOT NULL REFERENCES od_users(id),
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_members_ws_user
        ON od_workspace_members(workspace_id, user_id);

      CREATE TABLE od_workspace_invites (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES od_workspaces(id),
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'member',
        created_by TEXT NOT NULL,
        expires_at INTEGER,
        max_uses INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
  },
  // v2 — routing table for public share links. A share URL carries only a
  // token, so the daemon needs one global index to find which organization's
  // database holds the authoritative share record; without it, resolving a
  // link would mean opening every tenant DB in turn. The org DB remains the
  // source of truth for expiry, revocation, and view counts.
  (db) => {
    db.exec(`
      CREATE TABLE od_share_routes (
        token_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  },
];

const WORKSPACE_MIGRATIONS: ReadonlyArray<(db: SqliteDb) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE od_tables (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        schema_version INTEGER NOT NULL DEFAULT 1,
        protection TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE UNIQUE INDEX odx_tables_active_name
        ON od_tables(name) WHERE status = 'active';

      CREATE TABLE od_fields (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES od_tables(id),
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        type TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 0,
        unique_constraint INTEGER NOT NULL DEFAULT 0,
        config_json TEXT,
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_fields_table_active_name
        ON od_fields(table_id, name) WHERE status = 'active';

      CREATE TABLE od_records (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES od_tables(id),
        data_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_by_kind TEXT NOT NULL,
        created_by_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX odx_records_table ON od_records(table_id, deleted_at);

      CREATE TABLE od_record_revisions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        op TEXT NOT NULL,
        data_json TEXT NOT NULL,
        audit_event_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_revisions ON od_record_revisions(record_id, revision);

      CREATE TABLE od_audit_events (
        id TEXT PRIMARY KEY,
        actor_kind TEXT NOT NULL,
        actor_member_id TEXT,
        tool_id TEXT,
        run_id TEXT,
        project_id TEXT,
        op TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        table_id TEXT,
        summary TEXT,
        patch_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX odx_audit_subject
        ON od_audit_events(subject_kind, subject_id, created_at);
      CREATE INDEX odx_audit_created ON od_audit_events(created_at, id);

      CREATE TRIGGER odt_audit_no_update BEFORE UPDATE ON od_audit_events
        BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
      CREATE TRIGGER odt_audit_no_delete BEFORE DELETE ON od_audit_events
        BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
      CREATE TRIGGER odt_revisions_no_update BEFORE UPDATE ON od_record_revisions
        BEGIN SELECT RAISE(ABORT, 'record revisions are append-only'); END;
      CREATE TRIGGER odt_revisions_no_delete BEFORE DELETE ON od_record_revisions
        BEGIN SELECT RAISE(ABORT, 'record revisions are append-only'); END;
    `);
  },
  // v2 — apps: a generated tool published for the rest of the organization,
  // plus the unguessable links that share one outside the member list.
  (db) => {
    db.exec(`
      CREATE TABLE od_apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'org',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        last_opened_at INTEGER,
        open_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX odx_apps_status ON od_apps(status, updated_at DESC);
      CREATE INDEX odx_apps_project ON od_apps(project_id);

      CREATE TABLE od_app_shares (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES od_apps(id),
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        view_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX odx_app_shares_app ON od_app_shares(app_id, created_at DESC);
    `);
  },
  // v3 — carry the owning organization on app rows.
  //
  // On SQLite the file already implies the organization, so this column is
  // redundant here. It exists so the same SQL runs against Postgres, where a
  // single shared database holds every organization and `workspace_id` is the
  // only thing separating them. One query shape beats two dialects of the
  // same query.
  (db) => {
    db.exec(`
      ALTER TABLE od_apps ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE od_app_shares ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX odx_apps_workspace ON od_apps(workspace_id, status, updated_at DESC);
    `);
  },
];

export class WorkspaceDbManager {
  private readonly root: string;
  private directoryDb: SqliteDb | null = null;
  private readonly workspaceDbs = new Map<string, SqliteDb>();
  private directoryExec: SqlExecutor | null = null;
  private readonly workspaceExecs = new Map<string, SqlExecutor>();
  /** Set when the operator configured Postgres/Supabase. One shared executor
   * serves every organization, because a hosted database is one database —
   * organizations are separated by `workspace_id`, not by file. */
  private readonly shared: SqlExecutor | null;

  constructor(dataDir: string, sharedExecutor: SqlExecutor | null = null) {
    this.root = path.join(path.resolve(dataDir), 'workspace-data');
    this.shared = sharedExecutor;
  }

  /** True when the system of record is a hosted database rather than local
   * files — the condition under which an organization can span machines. */
  get isShared(): boolean {
    return this.shared !== null;
  }

  get directory(): SqliteDb {
    if (!this.directoryDb) {
      const db = openSqlite(path.join(this.root, 'directory.sqlite'));
      runVersionedMigrations(db, DIRECTORY_MIGRATIONS);
      this.directoryDb = db;
    }
    return this.directoryDb;
  }

  /** Executor for organization-registry data: users, organizations, members,
   * invites, share routing. */
  get directoryExecutor(): SqlExecutor {
    if (this.shared) return this.shared;
    if (!this.directoryExec) this.directoryExec = new SqliteExecutor(this.directory);
    return this.directoryExec;
  }

  /** Executor for one organization's own data. On SQLite that is its file; on
   * Postgres it is the shared database, and callers scope by organization id
   * in the query itself. */
  workspaceExecutor(workspaceId: string): SqlExecutor {
    if (this.shared) return this.shared;
    const existing = this.workspaceExecs.get(workspaceId);
    if (existing) return existing;
    const executor = new SqliteExecutor(this.openWorkspace(workspaceId));
    this.workspaceExecs.set(workspaceId, executor);
    return executor;
  }

  workspaceDataDir(workspaceId: string): string {
    if (!isSafeWorkspaceId(workspaceId)) {
      throw new Error(`invalid workspace id: ${workspaceId}`);
    }
    return path.join(this.root, 'workspaces', workspaceId);
  }

  openWorkspace(workspaceId: string): SqliteDb {
    const existing = this.workspaceDbs.get(workspaceId);
    if (existing) return existing;
    const db = openSqlite(path.join(this.workspaceDataDir(workspaceId), 'data.sqlite'));
    runVersionedMigrations(db, WORKSPACE_MIGRATIONS);
    this.workspaceDbs.set(workspaceId, db);
    return db;
  }

  closeAll(): void {
    this.workspaceExecs.clear();
    this.directoryExec = null;
    for (const db of this.workspaceDbs.values()) db.close();
    this.workspaceDbs.clear();
    if (this.directoryDb) {
      this.directoryDb.close();
      this.directoryDb = null;
    }
  }
}
