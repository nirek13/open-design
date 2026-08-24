import { describe, expect, it } from 'vitest';

import {
  parseUsername,
  RESERVED_USERNAMES,
  USERNAME_MAX_LENGTH,
  usernameParseMessage,
} from '../src/api/username';

describe('parseUsername', () => {
  it('normalizes a public handle to lowercase and strips a leading @', () => {
    expect(parseUsername('Jane')).toEqual({ ok: true, username: 'jane' });
    expect(parseUsername('@Jane.Doe')).toEqual({ ok: true, username: 'jane.doe' });
    expect(parseUsername('jane_doe')).toEqual({ ok: true, username: 'jane_doe' });
    expect(parseUsername('local-owner')).toEqual({ ok: true, username: 'local-owner' });
  });

  it('rejects empty, short, long, reserved, and malformed handles', () => {
    expect(parseUsername('')).toEqual({ ok: false, error: 'empty' });
    expect(parseUsername('a')).toEqual({ ok: false, error: 'too-short' });
    expect(parseUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toEqual({ ok: false, error: 'too-long' });
    expect(parseUsername('me')).toEqual({ ok: false, error: 'reserved' });
    expect(parseUsername('Jane Doe')).toEqual({ ok: false, error: 'invalid' });
    expect(RESERVED_USERNAMES.has('me')).toBe(true);
    expect(usernameParseMessage('reserved')).toMatch(/reserved/i);
  });
});
