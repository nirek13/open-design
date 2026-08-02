// The public request path: `https://<slug>.<sites-domain>/<anything>`.
//
// This is the only function an anonymous visitor ever reaches, and the only
// place a hosted site's bytes leave storage. Three things have to be true on
// every request:
//
//   1. The publisher's machine is not involved. Everything here reads from
//      Postgres and Storage, so a link keeps working after the laptop closes.
//   2. An org-restricted site is invisible to a non-member — including the
//      fact that it exists. Every such response is a 404, never a 403.
//   3. The path resolves exactly as it does everywhere else, because the
//      resolver is imported from `packages/hosting` rather than reimplemented.

import {
  cacheControlFor,
  etagFor,
  injectHandoff,
  isHtmlPath,
  resolvePath,
  siteSecurityHeaders,
  storageKeyFor,
  type SiteManifest,
} from '../../../packages/hosting/src/index.ts';
import { BLOB_BUCKET, readEnv, serviceClient, type HostingEnv } from '../_shared/env.ts';
import { bearerFrom, callerFrom, verifyClerkToken } from '../_shared/jwt.ts';

interface LiveSite {
  site_id: string;
  slug: string;
  visibility: 'public' | 'org';
  status: string;
  org_id: string | null;
  entry_file: string;
  version_id: string;
  version_number: number;
  manifest: SiteManifest;
}

/**
 * Which site is being asked for.
 *
 * Production routes by wildcard subdomain. The query-parameter form exists for
 * local development and for calling the function directly by its Supabase URL,
 * where there is no site subdomain to read.
 */
function slugFrom(request: Request, env: HostingEnv): string | null {
  const url = new URL(request.url);
  const host = (request.headers.get('x-forwarded-host') ?? url.hostname).toLowerCase();
  const suffix = `.${env.sitesDomain}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    // Only a single label is a site. `a.b.od-sites.dev` is not `a`.
    if (label && !label.includes('.')) return label;
  }
  const explicit = url.searchParams.get('__od_slug');
  return explicit ? explicit.toLowerCase() : null;
}

/** The path the visitor asked for, with the function's own route prefix removed. */
function requestPath(request: Request): string {
  const url = new URL(request.url);
  return url.pathname.replace(/^\/functions\/v1\/serve/, '') || '/';
}

function notFound(env: HostingEnv): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...siteSecurityHeaders({ frameAncestors: env.frameAncestors }) },
  });
}

Deno.serve(async (request) => {
  let env: HostingEnv;
  try {
    env = readEnv();
  } catch {
    return new Response('Hosting is not configured', { status: 500 });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const slug = slugFrom(request, env);
  if (!slug) return notFound(env);

  const db = serviceClient(env);
  const { data, error } = await db.rpc('hosting_resolve_live', { p_slug: slug });
  if (error) return new Response('Temporarily unavailable', { status: 503 });

  const live = (Array.isArray(data) ? data[0] : data) as LiveSite | undefined;
  if (!live) return notFound(env);

  // --- Visibility ----------------------------------------------------------
  if (live.visibility === 'org') {
    const authorized = await callerIsMember(request, env, live.org_id);
    // 404, not 403. A 403 confirms that an internal tool with this name
    // exists, which is exactly what an org-restricted site must not leak.
    if (!authorized) return notFound(env);
  }

  // --- Resolve -------------------------------------------------------------
  const accept = request.headers.get('accept') ?? '';
  const resolution = resolvePath(live.manifest, requestPath(request), {
    entryFile: live.entry_file,
    acceptsHtml: accept.includes('text/html') || accept.includes('*/*') || accept === '',
  });
  if (resolution.kind === 'not-found') return notFound(env);

  if (resolution.redirectTo) {
    return new Response(null, {
      status: 308,
      headers: { location: resolution.redirectTo, ...siteSecurityHeaders({ frameAncestors: env.frameAncestors }) },
    });
  }

  // --- Conditional request -------------------------------------------------
  const etag = etagFor(resolution.entry);
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': cacheControlFor(resolution) },
    });
  }

  // --- Body ----------------------------------------------------------------
  const key = storageKeyFor(live.site_id, resolution.entry.hash);
  const { data: blob, error: blobError } = await db.storage.from(BLOB_BUCKET).download(key);
  if (blobError || !blob) {
    // The manifest references a blob that is gone. `publish-commit` verifies
    // presence before going live, so this means storage lost an object rather
    // than the publish being incomplete — a server fault, not a missing page.
    return new Response('Temporarily unavailable', { status: 503 });
  }

  const headers = new Headers({
    'content-type': resolution.entry.contentType,
    'cache-control': cacheControlFor(resolution),
    etag,
    ...siteSecurityHeaders({ frameAncestors: env.frameAncestors }),
  });

  if (request.method === 'HEAD') {
    headers.set('content-length', String(resolution.entry.size));
    return new Response(null, { status: 200, headers });
  }

  // HTML documents get the app-handoff snippet. Everything else streams
  // through untouched — rewriting a binary would corrupt it, and buffering a
  // large asset to search for a `</body>` would waste memory on every image.
  if (isHtmlPath(resolution.path)) {
    const html = injectHandoff(await blob.text(), {
      slug: live.slug,
      versionId: live.version_id,
    });
    return new Response(html, { status: 200, headers });
  }

  return new Response(blob.stream(), { status: 200, headers });
});

/**
 * Is the caller a member of the organization that owns this site?
 *
 * Answered entirely from the Clerk token's active-organization claim. Nothing
 * about membership is mirrored into Postgres, so revoking someone in Clerk
 * takes effect on their very next request with no sync job that could go
 * stale — which is the property that made the org tier safe to host at all.
 */
async function callerIsMember(
  request: Request,
  env: HostingEnv,
  orgId: string | null,
): Promise<boolean> {
  if (!orgId) return false;

  // A browser navigation cannot set an Authorization header, so the session
  // token is also accepted from the Clerk cookie that the product's sign-in
  // sets on the parent domain.
  const token = bearerFrom(request) ?? clerkCookie(request);
  if (!token) return false;

  const verified = await verifyClerkToken(token, env.clerkIssuer);
  if (!verified.ok) return false;
  return callerFrom(verified.claims).orgId === orgId;
}

function clerkCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__session') return rest.join('=') || null;
  }
  return null;
}
