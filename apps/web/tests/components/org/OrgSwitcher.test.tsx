// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrgSwitcher } from '../../../src/components/org/OrgSwitcher';
import { I18nProvider } from '../../../src/i18n';
import { OrgProvider } from '../../../src/org/OrgContext';
import * as registry from '../../../src/providers/registry';

const NORTHWIND = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 2,
};

const CONTOSSO = {
  id: 'ws-2',
  name: 'Contosso',
  createdBy: 'wsm-2',
  createdAt: 2,
  updatedAt: 2,
  role: 'member' as const,
  memberCount: 5,
};

function renderSwitcher() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <OrgSwitcher onManage={vi.fn()} />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('OrgSwitcher', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists organizations and creates a new one', async () => {
    vi.spyOn(registry, 'fetchAuthContext')
      .mockResolvedValueOnce({
        mode: 'local-owner',
        viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null },
        organizations: [NORTHWIND, CONTOSSO],
      })
      .mockResolvedValue({
        mode: 'local-owner',
        viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null },
        organizations: [
          NORTHWIND,
          CONTOSSO,
          {
            id: 'ws-3',
            name: 'Acme',
            createdBy: 'wsm-3',
            createdAt: 3,
            updatedAt: 3,
            role: 'owner',
            memberCount: 1,
          },
        ],
      });
    const create = vi.spyOn(registry, 'createOrganization').mockResolvedValue({
      id: 'ws-3',
      name: 'Acme',
    });

    renderSwitcher();
    fireEvent.click(await screen.findByTestId('org-switcher-trigger'));
    expect(screen.getByTestId('org-switcher-menu')).toHaveTextContent('Northwind');
    expect(screen.getByTestId('org-switcher-menu')).toHaveTextContent('Contosso');

    fireEvent.click(screen.getByTestId('org-create-open'));
    fireEvent.change(screen.getByTestId('org-create-name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Acme'));
  });
});
