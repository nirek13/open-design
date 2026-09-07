// @vitest-environment jsdom

// Admins invite by email, username, or a shareable link — three doors into
// the same organization, from one field.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrgMembersView } from '../src/components/org/OrgMembersView';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  websiteUrl: null,
  defaultDesignSystemId: null,
  setupCompletedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

const OWNER = {
  id: 'wsm-1',
  orgId: 'ws-1',
  userId: 'user-local-owner',
  displayName: 'Local Owner',
  email: null,
  username: null,
  bio: null,
  avatarUrl: null,
  role: 'owner' as const,
  status: 'active' as const,
  reportsTo: null,
  createdAt: 1,
  updatedAt: 1,
};

function renderMembers() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <OrgMembersView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('OrgMembersView invites', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([OWNER]);
    vi.spyOn(registry, 'fetchOrgTeams').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchOrgInvites').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('sends an email invite from the same field used for usernames', async () => {
    const created = {
      token: 'tok-email',
      url: 'http://localhost/join/tok-email',
      invite: {
        id: 'inv-1',
        orgId: 'ws-1',
        role: 'member' as const,
        kind: 'email' as const,
        targetEmail: 'jane@co.com',
        targetUsername: null,
        targetUserId: null,
        createdBy: 'wsm-1',
        expiresAt: Date.now() + 1000,
        maxUses: 1,
        useCount: 0,
        revokedAt: null,
        createdAt: 1,
      },
    };
    vi.spyOn(registry, 'createOrgInvite').mockResolvedValue(created);
    renderMembers();
    await screen.findByTestId('org-invite-target');
    fireEvent.change(screen.getByTestId('org-invite-target'), { target: { value: 'jane@co.com' } });
    fireEvent.click(screen.getByTestId('org-send-invite'));
    await waitFor(() => {
      expect(registry.createOrgInvite).toHaveBeenCalledWith('ws-1', {
        role: 'member',
        email: 'jane@co.com',
      });
    });
    expect(await screen.findByTestId('org-invite-link')).toHaveTextContent('/join/tok-email');
    expect(screen.getByText(/jane@co.com/)).toBeTruthy();
  });

  it('creates an open link without a recipient', async () => {
    vi.spyOn(registry, 'createOrgInvite').mockResolvedValue({
      token: 'tok-link',
      url: 'http://localhost/join/tok-link',
      invite: {
        id: 'inv-2',
        orgId: 'ws-1',
        role: 'member',
        kind: 'link',
        targetEmail: null,
        targetUsername: null,
        targetUserId: null,
        createdBy: 'wsm-1',
        expiresAt: null,
        maxUses: null,
        useCount: 0,
        revokedAt: null,
        createdAt: 1,
      },
    });
    renderMembers();
    await screen.findByTestId('org-create-invite');
    fireEvent.click(screen.getByTestId('org-create-invite'));
    await waitFor(() => {
      expect(registry.createOrgInvite).toHaveBeenCalledWith('ws-1', { role: 'member' });
    });
    expect(await screen.findByText(/shown once/i)).toBeTruthy();
  });

  it('renames the organization from settings', async () => {
    const rename = vi.spyOn(registry, 'renameOrganization').mockResolvedValue();
    renderMembers();
    const input = await screen.findByTestId('org-name-input');
    await waitFor(() => {
      expect(input).toHaveValue('Northwind');
    });
    fireEvent.change(input, { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-rename'));
    await waitFor(() => {
      expect(rename).toHaveBeenCalledWith('ws-1', 'Acme');
    });
  });

  it('creates a named team from the members view', async () => {
    vi.spyOn(registry, 'createOrgTeam').mockResolvedValue({
      id: 'team-1',
      orgId: 'ws-1',
      slug: 'finance',
      name: 'Finance',
      description: null,
      memberIds: [],
      createdBy: 'wsm-1',
      createdAt: 1,
      updatedAt: 1,
    });
    renderMembers();
    await screen.findByTestId('org-team-name');
    fireEvent.change(screen.getByTestId('org-team-name'), { target: { value: 'Finance' } });
    fireEvent.click(screen.getByTestId('org-create-team'));
    await waitFor(() => {
      expect(registry.createOrgTeam).toHaveBeenCalledWith('ws-1', { name: 'Finance' });
    });
  });
});
