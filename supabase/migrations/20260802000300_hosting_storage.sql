-- Storage bucket for site blobs.
--
-- The bucket is PRIVATE. Every read and write goes through a signed URL minted
-- by an edge function that has already authorized the caller:
--
--   * Uploads use a per-object signed upload URL, valid for minutes. The object
--     name is the content hash under the owning site's prefix, so the worst a
--     misbehaving client can do with a leaked URL is write wrong bytes into one
--     blob of its own site. It cannot reach another site's prefix.
--
--   * Reads go through the `serve` function, which resolves the request path
--     against the live version's manifest and streams the blob with
--     service_role. A public bucket would let anyone enumerate object names and
--     read an org-restricted site's assets directly, bypassing the visibility
--     check entirely.
--
-- No storage.objects policies are defined for `anon`/`authenticated`, which
-- under RLS means no direct access at all. That is the intent.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'site-blobs',
  'site-blobs',
  false,
  -- Matches MAX_ASSET_BYTES in packages/hosting/src/limits.ts. The database is
  -- the backstop; the application rejects oversized files earlier with a
  -- better message.
  26214400,
  null
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;
