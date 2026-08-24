// @vitest-environment jsdom

// After sign-up the person has to pick join or create, and a pasted invite
// URL has to work the same as a bare code.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSetupView } from '../src/components/org/WorkspaceSetupView';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const emptyAuth = {
  mode: 'clerk' as const,
  viewer: {
    userId: 'user-1',
    displayName: 'Ada',
    email: 'ada@co.com',
    username: 'ada',
    bio: null,
    avatarUrl: null,
  },
  organizations: [],
};

describe('WorkspaceSetupView', () => {
  it('lets a new account join with a pasted invite URL', async () => {
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue(emptyAuth);
    vi.spyOn(registry, 'fetchInvitePreview').mockResolvedValue({
      valid: true,
      orgName: 'Northwind',
      role: 'member',
    });
    const accept = vi.spyOn(registry, 'acceptInvite').mockResolvedValue({
      organization: { id: 'ws-1', name: 'Northwind' },
    });

    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <WorkspaceSetupView />
        </OrgProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('setup-choose-join'));
    fireEvent.change(screen.getByTestId('setup-join-input'), {
      target: { value: 'https://app.example.com/join/tok-abc' },
    });
    fireEvent.click(screen.getByTestId('setup-join-submit'));
    await waitFor(() => {
      expect(accept).toHaveBeenCalledWith('tok-abc');
    });
  });

  it('moves from create to the website branding step', async () => {
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
    vi.spyOn(registry, 'createOrganization').mockResolvedValue({ id: 'ws-new', name: 'Acme' });
    vi.spyOn(registry, 'fetchAuthContext')
      .mockResolvedValueOnce(emptyAuth)
      .mockResolvedValue({
        ...emptyAuth,
        organizations: [
          {
            id: 'ws-new',
            name: 'Acme',
            createdBy: 'user-1',
            createdAt: 1,
            updatedAt: 1,
            websiteUrl: null,
            defaultDesignSystemId: null,
            setupCompletedAt: null,
            role: 'owner',
            memberCount: 1,
          },
        ],
      });

    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <WorkspaceSetupView />
        </OrgProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('setup-choose-create'));
    fireEvent.change(screen.getByTestId('setup-create-name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('setup-create-submit'));
    expect(await screen.findByTestId('setup-brand-url')).toBeTruthy();
  });
});
