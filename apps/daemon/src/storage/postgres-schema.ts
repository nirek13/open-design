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
  {
    id: '0004-app-shares-workspace',
    sql: `
      -- Share rows carry their owning organization for the same reason app
      -- rows do: on a shared database it is the only thing separating
      -- tenants. Added as its own migration because 0002 had already been
      -- applied — a shipped migration is never edited.
      ALTER TABLE od_app_shares ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS odx_app_shares_workspace
        ON od_app_shares(workspace_id, app_id, created_at DESC);
    `,
  },
  {
    id: '0005-ledger-proposals-questions',
    sql: `
      -- The business layer on Postgres. Mirrors the per-workspace SQLite
      -- schema in storage/workspace-db.ts; the two must stay in step, because
      -- workspace-data/ledger.ts runs the same code against either engine.
      --
      -- Money is BIGINT minor units. Never NUMERIC and never a float: the
      -- whole ledger depends on exact integer arithmetic.
      CREATE TABLE IF NOT EXISTS od_ledger_accounts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        archived_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_ledger_accounts_code
        ON od_ledger_accounts(workspace_id, code) WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS od_ledger_periods (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        closed_at BIGINT,
        closed_by TEXT,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_ledger_periods_range
        ON od_ledger_periods(workspace_id, start_date, end_date);

      CREATE TABLE IF NOT EXISTS od_journal_entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        number BIGINT,
        date TEXT NOT NULL,
        memo TEXT,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'draft',
        source_json TEXT NOT NULL,
        reversed_by_entry_id TEXT,
        reverses_entry_id TEXT,
        posted_at BIGINT,
        posted_by TEXT,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_journal_entries_ws
        ON od_journal_entries(workspace_id, status, date DESC);
      CREATE INDEX IF NOT EXISTS odx_journal_entries_source
        ON od_journal_entries(workspace_id, source_json);

      CREATE TABLE IF NOT EXISTS od_journal_lines (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES od_journal_entries(id),
        account_id TEXT NOT NULL REFERENCES od_ledger_accounts(id),
        direction TEXT NOT NULL,
        amount BIGINT NOT NULL,
        memo TEXT,
        position INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_journal_lines_entry ON od_journal_lines(entry_id, position);
      CREATE INDEX IF NOT EXISTS odx_journal_lines_account ON od_journal_lines(account_id);

      -- Immutability of the books, enforced below the application layer so it
      -- holds even against a direct SQL client. A posted entry may only move
      -- to 'reversed' and gain the link to what reversed it; corrections are
      -- new entries, always.
      CREATE OR REPLACE FUNCTION od_journal_posted_no_edit() RETURNS TRIGGER AS $od$
      BEGIN
        IF OLD.status = 'posted' AND (
          NEW.date IS DISTINCT FROM OLD.date OR
          NEW.currency IS DISTINCT FROM OLD.currency OR
          NEW.number IS DISTINCT FROM OLD.number OR
          NEW.source_json IS DISTINCT FROM OLD.source_json OR
          NEW.posted_at IS DISTINCT FROM OLD.posted_at OR
          NEW.status NOT IN ('posted', 'reversed')
        ) THEN
          RAISE EXCEPTION 'posted journal entries are immutable; post a reversing entry instead';
        END IF;
        RETURN NEW;
      END;
      $od$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS odt_journal_posted_no_edit ON od_journal_entries;
      CREATE TRIGGER odt_journal_posted_no_edit BEFORE UPDATE ON od_journal_entries
        FOR EACH ROW EXECUTE FUNCTION od_journal_posted_no_edit();

      CREATE OR REPLACE FUNCTION od_journal_posted_no_delete() RETURNS TRIGGER AS $od$
      BEGIN
        IF OLD.status IN ('posted', 'reversed') THEN
          RAISE EXCEPTION 'posted journal entries cannot be deleted';
        END IF;
        RETURN OLD;
      END;
      $od$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS odt_journal_posted_no_delete ON od_journal_entries;
      CREATE TRIGGER odt_journal_posted_no_delete BEFORE DELETE ON od_journal_entries
        FOR EACH ROW EXECUTE FUNCTION od_journal_posted_no_delete();

      CREATE OR REPLACE FUNCTION od_journal_lines_frozen() RETURNS TRIGGER AS $od$
      DECLARE
        entry_status TEXT;
      BEGIN
        SELECT status INTO entry_status FROM od_journal_entries
          WHERE id = COALESCE(OLD.entry_id, NEW.entry_id);
        IF entry_status IN ('posted', 'reversed') THEN
          RAISE EXCEPTION 'lines of a posted entry are immutable';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $od$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS odt_journal_lines_frozen ON od_journal_lines;
      CREATE TRIGGER odt_journal_lines_frozen BEFORE UPDATE OR DELETE ON od_journal_lines
        FOR EACH ROW EXECUTE FUNCTION od_journal_lines_frozen();

      -- Proposals: worked-out changes awaiting a human yes.
      CREATE TABLE IF NOT EXISTS od_proposals (
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
        decided_at BIGINT,
        applied_at BIGINT,
        undone_at BIGINT,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_proposals_ws
        ON od_proposals(workspace_id, status, created_at DESC);

      -- Saved questions, pinnable to the home screen.
      CREATE TABLE IF NOT EXISTS od_saved_questions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        question TEXT NOT NULL,
        table_ref TEXT NOT NULL,
        filters_json TEXT NOT NULL DEFAULT '[]',
        aggregate_json TEXT,
        kind TEXT NOT NULL DEFAULT 'metric',
        pinned_position INTEGER,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_saved_questions_ws
        ON od_saved_questions(workspace_id, pinned_position);
    `,
  },
  {
    id: '0006-team-chat',
    sql: `
      -- Team chat. Mirrors WORKSPACE_MIGRATIONS v5 in storage/workspace-db.ts;
      -- see there for why chat has its own tables instead of using od_records.
      CREATE TABLE IF NOT EXISTS od_chat_channels (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        topic TEXT,
        visibility TEXT NOT NULL DEFAULT 'public',
        archived_at BIGINT,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_chat_channel_slug
        ON od_chat_channels(workspace_id, slug) WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS od_chat_channel_members (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at BIGINT NOT NULL,
        last_read_at BIGINT NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_chat_member_unique
        ON od_chat_channel_members(channel_id, member_id);

      CREATE TABLE IF NOT EXISTS od_chat_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        author_member_id TEXT,
        body TEXT NOT NULL,
        system INTEGER NOT NULL DEFAULT 0,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        mentions_json TEXT NOT NULL DEFAULT '[]',
        parent_message_id TEXT REFERENCES od_chat_messages(id),
        edited_at BIGINT,
        deleted_at BIGINT,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_chat_messages_channel
        ON od_chat_messages(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS odx_chat_messages_thread
        ON od_chat_messages(parent_message_id, created_at ASC);
    `,
  },
  {
    id: '0007-views',
    sql: `
      -- Saved views. Mirrors WORKSPACE_MIGRATIONS v6 in storage/workspace-db.ts.
      CREATE TABLE IF NOT EXISTS od_views (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
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
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_views_table ON od_views(table_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS odx_views_default
        ON od_views(table_id) WHERE is_default = 1;
    `,
  },
  {
    id: '0008-template-packs',
    sql: `
      -- Packs an organization wrote itself. Mirrors WORKSPACE_MIGRATIONS v7.
      CREATE TABLE IF NOT EXISTS od_template_packs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        spec_json TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_template_packs_slug
        ON od_template_packs(workspace_id, slug);
    `,
  },
  {
    id: '0009-app-data-scopes',
    sql: `
      -- What an app declared it needs. Mirrors WORKSPACE_MIGRATIONS v8.
      ALTER TABLE od_apps ADD COLUMN IF NOT EXISTS data_scopes_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: '0010-pages',
    sql: `
      -- Notion-shaped pages + blocks. Mirrors WORKSPACE_MIGRATIONS v9.
      CREATE TABLE IF NOT EXISTS od_pages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        parent_page_id TEXT REFERENCES od_pages(id),
        title TEXT NOT NULL,
        icon TEXT,
        cover TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        archived_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS odx_pages_workspace
        ON od_pages(workspace_id, parent_page_id, position);
      CREATE INDEX IF NOT EXISTS odx_pages_active
        ON od_pages(workspace_id, archived_at);

      CREATE TABLE IF NOT EXISTS od_blocks (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES od_pages(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        parent_block_id TEXT REFERENCES od_blocks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        content_json TEXT NOT NULL DEFAULT '""',
        props_json TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_blocks_page
        ON od_blocks(page_id, parent_block_id, position);
    `,
  },
  {
    id: '0011-page-record-link',
    sql: `
      ALTER TABLE od_pages ADD COLUMN IF NOT EXISTS linked_record_id TEXT;
      ALTER TABLE od_pages ADD COLUMN IF NOT EXISTS linked_table_id TEXT;
      CREATE INDEX IF NOT EXISTS odx_pages_linked_record
        ON od_pages(workspace_id, linked_record_id);
    `,
  },
  {
    id: '0012-app-access-pin',
    sql: `
      ALTER TABLE od_apps ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'org';
      ALTER TABLE od_apps ADD COLUMN IF NOT EXISTS pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE od_apps ADD COLUMN IF NOT EXISTS pinned_at BIGINT;
      CREATE TABLE IF NOT EXISTS od_app_grants (
        app_id TEXT NOT NULL REFERENCES od_apps(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (app_id, member_id)
      );
      CREATE INDEX IF NOT EXISTS odx_app_grants_member
        ON od_app_grants(workspace_id, member_id);
      CREATE INDEX IF NOT EXISTS odx_apps_pinned
        ON od_apps(workspace_id, pinned, pinned_at DESC);
    `,
  },
  {
    id: '0013-calendar-events',
    sql: `
      CREATE TABLE IF NOT EXISTS od_calendar_events (
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
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_calendar_events_range
        ON od_calendar_events(workspace_id, starts_at, ends_at);
      CREATE UNIQUE INDEX IF NOT EXISTS odx_calendar_events_google
        ON od_calendar_events(workspace_id, google_event_id)
        WHERE google_event_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS od_calendar_meta (
        workspace_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, key)
      );
    `,
  },
  {
    id: '0014-org-invite-targets',
    sql: `
      ALTER TABLE od_users ADD COLUMN IF NOT EXISTS username TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS odx_users_username
        ON od_users (LOWER(username))
        WHERE username IS NOT NULL AND username != '';

      ALTER TABLE od_workspace_invites ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'link';
      ALTER TABLE od_workspace_invites ADD COLUMN IF NOT EXISTS target_email TEXT;
      ALTER TABLE od_workspace_invites ADD COLUMN IF NOT EXISTS target_username TEXT;
      ALTER TABLE od_workspace_invites ADD COLUMN IF NOT EXISTS target_user_id TEXT;
      CREATE INDEX IF NOT EXISTS odx_invites_target_email
        ON od_workspace_invites (target_email)
        WHERE target_email IS NOT NULL;
      CREATE INDEX IF NOT EXISTS odx_invites_target_user
        ON od_workspace_invites (target_user_id)
        WHERE target_user_id IS NOT NULL;
    `,
  },
  {
    id: '0015-chat-dms-reactions',
    sql: `
      -- Direct messages, group DMs, and emoji reactions. Mirrors the next
      -- WORKSPACE_MIGRATIONS step in storage/workspace-db.ts.
      ALTER TABLE od_chat_channels ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'channel';
      CREATE TABLE IF NOT EXISTS od_chat_reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_chat_reaction_unique
        ON od_chat_reactions(message_id, member_id, emoji);
      CREATE INDEX IF NOT EXISTS odx_chat_reaction_message
        ON od_chat_reactions(message_id);
    `,
  },
  {
    id: '0016-app-web-url',
    sql: `
      ALTER TABLE od_apps ADD COLUMN IF NOT EXISTS web_url TEXT;
    `,
  },
  {
    id: '0017-user-profile',
    sql: `
      ALTER TABLE od_users ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE od_users ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
    `,
  },
  {
    id: '0018-org-teams-app-audience',
    sql: `
      CREATE TABLE IF NOT EXISTS od_org_teams (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES od_workspaces(id),
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_org_teams_slug
        ON od_org_teams(workspace_id, slug);
      CREATE TABLE IF NOT EXISTS od_org_team_members (
        team_id TEXT NOT NULL REFERENCES od_org_teams(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (team_id, member_id)
      );
      CREATE INDEX IF NOT EXISTS odx_org_team_members_member
        ON od_org_team_members(workspace_id, member_id);

      CREATE TABLE IF NOT EXISTS od_app_team_grants (
        app_id TEXT NOT NULL REFERENCES od_apps(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (app_id, team_id)
      );
      CREATE INDEX IF NOT EXISTS odx_app_team_grants_team
        ON od_app_team_grants(workspace_id, team_id);
      CREATE TABLE IF NOT EXISTS od_app_denials (
        app_id TEXT NOT NULL REFERENCES od_apps(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (app_id, member_id)
      );
      CREATE INDEX IF NOT EXISTS odx_app_denials_member
        ON od_app_denials(workspace_id, member_id);
    `,
  },
  {
    id: '0019-org-branding',
    sql: `
      ALTER TABLE od_workspaces ADD COLUMN IF NOT EXISTS website_url TEXT;
      ALTER TABLE od_workspaces ADD COLUMN IF NOT EXISTS default_design_system_id TEXT;
      ALTER TABLE od_workspaces ADD COLUMN IF NOT EXISTS setup_completed_at BIGINT;
      UPDATE od_workspaces SET setup_completed_at = created_at WHERE setup_completed_at IS NULL;
    `,
  },
  {
    id: '0020-member-reports-to',
    sql: `
      ALTER TABLE od_workspace_members ADD COLUMN IF NOT EXISTS reports_to TEXT;
      CREATE INDEX IF NOT EXISTS odx_members_reports_to
        ON od_workspace_members(workspace_id, reports_to)
        WHERE reports_to IS NOT NULL;
    `,
  },
  {
    id: '0021-chat-messaging',
    sql: `
      -- Slack-shaped messaging extras. Mirrors WORKSPACE_MIGRATIONS v17.
      ALTER TABLE od_chat_channels ADD COLUMN IF NOT EXISTS purpose TEXT;
      ALTER TABLE od_chat_channel_members ADD COLUMN IF NOT EXISTS starred INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE od_chat_channel_members ADD COLUMN IF NOT EXISTS muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE od_chat_channel_members ADD COLUMN IF NOT EXISTS notify TEXT NOT NULL DEFAULT 'all';

      CREATE TABLE IF NOT EXISTS od_chat_pins (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        pinned_by TEXT NOT NULL,
        pinned_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_chat_pin_unique ON od_chat_pins(channel_id, message_id);
      CREATE INDEX IF NOT EXISTS odx_chat_pins_channel ON od_chat_pins(channel_id, pinned_at DESC);

      CREATE TABLE IF NOT EXISTS od_chat_saves (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_chat_save_unique ON od_chat_saves(member_id, message_id);
      CREATE INDEX IF NOT EXISTS odx_chat_saves_member ON od_chat_saves(workspace_id, member_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS od_chat_reminders (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES od_chat_messages(id) ON DELETE CASCADE,
        fire_at BIGINT NOT NULL,
        note TEXT,
        delivered_at BIGINT,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_chat_reminders_due
        ON od_chat_reminders(workspace_id, member_id, fire_at)
        WHERE delivered_at IS NULL;

      CREATE TABLE IF NOT EXISTS od_chat_bookmarks (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        emoji TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_chat_bookmarks_channel ON od_chat_bookmarks(channel_id, position);

      CREATE TABLE IF NOT EXISTS od_chat_scheduled (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES od_chat_channels(id) ON DELETE CASCADE,
        author_member_id TEXT NOT NULL,
        body TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        mentions_json TEXT NOT NULL DEFAULT '[]',
        parent_message_id TEXT,
        send_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_chat_scheduled_due ON od_chat_scheduled(workspace_id, send_at);

      CREATE TABLE IF NOT EXISTS od_chat_profiles (
        member_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        status_text TEXT,
        status_emoji TEXT,
        status_expires_at BIGINT,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_chat_profiles_ws ON od_chat_profiles(workspace_id);
    `,
  },
  {
    id: '0018-page-style',
    sql: `
      -- Notion page appearance. Mirrors WORKSPACE_MIGRATIONS v18.
      ALTER TABLE od_pages ADD COLUMN IF NOT EXISTS style_json TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    id: '0022-named-calendars',
    sql: `
      CREATE TABLE IF NOT EXISTS od_calendars (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        visible INTEGER NOT NULL DEFAULT 1,
        external_id TEXT,
        ics_url TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_calendars_ws ON od_calendars(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS odx_calendars_external
        ON od_calendars(workspace_id, source, external_id)
        WHERE external_id IS NOT NULL;
      ALTER TABLE od_calendar_events ADD COLUMN IF NOT EXISTS calendar_id TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN IF NOT EXISTS color TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN IF NOT EXISTS recurrence TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN IF NOT EXISTS timezone TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN IF NOT EXISTS attendees TEXT;
      ALTER TABLE od_calendar_events ADD COLUMN IF NOT EXISTS external_uid TEXT;
      CREATE INDEX IF NOT EXISTS odx_calendar_events_cal
        ON od_calendar_events(workspace_id, calendar_id);
      CREATE UNIQUE INDEX IF NOT EXISTS odx_calendar_events_external
        ON od_calendar_events(workspace_id, source, external_uid)
        WHERE external_uid IS NOT NULL;
    `,
  },
  {
    id: '0023-calendar-sharing',
    sql: `
      ALTER TABLE od_calendars ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'shared';
      ALTER TABLE od_calendars ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
      ALTER TABLE od_calendars ADD COLUMN IF NOT EXISTS team_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS odx_calendars_personal
        ON od_calendars(workspace_id, owner_user_id)
        WHERE kind = 'personal' AND owner_user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS odx_calendars_team ON od_calendars(workspace_id, team_id);
      CREATE TABLE IF NOT EXISTS od_calendar_event_guests (
        event_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (event_id, kind, subject_id)
      );
      CREATE INDEX IF NOT EXISTS odx_calendar_event_guests_subject
        ON od_calendar_event_guests(workspace_id, kind, subject_id);
    `,
  },
  {
    id: '0024-calendar-booking-links',
    sql: `
      CREATE TABLE IF NOT EXISTS od_booking_routes (
        token_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        booking_type_id TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS od_calendar_booking_types (
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
        revoked_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS odx_booking_types_ws
        ON od_calendar_booking_types(workspace_id, owner_user_id);
      CREATE TABLE IF NOT EXISTS od_calendar_bookings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        booking_type_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        guest_name TEXT NOT NULL,
        guest_email TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS odx_calendar_bookings_slot
        ON od_calendar_bookings(booking_type_id, starts_at);
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
