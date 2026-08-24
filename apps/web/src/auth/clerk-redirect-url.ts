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

export function clerkRedirectUrl(
  location: Pick<Location, 'protocol' | 'pathname' | 'search'>,
  appOrigin?: string,
): string {
  const path = `${location.pathname}${location.search}` || '/';
  if (isHttpLocation(location)) return path;
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
