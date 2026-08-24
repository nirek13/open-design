// Attaching the session to every API call — and to browser navigations.
//
// The app makes API calls from hundreds of places, written long before there
// was such a thing as a session. Rather than thread a token through all of
// them — which would be a large, error-prone diff where one missed call site
// is a silent 401 — the session is attached once, here, by wrapping fetch
// and planting a same-origin cookie. Iframe `src`, `<img>`, and CSS/font
// requests cannot set `Authorization`, so the cookie is how those loads
// authenticate against `/api/projects/:id/raw/*` and siblings.
//
// This wrapper is installed only when the daemon reports clerk mode. In
// local-owner mode nothing is patched at all, so the zero-config local loop
// and every existing test run against untouched globals.

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider | null = null;
let installed = false;

/** Same-origin cookie so iframe/img/font navigations can authenticate.
 * Must stay in lockstep with `SESSION_COOKIE_NAME` in the daemon identity module. */
export const SESSION_COOKIE_NAME = 'od_session';

/** Plant or clear the session cookie the daemon reads for non-fetch loads. */
export function plantSessionCookie(
  token: string | null,
  loc: Pick<Location, 'protocol'> = window.location,
): void {
  if (typeof document === 'undefined') return;
  if (!token) {
    document.cookie = `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
    return;
  }
  const secure = loc.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/${secure}; SameSite=Lax`;
}

/** Registered by the auth gate once Clerk has a session. */
export function setSessionTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

/** Same-origin API calls only.
 *
 * A token must never ride along to a third-party host: `fetch('https://…')`
 * from a generated tool would otherwise hand that host a live credential. */
export function shouldAttachSessionToken(url: string, origin = window.location.href): boolean {
  try {
    const resolved = new URL(url, origin);
    const originUrl = new URL(origin);
    if (resolved.origin !== originUrl.origin) return false;
    return resolved.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Wrap global fetch so same-origin API calls carry the session. Idempotent. */
export function installSessionFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = window.fetch.bind(window);

  window.fetch = async function sessionFetch(input: RequestInfo | URL, init?: RequestInit) {
    if (!tokenProvider || !shouldAttachSessionToken(urlOf(input))) return original(input, init);

    let token: string | null = null;
    try {
      token = await tokenProvider();
    } catch {
      // A token we cannot mint is the same as no token: let the request go and
      // let the daemon answer 401, rather than failing here with a different
      // shape of error the callers do not expect.
      token = null;
    }
    if (!token) return original(input, init);

    plantSessionCookie(token);

    // Never overwrite an Authorization header a caller set deliberately.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return original(input, { ...init, headers });
  };
}
