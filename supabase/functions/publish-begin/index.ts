// Step 1 of publishing: authorize, claim the slug, and hand back upload URLs.
//
// The response contains a signed upload URL for each blob the server does not
// already have. Everything the client already uploaded in a previous publish is
// omitted, which is what makes republishing a large site nearly free.

import {
  MAX_FILES_PER_SITE,
  MAX_PUBLISHES_PER_HOUR,
  MAX_TOTAL_BYTES,
  buildManifest,
  missingBlobs,
  storageKeyFor,
  suggestSlug,
  validateSlug,
  type ManifestInput,
} from '../../../packages/hosting/src/index.ts';
import { BLOB_BUCKET, serviceClient } from '../_shared/env.ts';
import { authenticate, fail, json, preflight, readJson } from '../_shared/http.ts';

interface BeginRequest {
  slug?: string;
  visibility?: 'public' | 'org';
  projectId?: string;
  entryFile: string;
  files: ManifestInput[];
  /** Short disambiguator for the suggested slug; supplied by the client so
   * this function stays deterministic. */
  slugSuffix?: string;
  /** Fallback name for slug suggestion on a first publish. */
  projectName?: string;
}

Deno.serve(async (request) => {
  const cors = preflight(request);
  if (cors) return cors;
  if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');

  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  const { env, caller } = auth.context;
  const db = serviceClient(env);

  const body = await readJson<BeginRequest>(request);
  if (!body || !Array.isArray(body.files) || typeof body.entryFile !== 'string') {
    return fail(400, 'BAD_REQUEST', 'entryFile and files are required');
  }

  // --- Rate limit ----------------------------------------------------------
  const { data: recent, error: rateError } = await db
    .rpc('hosting_publishes_last_hour', { p_user_id: caller.userId });
  if (rateError) return fail(500, 'INTERNAL', rateError.message);
  if (typeof recent === 'number' && recent >= MAX_PUBLISHES_PER_HOUR) {
    return fail(429, 'RATE_LIMITED', `You have published ${recent} times in the last hour. Try again later.`);
  }

  // --- Visibility ----------------------------------------------------------
  const visibility = body.visibility === 'org' ? 'org' : 'public';
  if (visibility === 'org' && !caller.orgId) {
    // Accepting this would promise an access control that has nothing to
    // enforce it: with no organization on the token, `serve` would have no
    // claim to compare a visitor against.
    return fail(400, 'ORG_REQUIRED', 'Select an organization before publishing an org-restricted site.');
  }

  // --- Manifest ------------------------------------------------------------
  const built = buildManifest(body.files);
  if (built.violations.length > 0) {
    return json({
      error: { code: 'LIMIT_EXCEEDED', message: 'This site is too large to publish.' },
      violations: built.violations,
    }, 413);
  }
  if (built.fileCount === 0) return fail(400, 'EMPTY_SITE', 'There is nothing to publish.');
  if (built.fileCount > MAX_FILES_PER_SITE || built.totalBytes > MAX_TOTAL_BYTES) {
    return fail(413, 'LIMIT_EXCEEDED', 'This site is too large to publish.');
  }

  const entryFile = body.entryFile.replace(/^\/+/, '');
  if (!built.manifest[entryFile]) {
    return fail(400, 'MISSING_ENTRY', `The entry file ${entryFile} is not among the uploaded files.`);
  }

  // --- Slug ----------------------------------------------------------------
  const requested = typeof body.slug === 'string' && body.slug.trim()
    ? body.slug.trim().toLowerCase()
    : suggestSlug(body.projectName ?? 'site', body.slugSuffix ?? '');
  const slugCheck = validateSlug(requested);
  if (!slugCheck.ok) return fail(400, 'INVALID_SLUG', slugCheck.message);

  // --- Claim ---------------------------------------------------------------
  const { data: siteRows, error: claimError } = await db.rpc('hosting_claim_site', {
    p_slug: slugCheck.slug,
    p_owner: caller.userId,
    p_org_id: visibility === 'org' ? caller.orgId : null,
    p_visibility: visibility,
    p_project_id: body.projectId ?? null,
    p_entry_file: entryFile,
  });
  if (claimError) {
    if (claimError.code === '23505') {
      return fail(409, 'SLUG_TAKEN', `${slugCheck.slug} is already taken. Choose another name.`);
    }
    if (claimError.code === '42501') {
      return fail(403, 'SITE_SUSPENDED', 'This site has been suspended.');
    }
    return fail(500, 'INTERNAL', claimError.message);
  }
  const site = Array.isArray(siteRows) ? siteRows[0] : siteRows;
  if (!site?.id) return fail(500, 'INTERNAL', 'could not claim site');

  // --- Blob diff -----------------------------------------------------------
  const { data: known, error: blobError } = await db
    .from('site_blobs')
    .select('hash')
    .eq('site_id', site.id);
  if (blobError) return fail(500, 'INTERNAL', blobError.message);

  const needed = missingBlobs(built.manifest, (known ?? []).map((row) => row.hash as string));

  // --- Signed uploads ------------------------------------------------------
  const uploads: Array<{ hash: string; path: string; token: string }> = [];
  for (const hash of needed) {
    const key = storageKeyFor(site.id, hash);
    const { data, error } = await db.storage.from(BLOB_BUCKET).createSignedUploadUrl(key, {
      upsert: true,
    });
    if (error) return fail(500, 'INTERNAL', error.message);
    uploads.push({ hash, path: key, token: data.token });
  }

  return json({
    siteId: site.id,
    slug: site.slug,
    visibility: site.visibility,
    bucket: BLOB_BUCKET,
    entryFile,
    manifest: built.manifest,
    fileCount: built.fileCount,
    totalBytes: built.totalBytes,
    uploads,
    // Blobs already stored, so the client can report accurate progress rather
    // than showing "0 of 40" for a republish that only changed one file.
    skipped: built.fileCount - needed.length,
  });
});
