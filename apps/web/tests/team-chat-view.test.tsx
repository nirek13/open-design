/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamChatView } from '../src/components/team/TeamChatView';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';
import type { ChatChannel, OrgMember, TeamChatMessage } from '@open-design/contracts';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 2,
};

const MEMBER: OrgMember = {
  id: 'wsm-1',
  orgId: 'ws-1',
  userId: 'user-local-owner',
  displayName: 'Local Owner',
  email: null,
  username: 'owner',
  bio: null,
  avatarUrl: null,
  role: 'owner',
  status: 'active',
  reportsTo: null,
  createdAt: 1,
  updatedAt: 1,
};

const CHANNEL: ChatChannel = {
  id: 'chn-1',
  orgId: 'ws-1',
  slug: 'general',
  displayName: 'General',
  topic: 'Company-wide',
  kind: 'channel',
  visibility: 'public',
  archivedAt: null,
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  memberCount: 2,
  messageCount: 1,
  unreadCount: 0,
  joined: true,
  lastMessageAt: 1,
  purpose: null,
  starred: false,
  muted: false,
  notify: 'all',
};

const MESSAGE: TeamChatMessage = {
  id: 'msg-1',
  channelId: 'chn-1',
  orgId: 'ws-1',
  authorMemberId: 'wsm-1',
  authorName: 'Ada',
  body: 'Hello team',
  system: false,
  attachments: [],
  mentions: [],
  parentMessageId: null,
  replyCount: 0,
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: Date.now(),
  pinned: false,
  saved: false,
};

