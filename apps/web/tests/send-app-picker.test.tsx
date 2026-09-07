/** @vitest-environment jsdom */

import type { ChatChannel, OrgApp, OrgMember } from '@open-design/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SendAppPicker } from '../src/components/apps/SendAppPicker';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';

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

const COWORKER: OrgMember = {
  ...MEMBER,
  id: 'wsm-2',
  userId: 'user-ada',
  displayName: 'Ada',
  username: 'ada',
  role: 'member',
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

const DM: ChatChannel = {
  ...CHANNEL,
  id: 'chn-dm',
  slug: 'dm-ada',
  displayName: 'Ada',
  topic: null,
  kind: 'dm',
  visibility: 'private',
  memberCount: 2,
  messageCount: 0,
  lastMessageAt: null,
};

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

function renderPicker() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <SendAppPicker orgId="ws-1" app={APP} />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('SendAppPicker', () => {
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
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([MEMBER, COWORKER]);
    vi.spyOn(registry, 'fetchOrgTeams').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({
      channels: [CHANNEL],
      totalUnread: 0,
    });
    vi.spyOn(registry, 'openChatDirectMessage').mockResolvedValue(DM);
    vi.spyOn(registry, 'fetchAppAccess').mockResolvedValue({ grants: [], teamGrants: [], denials: [] });
    vi.spyOn(registry, 'setAppAccess').mockResolvedValue({ grants: [], teamGrants: [], denials: [] });
    vi.spyOn(registry, 'postChatMessage').mockResolvedValue({
      message: {
        id: 'msg-sent',
        channelId: DM.id,
        orgId: 'ws-1',
        authorMemberId: 'wsm-1',
        authorName: 'Local Owner',
        body: 'Shared Expense form',
        system: false,
        attachments: [{ kind: 'app', id: 'app-1', label: 'Expense form' }],
        mentions: [],
        parentMessageId: null,
        replyCount: 0,
        reactions: [],
        editedAt: null,
        deletedAt: null,
        createdAt: 1,
        pinned: false,
        saved: false,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('DMs a coworker with the app attached', async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId('send-app-person-wsm-2'));
    await waitFor(() => {
      expect(screen.queryByTestId('send-app-person-wsm-1')).toBeNull();
    });
    fireEvent.click(screen.getByTestId('send-app-submit'));
    await waitFor(() => {
      expect(registry.openChatDirectMessage).toHaveBeenCalledWith('ws-1', ['wsm-2']);
      expect(registry.postChatMessage).toHaveBeenCalledWith('ws-1', 'dm-ada', {
        body: 'Shared Expense form',
        attachments: [{ kind: 'app', id: 'app-1', label: 'Expense form' }],
      });
    });
    expect(await screen.findByTestId('send-app-sent')).toBeTruthy();
  });

  it('can mark a coworker as except so they are not sent the app', async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId('send-app-except-wsm-2'));
    fireEvent.click(screen.getByTestId('send-app-channel-general'));
    fireEvent.click(screen.getByTestId('send-app-submit'));
    await waitFor(() => {
      expect(registry.postChatMessage).toHaveBeenCalledWith('ws-1', 'general', expect.anything());
      expect(registry.setAppAccess).toHaveBeenCalledWith('ws-1', 'app-1', {
        grants: [],
        teamGrants: [],
        denials: [{ memberId: 'wsm-2' }],
      });
    });
  });
});
