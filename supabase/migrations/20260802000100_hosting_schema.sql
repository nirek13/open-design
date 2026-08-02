-- One-click hosting: sites, immutable versions, and blob bookkeeping.
--
-- This schema is the authority for published sites. The daemon on a user's
-- machine holds no source of truth — it reads project files and uploads bytes,
-- and everything about what is live lives here. That is what lets a published
-- link keep working after the publisher closes their laptop.
--
-- Identity comes from Clerk via Supabase third-party auth, so `auth.jwt()`
-- carries the Clerk claims:
--     sub          -> Clerk user id
--     o ->> 'id'   -> active Clerk organization id
--     o ->> 'rol'  -> role in that organization
--
-- Organization membership is deliberately NOT mirrored into these tables.
-- Clerk stays the single source of truth, so revoking someone's membership
-- takes effect on their next request with no sync job to go stale.

create extension if not exists "citext";
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Clerk user id of the caller, or null for an anonymous request.
create or replace function hosting_current_user_id()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

-- Active Clerk organization of the caller, or null when acting personally.
create or replace function hosting_current_org_id()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() -> 'o' ->> 'id', '')
$$;

-- ---------------------------------------------------------------------------
-- Sites
-- ---------------------------------------------------------------------------

create table if not exists sites (
  id              uuid primary key default gen_random_uuid(),
  -- citext so `MyApp` and `myapp` cannot both be claimed. Slugs are lowercased
  -- by the application, but the constraint belongs in the database too: it is
  -- the only place that can enforce it under concurrent publishes.
  slug            citext not null unique,
  owner_user_id   text not null,
  org_id          text,
  visibility      text not null default 'public'
                    check (visibility in ('public', 'org')),
  status          text not null default 'active'
                    check (status in ('active', 'unpublished', 'suspended')),
  -- Set after the first version commits; null during the first publish.
  live_version_id uuid,
  -- Provenance only. A project id is meaningless outside the machine that
  -- created it, so nothing here may depend on it resolving.
  project_id      text,
  entry_file      text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- An org-visible site must belong to an org. Without this, a site could
  -- claim org-only visibility with no org to check membership against, and the
  -- serving function would have nothing to compare the caller's claim to.
  constraint sites_org_visibility_requires_org
    check (visibility <> 'org' or org_id is not null)
);

create index if not exists idx_sites_owner on sites (owner_user_id, updated_at desc);
create index if not exists idx_sites_org on sites (org_id, updated_at desc) where org_id is not null;
create index if not exists idx_sites_project on sites (project_id) where project_id is not null;

-- ---------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------

create table if not exists site_versions (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references sites (id) on delete cascade,
  version_number integer not null,
  -- path -> { hash, size, contentType }. Kept in Postgres rather than as a
  -- Storage object so a commit is transactional and the serving function can
  -- resolve a path with one indexed read instead of a fetch-and-parse.
  manifest       jsonb not null,
  file_count     integer not null,
  total_bytes    bigint not null,
  created_by     text not null,
  created_at     timestamptz not null default now(),

  unique (site_id, version_number)
);

create index if not exists idx_site_versions_site
  on site_versions (site_id, version_number desc);

-- Deferred so the two tables can reference each other.
alter table sites
  drop constraint if exists sites_live_version_fk;
alter table sites
  add constraint sites_live_version_fk
  foreign key (live_version_id) references site_versions (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Blobs
-- ---------------------------------------------------------------------------

-- What is already uploaded for a site. This table is the incremental-publish
-- diff: `publish-begin` answers "which of these hashes do you already have?"
-- with one indexed query instead of listing Storage.
create table if not exists site_blobs (
  site_id    uuid not null references sites (id) on delete cascade,
  hash       text not null check (hash ~ '^[0-9a-f]{64}$'),
  size       bigint not null,
  created_at timestamptz not null default now(),

  primary key (site_id, hash)
);

-- ---------------------------------------------------------------------------
-- Abuse reports
-- ---------------------------------------------------------------------------

-- Public hosting attracts phishing. A takedown path has to exist from the
-- first public link, not after the first incident.
create table if not exists abuse_reports (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid references sites (id) on delete set null,
  -- Denormalized so a report survives the site being deleted.
  reported_slug citext not null,
  reason      text not null,
  details     text,
  -- Null for anonymous reports, which are allowed on purpose: requiring an
  -- account to report a phishing page suppresses reports.
  reporter_id text,
  status      text not null default 'open'
                check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_abuse_reports_open
  on abuse_reports (created_at desc) where status = 'open';

-- ---------------------------------------------------------------------------
-- Publish rate limiting
-- ---------------------------------------------------------------------------

create table if not exists publish_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  site_id      uuid references sites (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_publish_events_user
  on publish_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function hosting_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_sites_updated_at on sites;
create trigger trg_sites_updated_at
  before update on sites
  for each row execute function hosting_touch_updated_at();
