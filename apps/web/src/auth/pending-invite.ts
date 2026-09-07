// Invite links have to survive Clerk sign-in. OAuth often returns the browser
// to `/` (or to the same path with handshake query params), which would drop
// `/join/<token>` and make the link look broken. Stash the token for this tab
// the moment we see a join URL, then put the visitor back on it after the
// session exists.

const STORAGE_KEY = 'open-design:pending-invite:v1';

export function joinTokenFromPath(pathname: string): string | null {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'join' || !parts[1]) return null;
  try {
    const token = decodeURIComponent(parts[1]).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function joinPathForToken(token: string): string {
  return `/join/${encodeURIComponent(token)}`;
}

export function rememberPendingInvite(token: string): void {
  const trimmed = token.trim();
  if (!trimmed || typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // Private mode or a full quota must not break the join page itself.
  }
}

export function readPendingInvite(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const value = sessionStorage.getItem(STORAGE_KEY)?.trim() ?? '';
    return value || null;
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignoring storage failures is the same as having nothing to clear.
  }
}

/** Capture a `/join/<token>` landing (or a previously stashed token) so sign-in
 * can send the visitor back even if Clerk returns them to `/`. */
export function capturePendingInvite(pathname: string): string | null {
  const fromPath = joinTokenFromPath(pathname);
  if (fromPath) rememberPendingInvite(fromPath);
  return fromPath ?? readPendingInvite();
}
