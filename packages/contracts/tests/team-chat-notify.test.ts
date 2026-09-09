import { describe, expect, it } from 'vitest';
import { shouldNotifyChatMember } from '../src/api/team-chat.js';

const base = {
  memberId: 'wsm-ada',
  authorMemberId: 'wsm-sam',
  muted: false,
  notify: 'all' as const,
  mentions: [] as string[],
};

describe('shouldNotifyChatMember', () => {
  it('notifies every unmuted member on notify=all', () => {
    expect(shouldNotifyChatMember(base)).toBe(true);
  });

  it('never notifies the author', () => {
    expect(shouldNotifyChatMember({ ...base, memberId: 'wsm-sam' })).toBe(false);
  });

  it('skips muted rooms and notify=nothing', () => {
    expect(shouldNotifyChatMember({ ...base, muted: true })).toBe(false);
    expect(shouldNotifyChatMember({ ...base, notify: 'nothing' })).toBe(false);
  });

  it('on mentions-only, fires for @you and @channel but not a plain message', () => {
    expect(shouldNotifyChatMember({ ...base, notify: 'mentions' })).toBe(false);
    expect(
      shouldNotifyChatMember({ ...base, notify: 'mentions', mentions: ['wsm-ada'] }),
    ).toBe(true);
    expect(
      shouldNotifyChatMember({ ...base, notify: 'mentions', mentions: ['@channel'] }),
    ).toBe(true);
    expect(
      shouldNotifyChatMember({ ...base, notify: 'mentions', mentions: ['@here'] }),
    ).toBe(true);
  });

  it('skips system messages', () => {
    expect(shouldNotifyChatMember({ ...base, system: true })).toBe(false);
  });
});
