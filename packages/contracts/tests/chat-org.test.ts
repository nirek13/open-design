import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHAT_DND,
  expandGroupMentions,
  isDurableChatEvent,
  isSuppressedByDnd,
  minutesInZone,
  normalizeEmojiName,
  resolveEmojiAlias,
  type ChatCustomEmoji,
  type ChatUserGroup,
} from '../src/index.js';

const emoji = (name: string, extra: Partial<ChatCustomEmoji> = {}): ChatCustomEmoji => ({
  name,
  orgId: 'org-1',
  url: null,
  aliasFor: null,
  createdBy: 'wsm-a',
  createdAt: 0,
  ...extra,
});

const group = (handle: string, memberIds: string[]): ChatUserGroup => ({
  id: `grp-${handle}`,
  orgId: 'org-1',
  handle,
  name: handle,
  description: null,
  memberIds,
  createdBy: 'wsm-a',
  createdAt: 0,
  updatedAt: 0,
});

describe('normalizeEmojiName', () => {
  it('strips the colons, lowercases, and joins words with underscores', () => {
    expect(normalizeEmojiName(':Ship It:')).toBe('ship_it');
    expect(normalizeEmojiName('  PARTY  ')).toBe('party');
    expect(normalizeEmojiName('::wave::')).toBe('wave');
  });

  it('drops characters a name cannot contain, without leaving them at the edges', () => {
    expect(normalizeEmojiName('hello!!')).toBe('hello');
    expect(normalizeEmojiName('a b/c')).toBe('a_b_c');
  });
});

describe('resolveEmojiAlias', () => {
  it('follows an alias to the row that owns the image', () => {
    const set = [emoji('shipit', { url: '/file-1' }), emoji('lgtm', { aliasFor: 'shipit' })];
    expect(resolveEmojiAlias('lgtm', set)?.url).toBe('/file-1');
    expect(resolveEmojiAlias(':lgtm:', set)?.url).toBe('/file-1');
  });

  it('terminates on a cycle instead of hanging the renderer', () => {
    // Two aliases pointing at each other is a thing an admin can do by
    // accident. Rendering a message must not become an infinite loop for it.
    const set = [emoji('a', { aliasFor: 'b' }), emoji('b', { aliasFor: 'a' })];
    expect(resolveEmojiAlias('a', set)).toBeNull();
  });

  it('is null for a name nobody uploaded', () => {
    expect(resolveEmojiAlias('nope', [])).toBeNull();
  });
});

describe('expandGroupMentions', () => {
  it('turns a handle into the people behind it', () => {
    const groups = [group('design', ['wsm-a', 'wsm-b'])];
    expect(expandGroupMentions('ping @design please', groups)).toEqual({
      groupIds: ['grp-design'],
      memberIds: ['wsm-a', 'wsm-b'],
    });
  });

  it('does not fire mid-word', () => {
    // `ada@design.example` is an email address, not a mention of the design
    // team.
    expect(expandGroupMentions('ada@design.example', [group('design', ['wsm-a'])])).toEqual({
      groupIds: [],
      memberIds: [],
    });
  });

  it('counts each person once when two groups overlap', () => {
    const groups = [group('design', ['wsm-a', 'wsm-b']), group('eng', ['wsm-b', 'wsm-c'])];
    const result = expandGroupMentions('@design and @eng', groups);
    expect(result.memberIds.sort()).toEqual(['wsm-a', 'wsm-b', 'wsm-c']);
  });
});

describe('isSuppressedByDnd', () => {
  const berlin = { ...DEFAULT_CHAT_DND, timezone: 'Europe/Berlin' };
  /** 2026-03-10 at the given UTC hour, so a fixed instant maps to a known
   * local time in the zone under test. */
  const at = (hourUtc: number) => Date.UTC(2026, 2, 10, hourUtc, 0, 0);

  it('is off when nothing is configured', () => {
    expect(isSuppressedByDnd(DEFAULT_CHAT_DND)).toBe(false);
  });

  it('holds notifications inside a window that crosses midnight', () => {
    // 22:00–08:00 is the ordinary case, not the exception, so it must not
    // depend on start being less than end.
    const dnd = { ...berlin, scheduleEnabled: true, startMinute: 22 * 60, endMinute: 8 * 60 };
    // 23:00 Berlin (22:00 UTC in March) is inside; 12:00 Berlin is not.
    expect(isSuppressedByDnd(dnd, { at: at(22) })).toBe(true);
    expect(isSuppressedByDnd(dnd, { at: at(11) })).toBe(false);
  });

  it('holds notifications inside a window that does not cross midnight', () => {
    const dnd = { ...berlin, scheduleEnabled: true, startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(isSuppressedByDnd(dnd, { at: at(11) })).toBe(true);
    expect(isSuppressedByDnd(dnd, { at: at(22) })).toBe(false);
  });

  it('lets a mention through when urgent notifications are allowed', () => {
    const dnd = {
      ...berlin,
      scheduleEnabled: true,
      startMinute: 0,
      endMinute: 1439,
      allowUrgent: true,
    };
    expect(isSuppressedByDnd(dnd, { at: at(11) })).toBe(true);
    expect(isSuppressedByDnd(dnd, { at: at(11), urgent: true })).toBe(false);
  });

  it('keeps a mention out when the person turned that off', () => {
    const dnd = {
      ...berlin,
      scheduleEnabled: true,
      startMinute: 0,
      endMinute: 1439,
      allowUrgent: false,
    };
    expect(isSuppressedByDnd(dnd, { at: at(11), urgent: true })).toBe(true);
  });

  it('lets a snooze override the schedule in both directions', () => {
    const now = at(11);
    expect(isSuppressedByDnd({ ...berlin, snoozeUntil: now + 60_000 }, { at: now })).toBe(true);
    expect(isSuppressedByDnd({ ...berlin, snoozeUntil: now - 60_000 }, { at: now })).toBe(false);
  });

  it('treats an empty window as no window at all', () => {
    const dnd = { ...berlin, scheduleEnabled: true, startMinute: 600, endMinute: 600 };
    expect(isSuppressedByDnd(dnd, { at: at(9) })).toBe(false);
  });
});

describe('minutesInZone', () => {
  it('reads the local clock in the named zone', () => {
    // 12:00 UTC is 13:00 in Berlin in March, and 21:00 in Tokyo.
    const noonUtc = Date.UTC(2026, 2, 10, 12, 0, 0);
    expect(minutesInZone(noonUtc, 'Europe/Berlin')).toBe(13 * 60);
    expect(minutesInZone(noonUtc, 'Asia/Tokyo')).toBe(21 * 60);
    expect(minutesInZone(noonUtc, 'UTC')).toBe(12 * 60);
  });

  it('falls back to the host clock rather than throwing on a bad zone', () => {
    expect(minutesInZone(Date.now(), 'Not/AZone')).toBeGreaterThanOrEqual(0);
  });
});

describe('isDurableChatEvent', () => {
  it('logs what a reconnecting client needs and drops what it does not', () => {
    expect(
      isDurableChatEvent({ type: 'message-deleted', channelId: 'c', messageId: 'm' }),
    ).toBe(true);
    expect(
      isDurableChatEvent({
        type: 'typing',
        typing: { channelId: 'c', memberId: 'm', parentMessageId: null, expiresAt: 0 },
      }),
    ).toBe(false);
    expect(
      isDurableChatEvent({
        type: 'presence',
        presence: { memberId: 'm', state: 'active', lastActiveAt: 0, connections: 1 },
      }),
    ).toBe(false);
  });
});
