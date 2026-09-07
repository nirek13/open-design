import type { CalendarEvent, ChatChannel, OrgMember, TeamChatMessage } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendEventToChat, sendPageToChat } from '../src/components/apps/sendToChat';
import * as registry from '../src/providers/registry';

const DM: ChatChannel = {
  id: 'chn-dm',
  orgId: 'ws-1',
  slug: 'dm-ada',
  displayName: 'Ada',
  topic: null,
  kind: 'dm',
  visibility: 'private',
  archivedAt: null,
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  memberCount: 2,
  messageCount: 0,
  unreadCount: 0,
  joined: true,
  lastMessageAt: null,
  purpose: null,
  starred: false,
  muted: false,
  notify: 'all',
};

const ADA: OrgMember = {
  id: 'wsm-2',
  orgId: 'ws-1',
  userId: 'user-ada',
  displayName: 'Ada',
  email: null,
  username: 'ada',
  bio: null,
  avatarUrl: null,
  role: 'member',
  status: 'active',
  reportsTo: null,
  createdAt: 1,
  updatedAt: 1,
};

function posted(attachments: TeamChatMessage['attachments']): TeamChatMessage {
  return {
    id: 'msg-sent',
    channelId: DM.id,
    orgId: 'ws-1',
    authorMemberId: 'wsm-1',
    authorName: 'Local Owner',
    body: 'try this',
    system: false,
    attachments,
    mentions: [],
    parentMessageId: null,
    replyCount: 0,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: 1,
    pinned: false,
    saved: false,
  };
}

const EVENT: CalendarEvent = {
  id: 'evt-1',
  orgId: 'ws-1',
  calendarId: 'cal-1',
  title: 'Design review',
  description: null,
  location: null,
  startsAt: '2026-09-08T15:00:00.000Z',
  endsAt: '2026-09-08T16:00:00.000Z',
  allDay: false,
  color: '#5b6cff',
  recurrence: null,
  timezone: null,
  attendees: null,
  guestUserIds: [],
  guestTeamIds: [],
  scheduleUserIds: ['user-local-owner'],
  googleEventId: null,
  externalUid: null,
  source: 'local',
  instanceId: 'evt-1',
  createdBy: 'user-local-owner',
  createdAt: 1,
  updatedAt: 1,
};

describe('sendPageToChat', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'openChatDirectMessage').mockResolvedValue(DM);
    vi.spyOn(registry, 'postChatMessage').mockResolvedValue(
      { message: posted([{ kind: 'page', id: 'page-1', label: 'Handbook' }]) },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DMs a coworker with the page attached', async () => {
    const refs = await sendPageToChat(
      'ws-1',
      { id: 'page-1', title: 'Handbook' },
      [{ kind: 'person', memberId: 'wsm-2' }],
      'try this',
    );
    expect(registry.openChatDirectMessage).toHaveBeenCalledWith('ws-1', ['wsm-2']);
    expect(registry.postChatMessage).toHaveBeenCalledWith('ws-1', 'dm-ada', {
      body: 'try this',
      attachments: [{ kind: 'page', id: 'page-1', label: 'Handbook' }],
    });
    expect(refs).toEqual(['dm-ada']);
  });
});

describe('sendEventToChat', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'openChatDirectMessage').mockResolvedValue(DM);
    vi.spyOn(registry, 'postChatMessage').mockResolvedValue(
      { message: posted([{ kind: 'event', id: 'evt-1', label: 'Design review' }]) },
    );
    vi.spyOn(registry, 'fetchOrgCalendarEvent').mockResolvedValue(EVENT);
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([ADA]);
    vi.spyOn(registry, 'updateOrgCalendarEvent').mockResolvedValue({
      ...EVENT,
      guestUserIds: ['user-ada'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invites the coworker then DMs the event', async () => {
    const refs = await sendEventToChat(
      'ws-1',
      { id: 'evt-1', title: 'Design review' },
      [{ kind: 'person', memberId: 'wsm-2' }],
      'try this',
    );
    expect(registry.updateOrgCalendarEvent).toHaveBeenCalledWith(
      'ws-1',
      'evt-1',
      expect.objectContaining({ guestUserIds: ['user-ada'], guestTeamIds: [] }),
    );
    expect(registry.openChatDirectMessage).toHaveBeenCalledWith('ws-1', ['wsm-2']);
    expect(registry.postChatMessage).toHaveBeenCalledWith('ws-1', 'dm-ada', {
      body: 'try this',
      attachments: [{ kind: 'event', id: 'evt-1', label: 'Design review' }],
    });
    expect(refs).toEqual(['dm-ada']);
  });
});