function renderChat() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <TeamChatView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('TeamChatView', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: {
        userId: 'user-local-owner',
        displayName: 'Local Owner',
        email: null,
        username: 'owner',
        bio: null,
        avatarUrl: null,
      },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([MEMBER]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('sets up default channels when the workspace is empty', async () => {
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({ channels: [], totalUnread: 0 });
    const setup = vi.spyOn(registry, 'setUpChatChannels').mockResolvedValue([CHANNEL]);

    renderChat();
    fireEvent.click(await screen.findByTestId('team-setup'));
    await waitFor(() => {
      expect(setup).toHaveBeenCalledWith('ws-1');
    });
  });

  it('lists a channel, shows its transcript, and sends a message', async () => {
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL],
      totalUnread: 0,
    });
    vi.spyOn(registry, 'fetchChatMessages').mockResolvedValue({
      messages: [MESSAGE],
      nextBefore: null,
    });
    vi.spyOn(registry, 'markChatChannelRead').mockResolvedValue(CHANNEL);
    const post = vi.spyOn(registry, 'postChatMessage').mockResolvedValue({
      message: { ...MESSAGE, id: 'msg-2', body: 'On it' },
    });

    renderChat();
    expect(await screen.findByTestId('team-channel-general')).toBeTruthy();
    expect(await screen.findByText('Hello team')).toBeTruthy();

    fireEvent.change(screen.getByTestId('team-composer'), { target: { value: 'On it' } });
    fireEvent.click(screen.getByTestId('team-send'));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('ws-1', 'general', { body: 'On it' });
    });
  });

  it('does not show Clerk user ids as a workspace or author name', async () => {
    const clerkId = 'user_3lI4Uuw7AKpshQHVCfaKmWRKv6W';
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'clerk',
      viewer: {
        userId: 'user-abc',
        displayName: clerkId,
        email: null,
        username: 'nirek',
        bio: null,
        avatarUrl: null,
      },
      organizations: [{ ...ORG, name: `${clerkId}'s Organization` }],
    });
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([
      {
        ...MEMBER,
        userId: 'user-abc',
        displayName: clerkId,
        username: 'nirek',
      },
    ]);
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL],
      totalUnread: 0,
    });
    vi.spyOn(registry, 'fetchChatMessages').mockResolvedValue({
      messages: [{ ...MESSAGE, authorName: clerkId }],
      nextBefore: null,
    });
    vi.spyOn(registry, 'markChatChannelRead').mockResolvedValue(CHANNEL);

    renderChat();
    expect(await screen.findByTestId('team-workspace-name')).toHaveTextContent('Workspace');
    expect(await screen.findByText('me')).toBeTruthy();
    expect(screen.queryByText(clerkId)).toBeNull();
  });

  it('labels your own messages as me instead of Member', async () => {
    const other: OrgMember = {
      ...MEMBER,
      id: 'wsm-2',
      userId: 'user-other',
      displayName: 'Member',
      username: 'nirek',
      role: 'member',
    };
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'clerk',
      viewer: {
        userId: 'user-local-owner',
        displayName: 'Member',
        email: null,
        username: null,
        bio: null,
        avatarUrl: null,
      },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([
      { ...MEMBER, displayName: 'Member', username: null },
      other,
    ]);
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL],
      totalUnread: 0,
    });
    vi.spyOn(registry, 'fetchChatMessages').mockResolvedValue({
      messages: [
        { ...MESSAGE, body: 'test' },
        {
          ...MESSAGE,
          id: 'msg-2',
          authorMemberId: other.id,
          authorName: 'nirek',
          body: 'boom',
        },
      ],
      nextBefore: null,
    });
    vi.spyOn(registry, 'markChatChannelRead').mockResolvedValue(CHANNEL);

    renderChat();
    expect(await screen.findByText('test')).toBeTruthy();
    const mine = screen.getByTestId('team-message-msg-1');
    expect(mine.textContent).toContain('me');
    expect(mine.textContent).not.toContain('Member');
    expect(screen.getByTestId('team-message-msg-2').textContent).toContain('nirek');
  });

  it('renders an app attachment as a button so the transcript can open it', async () => {
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL],
      totalUnread: 0,
    });
    vi.spyOn(registry, 'fetchChatMessages').mockResolvedValue({
      messages: [
        {
          ...MESSAGE,
          attachments: [{ kind: 'app', id: 'app-1', label: 'Expense form' }],
        },
      ],
      nextBefore: null,
    });
    vi.spyOn(registry, 'markChatChannelRead').mockResolvedValue(CHANNEL);

    renderChat();
    const chip = await screen.findByTestId('team-app-attachment-app-1');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.textContent).toContain('Expense form');
  });

  it('renders an image file and unfurls a pasted link', async () => {
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL],
      totalUnread: 0,
    });
    vi.spyOn(registry, 'fetchChatMessages').mockResolvedValue({
      messages: [
        {
          ...MESSAGE,
          body: 'See https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          attachments: [
            {
              kind: 'file',
              id: 'file-1',
              label: 'shot.png',
              url: '/api/orgs/ws-1/chat/files/file-1',
              mimeType: 'image/png',
              fileName: 'shot.png',
              byteSize: 2048,
            },
          ],
        },
      ],
      nextBefore: null,
    });
    vi.spyOn(registry, 'markChatChannelRead').mockResolvedValue(CHANNEL);

    renderChat();
    expect(await screen.findByTestId('team-file-file-1')).toBeTruthy();
    expect(await screen.findByTestId('team-link-embed')).toBeTruthy();
    expect(screen.getByTestId('team-attach')).toBeTruthy();
  });

  it('opens the activity inbox from the Slack sidebar', async () => {
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL],
      totalUnread: 1,
    });
    vi.spyOn(registry, 'fetchChatMessages').mockResolvedValue({
      messages: [MESSAGE],
      nextBefore: null,
    });
    vi.spyOn(registry, 'markChatChannelRead').mockResolvedValue(CHANNEL);
    vi.spyOn(registry, 'fetchChatActivity').mockResolvedValue({
      items: [
        {
          kind: 'mention',
          createdAt: Date.now(),
          channelId: CHANNEL.id,
          channelSlug: CHANNEL.slug,
          channelName: CHANNEL.displayName,
          message: MESSAGE,
          actorMemberId: 'wsm-2',
          actorName: 'Ada',
        },
      ],
    });
    vi.spyOn(registry, 'fetchChatStatuses').mockResolvedValue({ statuses: [] });
    vi.spyOn(registry, 'fetchChatPins').mockResolvedValue({ pins: [] });
    vi.spyOn(registry, 'fetchChatBookmarks').mockResolvedValue({ bookmarks: [] });
    vi.spyOn(registry, 'fetchChatChannelMembers').mockResolvedValue([]);

    renderChat();
    fireEvent.click(await screen.findByTestId('team-activity'));
    expect(await screen.findByTestId('team-activity-list')).toBeTruthy();
    expect(await screen.findByText('mentioned you')).toBeTruthy();
  });

  it('lists unread conversations in the Unreads pane', async () => {
    const unread: ChatChannel = {
      ...CHANNEL,
      id: 'chn-2',
      slug: 'sales',
      displayName: 'Sales',
      unreadCount: 3,
    };
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL, unread],
      totalUnread: 3,
    });
    vi.spyOn(registry, 'fetchChatMessages').mockResolvedValue({
      messages: [MESSAGE],
      nextBefore: null,
    });
    vi.spyOn(registry, 'markChatChannelRead').mockResolvedValue(CHANNEL);
    vi.spyOn(registry, 'fetchChatStatuses').mockResolvedValue({ statuses: [] });
    vi.spyOn(registry, 'fetchChatPins').mockResolvedValue({ pins: [] });
    vi.spyOn(registry, 'fetchChatBookmarks').mockResolvedValue({ bookmarks: [] });
    vi.spyOn(registry, 'fetchChatChannelMembers').mockResolvedValue([]);

    renderChat();
    fireEvent.click(await screen.findByTestId('team-unreads'));
    expect(await screen.findByTestId('team-unreads-list')).toBeTruthy();
    expect(screen.getByTestId('team-unreads-list').textContent).toContain('Sales');
  });
});

