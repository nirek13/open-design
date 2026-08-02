-- Transactional operations for hosting.
--
-- These live in SQL rather than in edge-function code because each one has to
-- be atomic. Allocating the next version number, recording its blobs, and
-- advancing the live pointer is a single indivisible act: a crash between the
-- second and third step would leave a site whose newest version exists but is
-- not serving, and two concurrent publishes racing on `max(version_number) + 1`
-- would collide on the unique constraint.
--
-- Callers are edge functions running as service_role, which have ALREADY
-- authorized the request. These functions therefore enforce data invariants
-- (ownership, slug uniqueness, version lineage) rather than identity — with one
-- exception: `hosting_claim_site` re-checks ownership, because slug theft is
-- the one attack that a caller-side check alone cannot make safe under
-- concurrency.
--
-- Every function is revoked from anon/authenticated at the bottom of this file.
-- They must never be reachable over PostgREST.

-- ---------------------------------------------------------------------------
-- Claim or reuse a site for a slug
-- ---------------------------------------------------------------------------

create or replace function hosting_claim_site(
  p_slug        citext,
  p_owner       text,
  p_org_id      text,
  p_visibility  text,
  p_project_id  text,
  p_entry_file  text
)
returns sites
language plpgsql
as $$
declare
  v_site sites;
begin
  if p_owner is null or p_owner = '' then
    raise exception 'owner required' using errcode = '22023';
  end if;
  if p_visibility = 'org' and (p_org_id is null or p_org_id = '') then
    raise exception 'org visibility requires an organization' using errcode = '22023';
  end if;

  -- Take the row lock first so two concurrent publishes of the same slug
  -- serialize here rather than both passing an ownership check and one losing
  -- on the unique index with an opaque error.
  select * into v_site from sites where slug = p_slug for update;

  if found then
    if v_site.owner_user_id <> p_owner then
      raise exception 'slug already taken' using errcode = '23505';
    end if;
    if v_site.status = 'suspended' then
      raise exception 'site is suspended' using errcode = '42501';
    end if;
    update sites
      set visibility = p_visibility,
          org_id     = p_org_id,
          project_id = coalesce(p_project_id, project_id),
          entry_file = p_entry_file,
          -- Re-publishing a site the owner had taken down brings it back.
          status     = 'active'
      where id = v_site.id
      returning * into v_site;
    return v_site;
  end if;

  insert into sites (slug, owner_user_id, org_id, visibility, project_id, entry_file)
  values (p_slug, p_owner, nullif(p_org_id, ''), p_visibility, p_project_id, p_entry_file)
  returning * into v_site;
  return v_site;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commit a version and make it live
-- ---------------------------------------------------------------------------

create or replace function hosting_commit_version(
  p_site_id     uuid,
  p_manifest    jsonb,
  p_file_count  integer,
  p_total_bytes bigint,
  p_created_by  text
)
returns site_versions
language plpgsql
as $$
declare
  v_site    sites;
  v_next    integer;
  v_version site_versions;
begin
  -- Serializes concurrent publishes of the same site.
  select * into v_site from sites where id = p_site_id for update;
  if not found then
    raise exception 'site not found' using errcode = 'P0002';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next
    from site_versions where site_id = p_site_id;

  insert into site_versions (site_id, version_number, manifest, file_count, total_bytes, created_by)
  values (p_site_id, v_next, p_manifest, p_file_count, p_total_bytes, p_created_by)
  returning * into v_version;

  -- Record the blobs this version references so the next publish can skip
  -- re-uploading them. Two versions sharing a blob is the normal case, hence
  -- the conflict clause rather than a delete-and-reinsert.
  insert into site_blobs (site_id, hash, size)
  select
    p_site_id,
    entry.value ->> 'hash',
    (entry.value ->> 'size')::bigint
  from jsonb_each(p_manifest) as entry
  on conflict (site_id, hash) do nothing;

  update sites set live_version_id = v_version.id where id = p_site_id;

  insert into publish_events (user_id, site_id) values (p_created_by, p_site_id);

  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- Roll back to an earlier version
-- ---------------------------------------------------------------------------

create or replace function hosting_rollback_site(
  p_site_id    uuid,
  p_version_id uuid
)
returns sites
language plpgsql
as $$
declare
  v_site sites;
begin
  -- A version id from another site would otherwise point a site at a manifest
  -- whose blobs live under a different prefix, producing a site that 404s
  -- every asset.
  if not exists (
    select 1 from site_versions
    where id = p_version_id and site_id = p_site_id
  ) then
    raise exception 'version does not belong to this site' using errcode = '22023';
  end if;

  update sites
    set live_version_id = p_version_id,
        status = case when status = 'unpublished' then 'active' else status end
    where id = p_site_id
    returning * into v_site;

  if not found then
    raise exception 'site not found' using errcode = 'P0002';
  end if;
  return v_site;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resolve a slug to what should be served
-- ---------------------------------------------------------------------------

-- One query per request on the serving hot path: the site's visibility, its
-- owning org, and the live manifest together.
create or replace function hosting_resolve_live(p_slug citext)
returns table (
  site_id     uuid,
  slug        citext,
  visibility  text,
  status      text,
  org_id      text,
  entry_file  text,
  version_id  uuid,
  version_number integer,
  manifest    jsonb
)
language sql
stable
as $$
  select
    s.id, s.slug, s.visibility, s.status, s.org_id, s.entry_file,
    v.id, v.version_number, v.manifest
  from sites s
  join site_versions v on v.id = s.live_version_id
  where s.slug = p_slug
    and s.status = 'active'
$$;

-- ---------------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------------

create or replace function hosting_publishes_last_hour(p_user_id text)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from publish_events
  where user_id = p_user_id
    and created_at > now() - interval '1 hour'
$$;

-- ---------------------------------------------------------------------------
-- Lock down execution
-- ---------------------------------------------------------------------------

-- PostgREST exposes functions as RPC endpoints. None of these perform their own
-- identity checks, so reaching them with an anon key would be a full bypass of
-- every policy in the RLS migration.
revoke all on function hosting_claim_site(citext, text, text, text, text, text) from public, anon, authenticated;
revoke all on function hosting_commit_version(uuid, jsonb, integer, bigint, text) from public, anon, authenticated;
revoke all on function hosting_rollback_site(uuid, uuid) from public, anon, authenticated;
revoke all on function hosting_resolve_live(citext) from public, anon, authenticated;
revoke all on function hosting_publishes_last_hour(text) from public, anon, authenticated;

grant execute on function hosting_claim_site(citext, text, text, text, text, text) to service_role;
grant execute on function hosting_commit_version(uuid, jsonb, integer, bigint, text) to service_role;
grant execute on function hosting_rollback_site(uuid, uuid) to service_role;
grant execute on function hosting_resolve_live(citext) to service_role;
grant execute on function hosting_publishes_last_hour(text) to service_role;
