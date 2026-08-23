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
      viewer: { userId: 'user-1', displayName: 'Sam Rivera', email: 'sam@co.com' },
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
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null },
      organizations: [ORG],
    });
    renderMenu({ signOut: null });

    fireEvent.click(await screen.findByTestId('account-menu-trigger'));
    expect(screen.getByTestId('account-menu')).toHaveTextContent('This computer');
    expect(screen.queryByTestId('account-sign-out')).toBeNull();
  });
});
