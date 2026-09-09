import { describe, expect, it } from 'vitest';
import type { ChatChannel, ChatCustomEmoji, ChatUserGroup, OrgMember } from '@open-design/contracts';

import {
  applyChatSuggestion,
  chatSuggestions,
  readChatAutocomplete,
} from '../../src/runtime/chat-autocomplete';

const person = (id: string, username: string, displayName: string): OrgMember =>
  ({
    id,
    userId: `usr-${id}`,
    orgId: 'org-1',
    role: 'member',
    status: 'active',
    username,
    displayName,
    email: `${username}@example.com`,
    avatarUrl: null,
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as OrgMember;

const channel = (slug: string, joined = true): ChatChannel =>
  ({
    id: `chn-${slug}`,
    orgId: 'org-1',
    slug,
    displayName: slug,
    topic: null,
    purpose: null,
    kind: 'channel',
    visibility: 'public',
    postPolicy: 'everyone',
    archivedAt: null,
    createdBy: 'wsm-a',
    createdAt: 0,
    updatedAt: 0,
    memberCount: 1,
    messageCount: 0,
    unreadCount: 0,
    mentionCount: 0,
    joined,
    lastMessageAt: null,
    starred: false,
    muted: false,
    notify: 'all',
    huddleActive: false,
    retentionDays: null,
    sectionId: null,
  }) as ChatChannel;

const group = (handle: string): ChatUserGroup => ({
  id: `grp-${handle}`,
  orgId: 'org-1',
  handle,
  name: handle,
  description: null,
  memberIds: ['wsm-a', 'wsm-b'],
  createdBy: 'wsm-a',
  createdAt: 0,
  updatedAt: 0,
});

const customEmoji: ChatCustomEmoji = {
  name: 'shipit',
  orgId: 'org-1',
  url: '/file-1',
  aliasFor: null,
  createdBy: 'wsm-a',
  createdAt: 0,
};

const sources = {
  people: [person('wsm-a', 'ada', 'Ada Lovelace'), person('wsm-b', 'ravi', 'Ravi Patel')],
  groups: [group('design')],
  channels: [channel('deals-emea'), channel('random', false)],
  customEmoji: [customEmoji],
  selfMemberId: 'wsm-a',
};

describe('readChatAutocomplete', () => {
  it('reads a token at the start of the message', () => {
    expect(readChatAutocomplete('@ad', 3)).toMatchObject({ trigger: '@', term: 'ad', start: 0, end: 3 });
  });

  it('reads a token after whitespace or an opening bracket', () => {
    expect(readChatAutocomplete('hello @ad', 9)?.term).toBe('ad');
    expect(readChatAutocomplete('(#dea', 5)?.term).toBe('dea');
  });

  it('does not fire mid-word', () => {
    // Without this, `ada@example.com` opens the people menu and `note:this`
    // opens the emoji menu — both worse than offering nothing.
    expect(readChatAutocomplete('ada@example', 11)).toBeNull();
    expect(readChatAutocomplete('note:this', 9)).toBeNull();
  });

  it('waits for two characters before offering emoji', () => {
    expect(readChatAutocomplete('a :s', 4)).toBeNull();
    expect(readChatAutocomplete('a :sh', 5)?.trigger).toBe(':');
  });

  it('treats a slash as a command only at the very start', () => {
    expect(readChatAutocomplete('/rem', 4)).toMatchObject({ trigger: '/', term: 'rem' });
    expect(readChatAutocomplete('see /rem', 8)).toBeNull();
  });

  it('ignores a token the caret has moved past', () => {
    expect(readChatAutocomplete('@ada and more', 13)).toBeNull();
  });
});

describe('chatSuggestions', () => {
  it('offers people, groups, and the special mentions for @', () => {
    const query = readChatAutocomplete('@d', 2)!;
    const kinds = chatSuggestions(query, sources).map((row) => row.kind);
    expect(kinds).toContain('group');
    expect(chatSuggestions(query, sources).some((row) => row.label === '@design')).toBe(true);

    const all = chatSuggestions(readChatAutocomplete('@', 1)!, sources);
    expect(all.some((row) => row.label === '@channel')).toBe(true);
  });

  it('never offers to mention yourself', () => {
    const suggestions = chatSuggestions(readChatAutocomplete('@ada', 4)!, sources);
    expect(suggestions.some((row) => row.id === 'wsm-a')).toBe(false);
  });

  it('ranks a joined channel above one you are not in', () => {
    const suggestions = chatSuggestions(readChatAutocomplete('#', 1)!, sources);
    expect(suggestions[0]?.label).toBe('#deals-emea');
  });

  it('puts the organization own emoji ahead of the stock set', () => {
    const suggestions = chatSuggestions(readChatAutocomplete(':shi', 4)!, sources);
    expect(suggestions[0]?.label).toBe(':shipit:');
    expect(suggestions[0]?.iconUrl).toBe('/file-1');
  });

  it('offers commands for a leading slash', () => {
    const suggestions = chatSuggestions(readChatAutocomplete('/rem', 4)!, sources);
    expect(suggestions.some((row) => row.label === '/remind')).toBe(true);
  });
});

describe('applyChatSuggestion', () => {
  it('replaces the token and leaves the caret after it', () => {
    const text = 'hello @ra world';
    const query = readChatAutocomplete('hello @ra', 9)!;
    const suggestion = chatSuggestions(query, sources).find((row) => row.label === '@ravi')!;
    const next = applyChatSuggestion(text, query, suggestion);
    expect(next.text).toBe('hello @ravi  world');
    expect(next.text.slice(0, next.caret)).toBe('hello @ravi ');
  });

  it('keeps everything after the caret intact', () => {
    const text = '#dea and the rest';
    const query = readChatAutocomplete('#dea', 4)!;
    const suggestion = chatSuggestions(query, sources)[0]!;
    expect(applyChatSuggestion(text, query, suggestion).text).toBe('#deals-emea  and the rest');
  });
});
