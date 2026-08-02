// Step 2 of publishing: verify the uploads landed, then make the version live.
//
// The verification pass matters. `publish-begin` hands out signed upload URLs,
// but nothing guarantees the client actually used them — a crashed or
// half-finished publish would otherwise commit a manifest referencing blobs
// that do not exist, producing a live site that 404s its own assets. So the
// commit re-checks every referenced object before advancing the pointer, and
// the pointer only moves if the whole version is present.

import { storageKeyFor, type SiteManifest } from '../../../packages/hosting/src/index.ts';
import { BLOB_BUCKET, serviceClient } from '../_shared/env.ts';
import { authenticate, fail, json, preflight, readJson } from '../_shared/http.ts';

interface CommitRequest {
  siteId: string;
  manifest: SiteManifest;
}

Deno.serve(async (request) => {
  const cors = preflight(request);
  if (cors) return cors;
  if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');

  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  const { env, caller } = auth.context;
  const db = serviceClient(env);

  const body = await readJson<CommitRequest>(request);
  if (!body?.siteId || !body.manifest || typeof body.manifest !== 'object') {
    return fail(400, 'BAD_REQUEST', 'siteId and manifest are required');
  }

  // --- Ownership -----------------------------------------------------------
  // service_role bypasses RLS, so this check is the authorization boundary.
  const { data: site, error: siteError } = await db
    .from('sites')
    .select('id, owner_user_id, status')
    .eq('id', body.siteId)
    .maybeSingle();
  if (siteError) return fail(500, 'INTERNAL', siteError.message);
  if (!site) return fail(404, 'NOT_FOUND', 'site not found');
  if (site.owner_user_id !== caller.userId) {
    // 404 rather than 403: confirming the id exists tells a prober they found
    // someone else's site.
    return fail(404, 'NOT_FOUND', 'site not found');
  }
  if (site.status === 'suspended') return fail(403, 'SITE_SUSPENDED', 'This site has been suspended.');

  // --- Verify every blob landed -------------------------------------------
  const entries = Object.entries(body.manifest);
  if (entries.length === 0) return fail(400, 'EMPTY_SITE', 'There is nothing to publish.');

  const hashes = [...new Set(entries.map(([, entry]) => entry.hash))];
  const missing: string[] = [];
  let totalBytes = 0;

  // Bounded concurrency: a 100-file site should not open 100 sockets at once,
  // and should not check them one at a time either.
  const CONCURRENCY = 8;
  for (let i = 0; i < hashes.length; i += CONCURRENCY) {
    const batch = hashes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (hash) => {
      const key = storageKeyFor(body.siteId, hash);
      const slash = key.lastIndexOf('/');
      const { data, error } = await db.storage
        .from(BLOB_BUCKET)
        .list(key.slice(0, slash), { search: key.slice(slash + 1), limit: 1 });
      if (error || !data || data.length === 0) return { hash, size: 0, present: false };
      const size = (data[0]?.metadata as { size?: number } | null)?.size ?? 0;
      return { hash, size, present: true };
    }));
    for (const result of results) {
      if (!result.present) missing.push(result.hash);
      else totalBytes += result.size;
    }
  }

  if (missing.length > 0) {
    return json({
      error: {
        code: 'UPLOAD_INCOMPLETE',
        message: `${missing.length} file(s) did not finish uploading. Try publishing again.`,
      },
      missing,
    }, 409);
  }

  // --- Commit --------------------------------------------------------------
  const { data: versionRows, error: commitError } = await db.rpc('hosting_commit_version', {
    p_site_id: body.siteId,
    p_manifest: body.manifest,
    p_file_count: entries.length,
    p_total_bytes: totalBytes,
    p_created_by: caller.userId,
  });
  if (commitError) return fail(500, 'INTERNAL', commitError.message);
  const version = Array.isArray(versionRows) ? versionRows[0] : versionRows;

  const { data: fresh } = await db
    .from('sites')
    .select('*')
    .eq('id', body.siteId)
    .maybeSingle();

  return json({
    site: fresh,
    version,
    url: fresh?.slug ? `https://${fresh.slug}.${env.sitesDomain}` : null,
  });
});
