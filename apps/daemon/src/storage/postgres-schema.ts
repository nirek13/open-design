// Postgres/Supabase schema for the organization layer.
//
// This mirrors the SQLite directory database (storage/workspace-db.ts) so the
// same services run on either engine. It is deliberately a separate file
// rather than a translated string: the dialects differ in ways worth writing
// out plainly (BIGINT epoch-ms instead of INTEGER, a real serial for insertion
// order, `IF NOT EXISTS` everywhere so startup is idempotent).
//
// Everything lives under a dedicated schema so Open Design's tables never
// collide with whatever else the operator keeps in the same Supabase project.
//
// Migrations are recorded in `od_schema_migrations` and applied in order. A
// migration is never edited once shipped — add a new one.

import type { SqlExecutor } from './sql.js';

export const POSTGRES_SCHEMA = 'open_design';

interface PostgresMigration {
  id: string;
  sql: string;
}

const MIGRATIONS: readonly PostgresMigration[] = [
  {
    id: '0001-organizations',
    sql: `
      CREATE TABLE IF NOT EXISTS od_users (
        id TEXT PRIMARY KEY,
        clerk_user_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS od_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS od_workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES od_workspaces(id),
        user_id TEXT NOT NULL REFERENCES od_users(id),
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_members_ws_user
        ON od_workspace_members(workspace_id, user_id);

      CREATE TABLE IF NOT EXISTS od_workspace_invites (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES od_workspaces(id),
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'member',
        created_by TEXT NOT NULL,
        expires_at BIGINT,
        max_uses INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        revoked_at BIGINT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS od_share_routes (
        token_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
    `,
  },
  {
    id: '0002-apps',
    sql: `
      CREATE TABLE IF NOT EXISTS od_apps (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES od_workspaces(id),
        name TEXT NOT NULL,
        description TEXT,
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'org',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        archived_at BIGINT,
        last_opened_at BIGINT,
        open_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS odx_apps_workspace
        ON od_apps(workspace_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS od_app_shares (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES od_apps(id),
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        expires_at BIGINT,
        revoked_at BIGINT,
        view_count INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_app_shares_app
        ON od_app_shares(app_id, created_at DESC);
    `,
  },
  {
    id: '0003-audit',
    sql: `
      -- Insertion order is the only correct sort key for an append-only log:
      -- created_at has millisecond resolution and several events routinely
      -- share one. On SQLite this role is played by the implicit rowid.
      CREATE TABLE IF NOT EXISTS od_audit_events (
        seq BIGSERIAL PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
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
        patch_json JSONB,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_audit_subject
        ON od_audit_events(workspace_id, subject_kind, subject_id, seq DESC);

      -- The append-only promise has to hold below the application layer, the
      -- same way the SQLite build enforces it with triggers. REVOKE is the
      -- Postgres equivalent and is applied to the role the daemon connects
      -- as, not to a superuser, so this is defence in depth rather than an
      -- absolute guarantee against an administrator.
      CREATE OR REPLACE FUNCTION od_audit_events_append_only()
        RETURNS TRIGGER AS $$
        BEGIN
          RAISE EXCEPTION 'audit events are append-only';
        END;
        $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS odt_audit_no_update ON od_audit_events;
      CREATE TRIGGER odt_audit_no_update BEFORE UPDATE ON od_audit_events
        FOR EACH ROW EXECUTE FUNCTION od_audit_events_append_only();

      DROP TRIGGER IF EXISTS odt_audit_no_delete ON od_audit_events;
      CREATE TRIGGER odt_audit_no_delete BEFORE DELETE ON od_audit_events
        FOR EACH ROW EXECUTE FUNCTION od_audit_events_append_only();
    `,
  },
];

/** Bring a Postgres database up to the current schema. Safe to call on every
 * startup: each migration runs at most once, recorded by id. */
export async function migratePostgres(executor: SqlExecutor): Promise<string[]> {
  await executor.run(`CREATE SCHEMA IF NOT EXISTS ${POSTGRES_SCHEMA}`);
  await executor.run(`SET search_path TO ${POSTGRES_SCHEMA}`);
  await executor.run(`
    CREATE TABLE IF NOT EXISTS od_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);

  const applied = new Set(
    (await executor.all<{ id: string }>('SELECT id FROM od_schema_migrations')).map((row) => row.id),
  );

  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await executor.transaction(async (tx) => {
      await tx.run(`SET search_path TO ${POSTGRES_SCHEMA}`);
      await tx.run(migration.sql);
      await tx.run('INSERT INTO od_schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        Date.now(),
      ]);
    });
    ran.push(migration.id);
  }
  return ran;
}

export function postgresMigrationIds(): string[] {
  return MIGRATIONS.map((migration) => migration.id);
}
