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
import { applySqliteRuntimePragmas } from './sqlite-pragmas.js';

type SqliteDb = Database.Database;

const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSafeWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_PATTERN.test(id);
}

function openSqlite(file: string): SqliteDb {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  applySqliteRuntimePragmas(db);
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
  // v3 — targeted invites (email / username) and an optional unique username
  // on directory users so a coworker can be invited by the name they sign in
  // with, not only by a pasteable link.
  (db) => {
    db.exec(`
      ALTER TABLE od_users ADD COLUMN username TEXT;
      CREATE UNIQUE INDEX odx_users_username
        ON od_users (lower(username))
        WHERE username IS NOT NULL AND username != '';

      ALTER TABLE od_workspace_invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'link';
      ALTER TABLE od_workspace_invites ADD COLUMN target_email TEXT;
      ALTER TABLE od_workspace_invites ADD COLUMN target_username TEXT;
      ALTER TABLE od_workspace_invites ADD COLUMN target_user_id TEXT;
      CREATE INDEX odx_invites_target_email
        ON od_workspace_invites (target_email)
        WHERE target_email IS NOT NULL;
      CREATE INDEX odx_invites_target_user
        ON od_workspace_invites (target_user_id)
        WHERE target_user_id IS NOT NULL;
    `);
  },
  // v4 — profile copy and a photo content-type so teammates can tell people
  // apart by more than a username. The image bytes live under the daemon
  // data root, not in this table.
  (db) => {
    db.exec(`
      ALTER TABLE od_users ADD COLUMN bio TEXT;
      ALTER TABLE od_users ADD COLUMN avatar_mime TEXT;
    `);
  },
  // v5 — named teams inside an organization. Privilege stays on member.role
  // (owner/admin/member); a team is a subset you grant or send an app to.
  (db) => {
    db.exec(`
      CREATE TABLE od_org_teams (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES od_workspaces(id),
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_org_teams_slug
        ON od_org_teams(workspace_id, slug);
      CREATE TABLE od_org_team_members (
        team_id TEXT NOT NULL REFERENCES od_org_teams(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, member_id)
      );
      CREATE INDEX odx_org_team_members_member
        ON od_org_team_members(workspace_id, member_id);
    `);
  },
  // v6 — first-run website branding on the organization itself.
  (db) => {
    db.exec(`
      ALTER TABLE od_workspaces ADD COLUMN website_url TEXT;
      ALTER TABLE od_workspaces ADD COLUMN default_design_system_id TEXT;
      ALTER TABLE od_workspaces ADD COLUMN setup_completed_at INTEGER;
      UPDATE od_workspaces SET setup_completed_at = created_at WHERE setup_completed_at IS NULL;
    `);
  },
  // v7 — reporting hierarchy. Search (and any other "who can see whose
  // work" rule) walks this pointer: above = managers, below = reports.
  (db) => {
    db.exec(`
      ALTER TABLE od_workspace_members ADD COLUMN reports_to TEXT;
      CREATE INDEX odx_members_reports_to
        ON od_workspace_members(workspace_id, reports_to)
        WHERE reports_to IS NOT NULL;
    `);
  },
  // v8 — public Calendly-style booking links. Token lookup lives in the
  // directory so `/book/:token` can find the org without scanning tenants.
  (db) => {
    db.exec(`
      CREATE TABLE od_booking_routes (
        token_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        booking_type_id TEXT NOT NULL,
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
  // v4 — the accounting core, human-in-the-loop proposals, and saved
  // questions.
  //
  // The ledger is the one part of the system that is deliberately rigid:
  // business documents live in user-editable tables so anyone can add a field
  // by asking, but the books do not bend. Posted entries and their lines are
  // immutable below the app layer, enforced the same way the audit trail is.
  (db) => {
    db.exec(`
      CREATE TABLE od_ledger_accounts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_ledger_accounts_code
        ON od_ledger_accounts(workspace_id, code) WHERE archived_at IS NULL;

      CREATE TABLE od_ledger_periods (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        closed_at INTEGER,
        closed_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX odx_ledger_periods_range
        ON od_ledger_periods(workspace_id, start_date, end_date);

      CREATE TABLE od_journal_entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        number INTEGER,
        date TEXT NOT NULL,
        memo TEXT,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'draft',
        source_json TEXT NOT NULL,
        reversed_by_entry_id TEXT,
        reverses_entry_id TEXT,
        posted_at INTEGER,
        posted_by TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_journal_entries_ws
        ON od_journal_entries(workspace_id, status, date DESC);
      CREATE INDEX odx_journal_entries_source
        ON od_journal_entries(workspace_id, source_json);

      CREATE TABLE od_journal_lines (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES od_journal_entries(id),
        account_id TEXT NOT NULL REFERENCES od_ledger_accounts(id),
        direction TEXT NOT NULL,
        amount INTEGER NOT NULL,
        memo TEXT,
        position INTEGER NOT NULL
      );
      CREATE INDEX odx_journal_lines_entry ON od_journal_lines(entry_id, position);
      CREATE INDEX odx_journal_lines_account ON od_journal_lines(account_id);

      -- Immutability of the books, enforced below the application layer.
      -- A posted entry may only ever move to 'reversed' and gain the link to
      -- the entry that reversed it; nothing else about it can change, and it
      -- can never be deleted. Corrections are new entries, always.
      CREATE TRIGGER odt_journal_posted_no_edit BEFORE UPDATE ON od_journal_entries
        WHEN OLD.status = 'posted' AND (
          NEW.date != OLD.date OR NEW.currency != OLD.currency OR
          NEW.number IS NOT OLD.number OR NEW.source_json != OLD.source_json OR
          NEW.posted_at IS NOT OLD.posted_at OR
          NEW.status NOT IN ('posted', 'reversed')
        )
        BEGIN SELECT RAISE(ABORT, 'posted journal entries are immutable; post a reversing entry instead'); END;

      CREATE TRIGGER odt_journal_posted_no_delete BEFORE DELETE ON od_journal_entries
        WHEN OLD.status IN ('posted', 'reversed')
        BEGIN SELECT RAISE(ABORT, 'posted journal entries cannot be deleted'); END;

      CREATE TRIGGER odt_journal_lines_no_edit BEFORE UPDATE ON od_journal_lines
        WHEN (SELECT status FROM od_journal_entries WHERE id = OLD.entry_id) IN ('posted', 'reversed')
        BEGIN SELECT RAISE(ABORT, 'lines of a posted entry are immutable'); END;

      CREATE TRIGGER odt_journal_lines_no_delete BEFORE DELETE ON od_journal_lines
        WHEN (SELECT status FROM od_journal_entries WHERE id = OLD.entry_id) IN ('posted', 'reversed')
        BEGIN SELECT RAISE(ABORT, 'lines of a posted entry cannot be deleted'); END;

      -- Proposals: worked-out changes awaiting a human yes.
      CREATE TABLE od_proposals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        intent TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'agent',
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        operations_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        effects_json TEXT,
        error TEXT,
        created_by TEXT NOT NULL,
        decided_by TEXT,
        decided_at INTEGER,
        applied_at INTEGER,
        undone_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX odx_proposals_ws ON od_proposals(workspace_id, status, created_at DESC);

      -- Saved questions, pinnable to the home screen.
      CREATE TABLE od_saved_questions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        question TEXT NOT NULL,
        table_ref TEXT NOT NULL,
        filters_json TEXT NOT NULL DEFAULT '[]',
        aggregate_json TEXT,
        kind TEXT NOT NULL DEFAULT 'metric',
        pinned_position INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_saved_questions_ws
        ON od_saved_questions(workspace_id, pinned_position);
    `);
  },

  // v5 — team chat.
  //
  // Chat gets real tables rather than living in od_records because its rules
  // differ: a channel has its own member list separate from the organization's,
  // messages are append-mostly and read in time order at a volume records were
  // not sized for, and "what have I not read" is per-person state no other
  // member can see. Same reasoning that gave the ledger its own tables.
  (db) => {
    db.exec(`
      CREATE TABLE od_chat_channels (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        topic TEXT,
        visibility TEXT NOT NULL DEFAULT 'public',
        archived_at INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- One #general per organization. Partial so an archived channel's name
      -- can be reused rather than being burned forever.
      CREATE UNIQUE INDEX odx_chat_channel_slug
        ON od_chat_channels(workspace_id, slug) WHERE archived_at IS NULL;

      CREATE TABLE od_chat_channel_members (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        -- Read position as a timestamp, not a message id: it stays correct
        -- when the message it pointed at is deleted.
        last_read_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX odx_chat_member_unique
        ON od_chat_channel_members(channel_id, member_id);

      CREATE TABLE od_chat_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        author_member_id TEXT,
        body TEXT NOT NULL,
        system INTEGER NOT NULL DEFAULT 0,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        mentions_json TEXT NOT NULL DEFAULT '[]',
        parent_message_id TEXT REFERENCES od_chat_messages(id),
        edited_at INTEGER,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL
      );
      -- The read path is always "this channel, newest first".
      CREATE INDEX odx_chat_messages_channel
        ON od_chat_messages(channel_id, created_at DESC);
      CREATE INDEX odx_chat_messages_thread
        ON od_chat_messages(parent_message_id, created_at ASC);
    `);
  },

  // v6 — saved views.
  //
  // A view owns no data: it is a stored lens (filters, sorts, grouping, which
  // fields, drawn how) over a table. Deleting every view leaves the records
  // untouched, which is the property that makes them safe to create freely.
  (db) => {
    db.exec(`
      CREATE TABLE od_views (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        table_id TEXT NOT NULL REFERENCES od_tables(id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'table',
        filters_json TEXT NOT NULL DEFAULT '[]',
        sorts_json TEXT NOT NULL DEFAULT '[]',
        group_by TEXT,
        date_field TEXT,
        visible_fields_json TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_views_table ON od_views(table_id, position);
      -- At most one default per table, enforced by the engine rather than by
      -- a read-then-write check that two tabs could both pass.
      CREATE UNIQUE INDEX odx_views_default
        ON od_views(table_id) WHERE is_default = 1;
    `);
  },

  // v7 — packs an organization wrote itself.
  //
  // The built-in packs live in contracts as code. These are the same shape,
  // stored per organization, so a customer (or the assistant on their behalf)
  // can define "Fleet" or "Clinics" and install it through exactly the same
  // installer — no code change, no deploy, no waiting for us.
  (db) => {
    db.exec(`
      CREATE TABLE od_template_packs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        -- The whole pack definition, validated on write. Stored as one
        -- document because it is authored, versioned, and installed as one.
        spec_json TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_template_packs_slug
        ON od_template_packs(workspace_id, slug);
    `);
  },

  // v8 — what an app declared it needs.
  //
  // An app runs sandboxed with no network of its own and asks the host page
  // for data by postMessage. This column is the list the host checks each
  // request against, and the list a person is shown before running the app.
  // Absent means an app that reads and writes nothing, which is what every
  // app published before this migration was.
  (db) => {
    db.exec(`ALTER TABLE od_apps ADD COLUMN data_scopes_json TEXT NOT NULL DEFAULT '[]';`);
  },

  // v9 — Notion-shaped pages + blocks (see specs/current/notion-pages.md).
  (db) => {
    db.exec(`
      CREATE TABLE od_pages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        parent_page_id TEXT REFERENCES od_pages(id),
        title TEXT NOT NULL,
        icon TEXT,
        cover TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX odx_pages_workspace
        ON od_pages(workspace_id, parent_page_id, position);
      CREATE INDEX odx_pages_active
        ON od_pages(workspace_id, archived_at);

      CREATE TABLE od_blocks (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES od_pages(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        parent_block_id TEXT REFERENCES od_blocks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        content_json TEXT NOT NULL DEFAULT '""',
        props_json TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_blocks_page
        ON od_blocks(page_id, parent_block_id, position);
    `);
  },

  // v10 — link a page to an ERP / workspace record.
  (db) => {
    db.exec(`
      ALTER TABLE od_pages ADD COLUMN linked_record_id TEXT;
      ALTER TABLE od_pages ADD COLUMN linked_table_id TEXT;
      CREATE INDEX odx_pages_linked_record
        ON od_pages(workspace_id, linked_record_id);
    `);
  },

  // v11 — org app pin + hybrid access (whole-org vs selected grants).
  (db) => {
    db.exec(`
      ALTER TABLE od_apps ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'org';
      ALTER TABLE od_apps ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE od_apps ADD COLUMN pinned_at INTEGER;
      CREATE TABLE od_app_grants (
        app_id TEXT NOT NULL REFERENCES od_apps(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, member_id)
      );
      CREATE INDEX odx_app_grants_member
        ON od_app_grants(workspace_id, member_id);
      CREATE INDEX odx_apps_pinned
        ON od_apps(workspace_id, pinned, pinned_at DESC);
    `);
  },

  // v12 — organization calendar events (+ Google sync metadata).
  (db) => {
    db.exec(`
      CREATE TABLE od_calendar_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        google_event_id TEXT,
        source TEXT NOT NULL DEFAULT 'local',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_calendar_events_range
        ON od_calendar_events(workspace_id, starts_at, ends_at);
      CREATE UNIQUE INDEX odx_calendar_events_google
        ON od_calendar_events(workspace_id, google_event_id)
        WHERE google_event_id IS NOT NULL;
      CREATE TABLE od_calendar_meta (
        workspace_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, key)
      );
    `);
  },

  // Direct messages, group DMs, and per-message emoji reactions.
  (db) => {
    db.exec(`
      ALTER TABLE od_chat_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel';
      CREATE TABLE od_chat_reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_chat_reaction_unique
        ON od_chat_reactions(message_id, member_id, emoji);
      CREATE INDEX odx_chat_reaction_message ON od_chat_reactions(message_id);
    `);
  },

  // Lasting public URL for one-click app-to-web publish.
  (db) => {
    db.exec(`ALTER TABLE od_apps ADD COLUMN web_url TEXT;`);
  },

  // v15 — team grants and per-person denials on org apps.
  (db) => {
    db.exec(`
      CREATE TABLE od_app_team_grants (
        app_id TEXT NOT NULL REFERENCES od_apps(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, team_id)
      );
      CREATE INDEX odx_app_team_grants_team
        ON od_app_team_grants(workspace_id, team_id);
      CREATE TABLE od_app_denials (
        app_id TEXT NOT NULL REFERENCES od_apps(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, member_id)
      );
      CREATE INDEX odx_app_denials_member
        ON od_app_denials(workspace_id, member_id);
    `);
  },

  // v16 — opt-in public appends (intake forms) on a table.
  (db) => {
    db.exec(`ALTER TABLE od_tables ADD COLUMN public_write INTEGER NOT NULL DEFAULT 0;`);
  },

  // v17 — Slack-shaped messaging: channel purpose/prefs, pins, later, reminders,
  // bookmarks, scheduled posts, and per-member status.
  (db) => {
    db.exec(`
      ALTER TABLE od_chat_channels ADD COLUMN purpose TEXT;
      ALTER TABLE od_chat_channel_members ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE od_chat_channel_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE od_chat_channel_members ADD COLUMN notify TEXT NOT NULL DEFAULT 'all';

      CREATE TABLE od_chat_pins (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        pinned_by TEXT NOT NULL,
        pinned_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_chat_pin_unique ON od_chat_pins(channel_id, message_id);
      CREATE INDEX odx_chat_pins_channel ON od_chat_pins(channel_id, pinned_at DESC);

      CREATE TABLE od_chat_saves (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_chat_save_unique ON od_chat_saves(member_id, message_id);
      CREATE INDEX odx_chat_saves_member ON od_chat_saves(workspace_id, member_id, created_at DESC);

      CREATE TABLE od_chat_reminders (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        fire_at INTEGER NOT NULL,
        note TEXT,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX odx_chat_reminders_due
        ON od_chat_reminders(workspace_id, member_id, fire_at)
        WHERE delivered_at IS NULL;

      CREATE TABLE od_chat_bookmarks (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        emoji TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX odx_chat_bookmarks_channel ON od_chat_bookmarks(channel_id, position);

      CREATE TABLE od_chat_scheduled (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        author_member_id TEXT NOT NULL,
        body TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        mentions_json TEXT NOT NULL DEFAULT '[]',
        parent_message_id TEXT,
        send_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX odx_chat_scheduled_due ON od_chat_scheduled(workspace_id, send_at);

      CREATE TABLE od_chat_profiles (
        member_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        status_text TEXT,
        status_emoji TEXT,
        status_expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_chat_profiles_ws ON od_chat_profiles(workspace_id);
    `);
  },

  // v18 — Notion page appearance (font, width, lock).
  (db) => {
    db.exec(`ALTER TABLE od_pages ADD COLUMN style_json TEXT NOT NULL DEFAULT '{}';`);
  },

  // v19 — named calendars + Notion/Apple import fields on events.
  (db) => {
    db.exec(`
      CREATE TABLE od_calendars (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        visible INTEGER NOT NULL DEFAULT 1,
        external_id TEXT,
        ics_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_calendars_ws ON od_calendars(workspace_id);
      CREATE UNIQUE INDEX odx_calendars_external
        ON od_calendars(workspace_id, source, external_id)
        WHERE external_id IS NOT NULL;
      ALTER TABLE od_calendar_events ADD COLUMN calendar_id TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN color TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN recurrence TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN timezone TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN attendees TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN external_uid TEXT;
      CREATE INDEX odx_calendar_events_cal ON od_calendar_events(workspace_id, calendar_id);
      CREATE UNIQUE INDEX odx_calendar_events_external
        ON od_calendar_events(workspace_id, source, external_uid)
        WHERE external_uid IS NOT NULL;
    `);
  },

  // v20 — team / personal calendars and event guests (people or teams).
  (db) => {
    db.exec(`
      ALTER TABLE od_calendars ADD COLUMN kind TEXT NOT NULL DEFAULT 'shared';
      ALTER TABLE od_calendars ADD COLUMN owner_user_id TEXT;
      ALTER TABLE od_calendars ADD COLUMN team_id TEXT;
      CREATE UNIQUE INDEX odx_calendars_personal
        ON od_calendars(workspace_id, owner_user_id)
        WHERE kind = 'personal' AND owner_user_id IS NOT NULL;
      CREATE INDEX odx_calendars_team ON od_calendars(workspace_id, team_id);
      CREATE TABLE od_calendar_event_guests (
        event_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, kind, subject_id)
      );
      CREATE INDEX odx_calendar_event_guests_subject
        ON od_calendar_event_guests(workspace_id, kind, subject_id);
    `);
  },

  // v21 — booking types (shareable availability) and confirmed bookings.
  (db) => {
    db.exec(`
      CREATE TABLE od_calendar_booking_types (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        duration_minutes INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        weekdays TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX odx_booking_types_ws
        ON od_calendar_booking_types(workspace_id, owner_user_id);
      CREATE TABLE od_calendar_bookings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        booking_type_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        guest_name TEXT NOT NULL,
        guest_email TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX odx_calendar_bookings_slot
        ON od_calendar_bookings(booking_type_id, starts_at);
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
