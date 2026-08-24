// Public username: the unique alias people use to @mention, invite, and
// send things to each other. The directory user id stays the stable
// identifier; this handle is the human-facing name for that id.

export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 32;

/** GitHub-style handle: start and end alphanumeric; `.` `_` `-` allowed in
 * the middle. Stored lowercase. */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'me',
  'org',
  'orgs',
  'admin',
  'owner',
  'system',
  'everyone',
  'here',
  'api',
  'users',
  'user',
  'settings',
  'help',
  'about',
  'login',
  'signup',
  'daemon',
  'root',
  'null',
  'undefined',
  'you',
  'all',
]);

export type UsernameParseError = 'empty' | 'too-short' | 'too-long' | 'invalid' | 'reserved';

export function normalizeUsernameInput(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function parseUsername(
  raw: string,
): { ok: true; username: string } | { ok: false; error: UsernameParseError } {
  const username = normalizeUsernameInput(raw);
  if (!username) return { ok: false, error: 'empty' };
  if (username.length < USERNAME_MIN_LENGTH) return { ok: false, error: 'too-short' };
  if (username.length > USERNAME_MAX_LENGTH) return { ok: false, error: 'too-long' };
  if (!USERNAME_PATTERN.test(username)) return { ok: false, error: 'invalid' };
  if (RESERVED_USERNAMES.has(username)) return { ok: false, error: 'reserved' };
  return { ok: true, username };
}

export function usernameParseMessage(error: UsernameParseError): string {
  switch (error) {
    case 'empty':
      return 'username is required';
    case 'too-short':
      return `username must be at least ${USERNAME_MIN_LENGTH} characters`;
    case 'too-long':
      return `username must be at most ${USERNAME_MAX_LENGTH} characters`;
    case 'reserved':
      return 'that username is reserved';
    case 'invalid':
      return 'username must start and end with a letter or number, and may contain . _ -';
  }
}

export const DISPLAY_NAME_MAX_LENGTH = 80;
export const BIO_MAX_LENGTH = 280;

export interface UpdateProfileRequest {
  username?: string;
  displayName?: string;
  bio?: string;
}

export interface ProfileResponse {
  userId: string;
  displayName: string;
  email: string | null;
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

export interface PublicUserProfile {
  userId: string;
  displayName: string;
  username: string;
  bio: string | null;
  avatarUrl: string | null;
}
