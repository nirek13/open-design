import { describe, expect, it } from 'vitest';

import {
  isOpaqueUserId,
  isPlaceholderPersonName,
  personLabel,
  workspaceLabel,
} from '../src/api/organizations';

describe('personLabel', () => {
  it('never presents a Clerk user id as a name', () => {
    expect(isOpaqueUserId('user_3lI4Uuw7AKpshQHVCfaKmWRKv6W')).toBe(true);
    expect(
      personLabel({
        displayName: 'user_3lI4Uuw7AKpshQHVCfaKmWRKv6W',
        username: 'nirek',
        email: 'nirek@co.com',
      }),
    ).toBe('nirek');
    expect(personLabel({ displayName: 'user_abc123' }, 'Someone')).toBe('Someone');
    expect(personLabel({ displayName: 'Ada Lovelace' })).toBe('Ada Lovelace');
    expect(personLabel({ displayName: 'ada@co.com' })).toBe('ada');
  });

  it('prefers a username over a generic Member placeholder', () => {
    expect(
      personLabel({
        displayName: 'Member',
        username: 'nirek',
        email: 'nirek@co.com',
      }),
    ).toBe('nirek');
    expect(personLabel({ displayName: 'Someone', username: 'ada' })).toBe('ada');
    expect(isPlaceholderPersonName('Member')).toBe(true);
    expect(isPlaceholderPersonName('Local Owner')).toBe(false);
  });
});

describe('workspaceLabel', () => {
  it('hides personal-org names generated from a Clerk user id', () => {
    expect(workspaceLabel("user_3lI4Uuw7AKpshQHVCfaKmWRKv6W's Organization", 'Workspace')).toBe(
      'Workspace',
    );
    expect(workspaceLabel('Northwind')).toBe('Northwind');
  });
});
