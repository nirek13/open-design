-- Row-level security for hosting.
--
-- Supabase exposes every table over PostgREST, so these policies are not
-- belt-and-braces behind the edge functions — they are the actual boundary for
-- anyone who points an anon key at the REST endpoint. RLS bugs are silent and
-- total, so the shape here is deliberately blunt:
--
--   * Reads are scoped to the owner or the owning Clerk organization.
--   * Writes have NO policy at all, which under RLS means denied. Every write
--     goes through an edge function running as service_role, which authorizes
--     the caller itself before touching a row. That keeps slug allocation,
--     version numbering, and the live pointer under code that can enforce
--     invariants a policy cannot express.
--   * Anonymous abuse reporting is the single exception, and it is
--     insert-only.
--
-- Note that service_role bypasses RLS entirely; these policies govern the
-- `anon` and `authenticated` roles.

alter table sites          enable row level security;
alter table site_versions  enable row level security;
alter table site_blobs     enable row level security;
alter table abuse_reports  enable row level security;
alter table publish_events enable row level security;

-- Force RLS for the table owner too, so a future migration that runs as the
-- owning role cannot quietly sidestep these rules.
alter table sites          force row level security;
alter table site_versions  force row level security;
alter table site_blobs     force row level security;
alter table abuse_reports  force row level security;
alter table publish_events force row level security;

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------

drop policy if exists sites_select_own on sites;
create policy sites_select_own
  on sites for select
  to authenticated
  using (owner_user_id = hosting_current_user_id());

-- A member of the owning organization can see the site in the gallery. This
-- says nothing about serving: an anonymous visitor never reads this table,
-- because `serve` runs as service_role and does its own visibility check.
drop policy if exists sites_select_org on sites;
create policy sites_select_org
  on sites for select
  to authenticated
  using (
    org_id is not null
    and org_id = hosting_current_org_id()
  );

-- ---------------------------------------------------------------------------
-- site_versions
-- ---------------------------------------------------------------------------

-- Version history is visible to whoever can see the site. Expressed as an
-- EXISTS against `sites` so the two never drift: widening site visibility
-- automatically widens version visibility, and nothing else does.
drop policy if exists site_versions_select on site_versions;
create policy site_versions_select
  on site_versions for select
  to authenticated
  using (
    exists (
      select 1 from sites s
      where s.id = site_versions.site_id
        and (
          s.owner_user_id = hosting_current_user_id()
          or (s.org_id is not null and s.org_id = hosting_current_org_id())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- site_blobs
-- ---------------------------------------------------------------------------

drop policy if exists site_blobs_select on site_blobs;
create policy site_blobs_select
  on site_blobs for select
  to authenticated
  using (
    exists (
      select 1 from sites s
      where s.id = site_blobs.site_id
        and s.owner_user_id = hosting_current_user_id()
    )
  );

-- ---------------------------------------------------------------------------
-- abuse_reports
-- ---------------------------------------------------------------------------

-- Anyone may report, signed in or not. Requiring an account to report a
-- phishing page would suppress exactly the reports that matter most.
drop policy if exists abuse_reports_insert_anyone on abuse_reports;
create policy abuse_reports_insert_anyone
  on abuse_reports for insert
  to anon, authenticated
  with check (
    -- A reporter may not forge someone else's identity onto a report, and may
    -- not pre-set triage state.
    (reporter_id is null or reporter_id = hosting_current_user_id())
    and status = 'open'
    and resolved_at is null
  );

-- Deliberately no SELECT policy: reports are operator-only, read through
-- service_role tooling. Letting a reporter read the table back would expose
-- every other report on the platform.

-- ---------------------------------------------------------------------------
-- publish_events
-- ---------------------------------------------------------------------------

-- Rate-limit bookkeeping is written and read only by service_role. No policy,
-- so `anon` and `authenticated` see nothing and can write nothing — a user who
-- could delete their own publish_events rows could reset their own rate limit.
