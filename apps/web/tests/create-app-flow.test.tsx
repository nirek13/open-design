/** @vitest-environment jsdom */

import type { ChatChannel, OrgApp, OrgMember } from '@open-design/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateAppFlow } from '../src/components/apps/CreateAppFlow';
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

describe('CreateAppFlow', () => {
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
    vi.spyOn(registry, 'publishApp').mockResolvedValue(APP);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the modal open after deploy so the app can be sent immediately', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <CreateAppFlow
            orgId="ws-1"
            projectId="proj-1"
            filePath="expense.html"
            onClose={onClose}
            onCreated={onCreated}
          />
        </OrgProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('create-app-deploy-workspace'));
    expect(await screen.findByTestId('create-app-send')).toBeTruthy();
    expect(await screen.findByTestId('send-app-picker')).toBeTruthy();
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(APP);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(registry.publishApp).toHaveBeenCalled();
  });
});
