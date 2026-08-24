// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchView } from '../../src/components/search/SearchView';
import { I18nProvider } from '../../src/i18n';
import { OrgProvider } from '../../src/org/OrgContext';
import * as registry from '../../src/providers/registry';
import { navigate } from '../../src/router';

vi.mock('../../src/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/router')>();
  return { ...actual, navigate: vi.fn() };
});

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

function renderSearch() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <SearchView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('SearchView', () => {
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
    vi.spyOn(registry, 'searchOrg').mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('searches the organization and opens a page hit', async () => {
    vi.mocked(registry.searchOrg).mockResolvedValue([
      {
        kind: 'page',
        id: 'pg-1',
        title: 'Owner handbook',
        snippet: 'Day one',
        href: '/pages/pg-1',
        ownerMemberId: 'wsm-1',
        ownerName: 'Local Owner',
        sourceLabel: 'Pages',
        score: 40,
        updatedAt: Date.now(),
        pageId: 'pg-1',
      },
    ]);

    renderSearch();
    const input = await screen.findByTestId('org-search-input');
    fireEvent.change(input, { target: { value: 'handbook' } });

    await waitFor(() => {
      expect(registry.searchOrg).toHaveBeenCalledWith('ws-1', 'handbook');
    });
    expect(await screen.findByText('Owner handbook')).toBeTruthy();

    fireEvent.click(screen.getByTestId('org-search-hit-page'));
    expect(navigate).toHaveBeenCalledWith({ kind: 'home', view: 'pages', pageId: 'pg-1' });
  });

  it('shows an empty state when nothing matches', async () => {
    renderSearch();
    fireEvent.change(await screen.findByTestId('org-search-input'), {
      target: { value: 'no-such-thing' },
    });
    expect(await screen.findByText(/No matches/, {}, { timeout: 2000 })).toBeTruthy();
  });
});
