/** Clerk's Frontend API only accepts http(s) redirect_url values.
 *
 * Packaged desktop loads the SPA at `od://app/`. Passing that origin to
 * Clerk produces `invalid_url_scheme`. Map those windows onto the sidecar's
 * HTTP origin for Clerk, then keep the Electron window on `od://` via the
 * Clerk router hooks in ClerkSession.
 */

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export function isHttpLocation(location: Pick<Location, 'protocol'>): boolean {
  return HTTP_PROTOCOLS.has(location.protocol);
}

export function clerkHttpOrigin(appOrigin: string | undefined): string | null {
  const trimmed = appOrigin?.trim().replace(/\/+$/, '') ?? '';
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!HTTP_PROTOCOLS.has(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Clerk handshake query keys must never become the post-sign-in destination.
 * OAuth returns to `/?__clerk_handshake=…` (or the join path with those
 * params). Feeding that back as `redirect_url` drops the invite and can loop. */
export function locationForClerkRedirect(
  location: Pick<Location, 'protocol' | 'pathname' | 'search'>,
  pendingJoinPath?: string | null,
): Pick<Location, 'protocol' | 'pathname' | 'search'> {
  if (pendingJoinPath) {
    return { protocol: location.protocol, pathname: pendingJoinPath, search: '' };
  }
  const params = new URLSearchParams(
    location.search.startsWith('?') ? location.search.slice(1) : location.search,
  );
  for (const key of [...params.keys()]) {
    if (key.startsWith('__clerk_') || key === 'rotating_token_nonce') params.delete(key);
  }
  const query = params.toString();
  return {
    protocol: location.protocol,
    pathname: location.pathname || '/',
    search: query ? `?${query}` : '',
  };
}

export function clerkRedirectUrl(
  location: Pick<Location, 'protocol' | 'pathname' | 'search'>,
  appOrigin?: string,
  pendingJoinPath?: string | null,
): string {
  const clean = locationForClerkRedirect(location, pendingJoinPath);
  const path = `${clean.pathname}${clean.search}` || '/';
  if (isHttpLocation(clean)) return path;
  const origin = clerkHttpOrigin(appOrigin) ?? 'http://127.0.0.1';
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** After Clerk signs in, stay on the packaged `od://` window instead of
 * navigating the BrowserWindow to the loopback HTTP origin. */
export function stayOnPackagedApp(to: string, location: Pick<Location, 'protocol' | 'href'>): void {
  if (typeof window === 'undefined') return;
  if (isHttpLocation(location)) {
    window.history.pushState(null, '', to);
    return;
  }
  try {
    const target = new URL(to, location.href);
    if (HTTP_PROTOCOLS.has(target.protocol)) {
      window.history.replaceState(null, '', `${target.pathname}${target.search}${target.hash}` || '/');
      return;
    }
  } catch {
    // Relative Clerk routes (`/`, `/onboarding`) stay on this origin.
  }
  window.history.pushState(null, '', to);
}
