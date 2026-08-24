// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountMenu } from '../../../src/components/account/AccountMenu';
import { AuthActionsProvider } from '../../../src/auth/AuthActions';
import { I18nProvider } from '../../../src/i18n';
import { OrgProvider } from '../../../src/org/OrgContext';
import * as registry from '../../../src/providers/registry';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

function renderMenu({ signOut }: { signOut?: (() => Promise<void>) | null }) {
  return render(
    <I18nProvider initial="en">
      <AuthActionsProvider signOut={signOut ?? null}>
        <OrgProvider>
          <AccountMenu />
        </OrgProvider>
      </AuthActionsProvider>
    </I18nProvider>,
  );
}

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows who is signed in and lets them sign out', async () => {
    const signOut = vi.fn(async () => {});
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'clerk',
      publishableKey: 'pk_test_x',
      viewer: { userId: 'user-1', displayName: 'Sam Rivera', email: 'sam@co.com', username: null },
      organizations: [ORG],
    });
    renderMenu({ signOut });

    fireEvent.click(await screen.findByTestId('account-menu-trigger'));
    expect(screen.getByTestId('account-menu')).toHaveTextContent('Sam Rivera');
    expect(screen.getByTestId('account-menu')).toHaveTextContent('sam@co.com');
    fireEvent.click(screen.getByTestId('account-sign-out'));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it('hides sign-out on a keyless local machine', async () => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null },
      organizations: [ORG],
    });
    renderMenu({ signOut: null });

    fireEvent.click(await screen.findByTestId('account-menu-trigger'));
    expect(screen.getByTestId('account-menu')).toHaveTextContent('This computer');
    expect(screen.queryByTestId('account-sign-out')).toBeNull();
  });

  it('lets a person claim a public username', async () => {
    let username: string | null = null;
    vi.spyOn(registry, 'fetchAuthContext').mockImplementation(async () => ({
      mode: 'clerk',
      publishableKey: 'pk_test_x',
      viewer: { userId: 'user-1', displayName: 'Sam Rivera', email: 'sam@co.com', username },
      organizations: [ORG],
    }));
    const updateProfile = vi.spyOn(registry, 'updateProfile').mockImplementation(async (next) => {
      username = next.username ?? username;
      return {
        userId: 'user-1',
        displayName: 'Sam Rivera',
        email: 'sam@co.com',
        username,
        bio: null,
        avatarUrl: null,
      };
    });
    renderMenu({ signOut: vi.fn(async () => {}) });

    fireEvent.click(await screen.findByTestId('account-menu-trigger'));
    expect(screen.getByTestId('account-username')).toHaveTextContent('No username yet');
    fireEvent.change(screen.getByTestId('account-username-input'), { target: { value: 'Jane' } });
    fireEvent.click(screen.getByTestId('account-username-save'));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ username: 'jane' }));
    await waitFor(() => expect(screen.getByTestId('account-username')).toHaveTextContent('@jane'));
    expect(screen.getByTestId('account-username-saved')).toBeTruthy();
  });

  it('explains when a username is taken or invalid', async () => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'clerk',
      publishableKey: 'pk_test_x',
      viewer: { userId: 'user-1', displayName: 'Sam Rivera', email: 'sam@co.com', username: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'updateProfile').mockRejectedValue(new Error('USERNAME_TAKEN'));
    renderMenu({ signOut: vi.fn(async () => {}) });

    fireEvent.click(await screen.findByTestId('account-menu-trigger'));
    fireEvent.change(screen.getByTestId('account-username-input'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('account-username-save'));
    expect(screen.getByTestId('account-username-error')).toHaveTextContent(
      'Use 2–32 characters starting and ending with a letter or number.',
    );

    fireEvent.change(screen.getByTestId('account-username-input'), { target: { value: 'jane' } });
    fireEvent.click(screen.getByTestId('account-username-save'));
    await waitFor(() =>
      expect(screen.getByTestId('account-username-error')).toHaveTextContent('That username is already taken.'),
    );
  });

  it('does not call a valid handle like nirek a format error when save fails', async () => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'clerk',
      publishableKey: 'pk_test_x',
      viewer: { userId: 'user-1', displayName: 'Sam Rivera', email: 'sam@co.com', username: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'updateProfile').mockRejectedValue(new Error('HTTP 404'));
    renderMenu({ signOut: vi.fn(async () => {}) });

    fireEvent.click(await screen.findByTestId('account-menu-trigger'));
    fireEvent.change(screen.getByTestId('account-username-input'), { target: { value: 'nirek' } });
    fireEvent.click(screen.getByTestId('account-username-save'));
    await waitFor(() => expect(registry.updateProfile).toHaveBeenCalledWith({ username: 'nirek' }));
    expect(screen.getByTestId('account-username-error')).toHaveTextContent(
      'Couldn’t save that username. Try again.',
    );
  });
});
