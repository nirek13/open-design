// Management API for published sites: list, inspect, rename, change
// visibility, roll back, unpublish, and report abuse.
//
// Routed by path suffix under a single function so the whole surface deploys
// and versions as one unit:
//
//   GET    /sites-manage                       list the caller's sites
//   GET    /sites-manage/slug-available?slug=  check a name
//   GET    /sites-manage/:id                   one site
//   GET    /sites-manage/:id/versions          version history
//   PATCH  /sites-manage/:id                   { slug?, visibility? }
//   POST   /sites-manage/:id/rollback          { versionId }
//   POST   /sites-manage/:id/unpublish
//   POST   /sites-manage/report                { slug, reason, details? }

import { suggestSlug, validateSlug } from '../../../packages/hosting/src/index.ts';
import { serviceClient } from '../_shared/env.ts';
import { authenticate, fail, json, preflight, readJson } from '../_shared/http.ts';

function segments(url: URL): string[] {
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.indexOf('sites-manage');
  return index === -1 ? [] : parts.slice(index + 1);
}

Deno.serve(async (request) => {
  const cors = preflight(request);
  if (cors) return cors;

  const url = new URL(request.url);
  const path = segments(url);

  // Abuse reporting is intentionally the one unauthenticated route: requiring
  // an account to report a phishing page suppresses the reports that matter.
  if (request.method === 'POST' && path[0] === 'report') {
    return handleReport(request);
  }

  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  const { env, caller } = auth.context;
  const db = serviceClient(env);
  const siteUrl = (slug: string) => `https://${slug}.${env.sitesDomain}`;

  /** Load a site the caller owns, or the response explaining why not. */
  async function owned(siteId: string) {
    const { data, error } = await db.from('sites').select('*').eq('id', siteId).maybeSingle();
    if (error) return { error: fail(500, 'INTERNAL', error.message) } as const;
    // 404 for both "absent" and "someone else's": a 403 confirms existence.
    if (!data || data.owner_user_id !== caller.userId) {
      return { error: fail(404, 'NOT_FOUND', 'site not found') } as const;
    }
    return { site: data } as const;
  }

  // --- GET /slug-available -------------------------------------------------
  if (request.method === 'GET' && path[0] === 'slug-available') {
    const requested = (url.searchParams.get('slug') ?? '').trim().toLowerCase();
    const check = validateSlug(requested);
    if (!check.ok) {
      return json({
        slug: requested,
        available: false,
        reason: check.message,
        suggestion: suggestSlug(requested || 'site', url.searchParams.get('suffix') ?? ''),
      });
    }
    const { data, error } = await db
      .from('sites')
      .select('id, owner_user_id')
      .eq('slug', check.slug)
      .maybeSingle();
    if (error) return fail(500, 'INTERNAL', error.message);
    // The caller's own slug counts as available — that is a republish.
    const available = !data || data.owner_user_id === caller.userId;
    return json({
      slug: check.slug,
      available,
      reason: available ? null : 'That name is already taken.',
      suggestion: available ? null : suggestSlug(check.slug, url.searchParams.get('suffix') ?? ''),
    });
  }

  // --- GET / (list) --------------------------------------------------------
  if (request.method === 'GET' && path.length === 0) {
    const { data, error } = await db
      .from('sites')
      .select('*, site_versions!sites_live_version_fk (version_number)')
      .eq('owner_user_id', caller.userId)
      .order('updated_at', { ascending: false });
    if (error) return fail(500, 'INTERNAL', error.message);
    return json({ sites: (data ?? []).map((row) => ({ ...row, url: siteUrl(row.slug) })) });
  }

  const siteId = path[0];
  if (!siteId) return fail(404, 'NOT_FOUND', 'unknown route');

  // --- GET /:id/versions ---------------------------------------------------
  if (request.method === 'GET' && path[1] === 'versions') {
    const found = await owned(siteId);
    if ('error' in found) return found.error;
    const { data, error } = await db
      .from('site_versions')
      .select('id, site_id, version_number, file_count, total_bytes, created_by, created_at')
      .eq('site_id', siteId)
      .order('version_number', { ascending: false });
    if (error) return fail(500, 'INTERNAL', error.message);
    return json({
      versions: (data ?? []).map((row) => ({
        ...row,
        isLive: row.id === found.site.live_version_id,
      })),
    });
  }

  // --- GET /:id ------------------------------------------------------------
  if (request.method === 'GET' && path.length === 1) {
    const found = await owned(siteId);
    if ('error' in found) return found.error;
    return json({ site: { ...found.site, url: siteUrl(found.site.slug) } });
  }

  // --- PATCH /:id ----------------------------------------------------------
  if (request.method === 'PATCH' && path.length === 1) {
    const found = await owned(siteId);
    if ('error' in found) return found.error;
    const body = await readJson<{ slug?: string; visibility?: 'public' | 'org' }>(request);
    if (!body) return fail(400, 'BAD_REQUEST', 'invalid body');

    const patch: Record<string, unknown> = {};

    if (typeof body.slug === 'string') {
      const check = validateSlug(body.slug.trim().toLowerCase());
      if (!check.ok) return fail(400, 'INVALID_SLUG', check.message);
      patch.slug = check.slug;
    }

    if (body.visibility) {
      if (body.visibility !== 'public' && body.visibility !== 'org') {
        return fail(400, 'BAD_REQUEST', 'visibility must be public or org');
      }
      if (body.visibility === 'org' && !caller.orgId) {
        return fail(400, 'ORG_REQUIRED', 'Select an organization first.');
      }
      patch.visibility = body.visibility;
      // Keep org_id consistent with visibility in the same write. Leaving a
      // stale org_id on a site switched to public would be harmless today but
      // is exactly the drift that later makes an access check ambiguous.
      patch.org_id = body.visibility === 'org' ? caller.orgId : null;
    }

    if (Object.keys(patch).length === 0) {
      return json({ site: { ...found.site, url: siteUrl(found.site.slug) } });
    }

    const { data, error } = await db
      .from('sites').update(patch).eq('id', siteId).select('*').maybeSingle();
    if (error) {
      if (error.code === '23505') return fail(409, 'SLUG_TAKEN', 'That name is already taken.');
      return fail(500, 'INTERNAL', error.message);
    }
    return json({ site: { ...data, url: siteUrl(data!.slug) } });
  }

  // --- POST /:id/rollback --------------------------------------------------
  if (request.method === 'POST' && path[1] === 'rollback') {
    const found = await owned(siteId);
    if ('error' in found) return found.error;
    const body = await readJson<{ versionId?: string }>(request);
    if (!body?.versionId) return fail(400, 'BAD_REQUEST', 'versionId is required');

    const { data, error } = await db.rpc('hosting_rollback_site', {
      p_site_id: siteId,
      p_version_id: body.versionId,
    });
    if (error) {
      if (error.code === '22023') return fail(400, 'BAD_REQUEST', 'That version belongs to another site.');
      return fail(500, 'INTERNAL', error.message);
    }
    const site = Array.isArray(data) ? data[0] : data;
    return json({ site: { ...site, url: siteUrl(site.slug) } });
  }

  // --- POST /:id/unpublish -------------------------------------------------
  if (request.method === 'POST' && path[1] === 'unpublish') {
    const found = await owned(siteId);
    if ('error' in found) return found.error;
    // The row survives so the slug stays reserved to this owner and a later
    // republish restores the same address rather than handing it to whoever
    // claims it first.
    const { data, error } = await db
      .from('sites').update({ status: 'unpublished' }).eq('id', siteId).select('*').maybeSingle();
    if (error) return fail(500, 'INTERNAL', error.message);
    return json({ site: { ...data, url: siteUrl(data!.slug) } });
  }

  return fail(404, 'NOT_FOUND', 'unknown route');
});

async function handleReport(request: Request): Promise<Response> {
  const { readEnv } = await import('../_shared/env.ts');
  let env;
  try {
    env = readEnv();
  } catch (error) {
    return fail(500, 'MISCONFIGURED', error instanceof Error ? error.message : 'configuration error');
  }
  const db = serviceClient(env);

  const body = await readJson<{ slug?: string; reason?: string; details?: string }>(request);
  if (!body?.slug || !body.reason) {
    return fail(400, 'BAD_REQUEST', 'slug and reason are required');
  }

  const { data: site } = await db
    .from('sites').select('id').eq('slug', body.slug.toLowerCase()).maybeSingle();

  const { error } = await db.from('abuse_reports').insert({
    site_id: site?.id ?? null,
    reported_slug: body.slug.toLowerCase(),
    reason: String(body.reason).slice(0, 200),
    details: body.details ? String(body.details).slice(0, 4000) : null,
    reporter_id: null,
    status: 'open',
  });
  if (error) return fail(500, 'INTERNAL', error.message);

  // Deliberately does not reveal whether the slug exists.
  return json({ received: true });
}
