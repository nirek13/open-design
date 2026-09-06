/** @vitest-environment jsdom */

import type { OrgAppWithOrgName } from '@open-design/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrgAppsView } from '../../../src/components/org/OrgAppsView';
import { I18nProvider } from '../../../src/i18n';
import { OrgProvider } from '../../../src/org/OrgContext';
import * as registry from '../../../src/providers/registry';

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

const APP: OrgAppWithOrgName = {
  id: 'app-1',
  orgId: 'ws-1',
  orgName: 'Northwind',
  name: 'Expense form',
  description: 'Submit receipts',
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

function renderApps() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <OrgAppsView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('OrgAppsView gallery', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: {
        userId: 'user-local-owner',
        displayName: 'Local Owner',
        email: null,
        username: null,
        bio: null,
        avatarUrl: null,
      },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchAllOrgApps').mockResolvedValue([APP]);
    vi.spyOn(registry, 'fetchProjectFileText').mockResolvedValue(
      '<html><body><h1>Expense form</h1></body></html>',
    );
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a preview of each app and keeps extra settings behind three dots', async () => {
    renderApps();
    await screen.findByTestId('org-app-card');
    expect(screen.getByTestId('org-app-preview')).toBeTruthy();
    expect(screen.getByText('Expense form')).toBeTruthy();
    expect(screen.queryByTestId('org-app-more-menu')).toBeNull();
    expect(screen.queryByTestId('org-app-send')).toBeNull();
    expect(screen.queryByText('Archive')).toBeNull();

    fireEvent.click(screen.getByTestId('org-app-more'));
    const menu = await screen.findByTestId('org-app-more-menu');
    expect(menu).toHaveTextContent('Send');
    expect(menu).toHaveTextContent('Edit');
    expect(menu).toHaveTextContent('Pin');
    expect(menu).toHaveTextContent('Access');
    expect(menu).toHaveTextContent('Publish to web');
    expect(menu).toHaveTextContent('Archive');
    expect(screen.getByTestId('org-app-send')).toBeTruthy();
  });

  it('opens access settings from the overflow menu', async () => {
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchOrgTeams').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchAppAccess').mockResolvedValue({
      grants: [],
      teamGrants: [],
      denials: [],
    });
    renderApps();
    await screen.findByTestId('org-app-card');
    fireEvent.click(screen.getByTestId('org-app-more'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Access' }));
    await waitFor(() => {
      expect(screen.getByTestId('org-app-access')).toBeTruthy();
    });
  });
});
