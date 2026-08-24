import type { ChatChannel, OrgApp, TeamChatMessage } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendAppToChat } from '../src/components/apps/sendAppToChat';
import * as registry from '../src/providers/registry';

const APP: OrgApp = {
  id: 'app-1',
  orgId: 'ws-1',
  name: 'Expense form',
  description: null,
  projectId: 'proj-1',
  filePath: 'expense.html',
  visibility: 'org',
  status: 'active',
  accessMode: 'org',
  pinned: false,
  pinnedAt: null,
  createdBy: 'wsm-1',
  createdByName: 'Local Owner',
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  lastOpenedAt: null,
  openCount: 0,
  dataScopes: [],
  webUrl: null,
};

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
};

const POSTED: TeamChatMessage = {
  id: 'msg-sent',
  channelId: 'chn-dm',
  orgId: 'ws-1',
  authorMemberId: 'wsm-1',
  authorName: 'Local Owner',
  body: 'try this',
  system: false,
  attachments: [{ kind: 'app', id: 'app-1', label: 'Expense form' }],
  mentions: [],
  parentMessageId: null,
  replyCount: 0,
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: 1,
};

const ATTACHMENT = { kind: 'app' as const, id: 'app-1', label: 'Expense form' };

const EMPTY_ACCESS = { grants: [], teamGrants: [], denials: [] };

describe('sendAppToChat', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'openChatDirectMessage').mockResolvedValue(DM);
    vi.spyOn(registry, 'postChatMessage').mockResolvedValue(POSTED);
    vi.spyOn(registry, 'fetchAppAccess').mockResolvedValue(EMPTY_ACCESS);
    vi.spyOn(registry, 'setAppAccess').mockResolvedValue(EMPTY_ACCESS);
    vi.spyOn(registry, 'fetchOrgTeams').mockResolvedValue([
      {
        id: 'team-finance',
        orgId: 'ws-1',
        slug: 'finance',
        name: 'Finance',
        description: null,
        memberIds: ['wsm-2', 'wsm-3'],
        createdBy: 'wsm-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a DM and posts the app as an attachment', async () => {
    const refs = await sendAppToChat(
      'ws-1',
      APP,
      [{ kind: 'person', memberId: 'wsm-2' }],
      'try this',
    );
    expect(registry.openChatDirectMessage).toHaveBeenCalledWith('ws-1', ['wsm-2']);
    expect(registry.postChatMessage).toHaveBeenCalledWith('ws-1', 'dm-ada', {
      body: 'try this',
      attachments: [ATTACHMENT],
    });
    expect(refs).toEqual(['dm-ada']);
  });

  it('posts into a channel without opening a DM', async () => {
    const refs = await sendAppToChat(
      'ws-1',
      APP,
      [{ kind: 'channel', channelRef: 'general' }],
      'try this',
    );
    expect(registry.openChatDirectMessage).not.toHaveBeenCalled();
    expect(registry.postChatMessage).toHaveBeenCalledWith('ws-1', 'general', {
      body: 'try this',
      attachments: [ATTACHMENT],
    });
    expect(refs).toEqual(['general']);
  });

  it('grants view on a restricted app before DMing', async () => {
    await sendAppToChat(
      'ws-1',
      { ...APP, accessMode: 'restricted' },
      [{ kind: 'person', memberId: 'wsm-2' }],
      'try this',
    );
    expect(registry.setAppAccess).toHaveBeenCalledWith('ws-1', 'app-1', {
      grants: [{ memberId: 'wsm-2', role: 'view' }],
      teamGrants: [],
      denials: [],
    });
    expect(registry.openChatDirectMessage).toHaveBeenCalledWith('ws-1', ['wsm-2']);
  });

  it('does not DM a person marked except, and writes a denial', async () => {
    const refs = await sendAppToChat(
      'ws-1',
      APP,
      [
        { kind: 'person', memberId: 'wsm-2' },
        { kind: 'person', memberId: 'wsm-3' },
      ],
      'try this',
      ['wsm-3'],
    );
    expect(registry.openChatDirectMessage).toHaveBeenCalledTimes(1);
    expect(registry.openChatDirectMessage).toHaveBeenCalledWith('ws-1', ['wsm-2']);
    expect(registry.setAppAccess).toHaveBeenCalledWith('ws-1', 'app-1', {
      grants: [],
      teamGrants: [],
      denials: [{ memberId: 'wsm-3' }],
    });
    expect(refs).toEqual(['dm-ada']);
  });

  it('withholds the app from a person with no send destination', async () => {
    const refs = await sendAppToChat('ws-1', APP, [], 'try this', ['wsm-3']);
    expect(registry.openChatDirectMessage).not.toHaveBeenCalled();
    expect(registry.postChatMessage).not.toHaveBeenCalled();
    expect(registry.setAppAccess).toHaveBeenCalledWith('ws-1', 'app-1', {
      grants: [],
      teamGrants: [],
      denials: [{ memberId: 'wsm-3' }],
    });
    expect(refs).toEqual([]);
  });

  it('expands a team to its members minus except', async () => {
    await sendAppToChat(
      'ws-1',
      APP,
      [{ kind: 'team', teamId: 'team-finance' }],
      'try this',
      ['wsm-3'],
    );
    expect(registry.fetchOrgTeams).toHaveBeenCalledWith('ws-1');
    expect(registry.openChatDirectMessage).toHaveBeenCalledTimes(1);
    expect(registry.openChatDirectMessage).toHaveBeenCalledWith('ws-1', ['wsm-2']);
    expect(registry.setAppAccess).toHaveBeenCalledWith('ws-1', 'app-1', {
      grants: [],
      teamGrants: [],
      denials: [{ memberId: 'wsm-3' }],
    });
  });

  it('grants a restricted app to a named team', async () => {
    await sendAppToChat(
      'ws-1',
      { ...APP, accessMode: 'restricted' },
      [{ kind: 'team', teamId: 'team-finance' }],
      'try this',
    );
    expect(registry.setAppAccess).toHaveBeenCalledWith('ws-1', 'app-1', {
      grants: [
        { memberId: 'wsm-2', role: 'view' },
        { memberId: 'wsm-3', role: 'view' },
      ],
      teamGrants: [{ teamId: 'team-finance', role: 'view' }],
      denials: [],
    });
  });

  it('refuses a blank body or an empty destination list', async () => {
    await expect(
      sendAppToChat('ws-1', APP, [{ kind: 'person', memberId: 'wsm-2' }], '  '),
    ).rejects.toThrow(/message/i);
    await expect(sendAppToChat('ws-1', APP, [], 'try this')).rejects.toThrow(/pick/i);
    expect(registry.postChatMessage).not.toHaveBeenCalled();
  });
});
