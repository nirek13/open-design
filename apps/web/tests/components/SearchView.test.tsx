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
    vi.spyOn(registry, 'fetchAllOrgApps').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchLibraryAssets').mockResolvedValue([]);
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

  it('opens a place from Spotlight without waiting on org search', async () => {
    renderSearch();
    const input = await screen.findByTestId('org-search-input');
    fireEvent.change(input, { target: { value: 'Mail' } });
    expect(await screen.findByTestId('org-search-hit-destination')).toBeTruthy();
    fireEvent.click(screen.getByTestId('org-search-hit-destination'));
    expect(navigate).toHaveBeenCalledWith({ kind: 'home', view: 'mail' });
  });

  it('lists every org app even when org search returns nothing', async () => {
    vi.mocked(registry.fetchAllOrgApps).mockResolvedValue([
      {
        id: 'app-9',
        orgId: 'ws-1',
        orgName: 'Northwind',
        name: 'Expense form',
        description: 'Submit receipts',
        projectId: 'proj-1',
        filePath: 'app.html',
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
      },
    ]);
    renderSearch();
    fireEvent.change(await screen.findByTestId('org-search-input'), {
      target: { value: 'Expense' },
    });
    expect(await screen.findByText('Expense form')).toBeTruthy();
    expect(screen.getByTestId('org-search-hit-app')).toBeTruthy();
  });

  it('lists matching uploaded assets', async () => {
    vi.mocked(registry.fetchLibraryAssets).mockResolvedValue([
      {
        id: 'asset-1',
        kind: 'image',
        storage: 'owned',
        sourceTitle: 'Brand logo',
        capturedAt: 1,
        archivedDate: '2026-08-26',
        contentHash: 'abc',
        tags: ['brand'],
        sources: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    renderSearch();
    fireEvent.change(await screen.findByTestId('org-search-input'), {
      target: { value: 'logo' },
    });
    expect(await screen.findByText('Brand logo')).toBeTruthy();
    expect(screen.getByTestId('org-search-hit-asset')).toBeTruthy();
    fireEvent.click(screen.getByTestId('org-search-hit-asset'));
    expect(navigate).toHaveBeenCalledWith({ kind: 'home', view: 'library' });
  });

  it('offers to scrape a pasted public link into data', async () => {
    vi.spyOn(registry, 'planImportFromUrl').mockResolvedValue({
      source: {
        url: 'https://example.com/pricing',
        finalUrl: 'https://example.com/pricing',
        kind: 'ai',
        fileName: 'pricing.csv',
      },
      plan: {
        tableName: 'pricing',
        displayName: 'Pricing',
        appendingToExisting: false,
        columns: [
          { header: 'Plan', fieldName: 'plan', type: 'text', reason: 'text', sample: ['Pro'] },
        ],
        rowCount: 1,
        skipped: [],
      },
      content: 'plan\nPro\n',
    });
    renderSearch();
    fireEvent.change(await screen.findByTestId('org-search-input'), {
      target: { value: 'https://example.com/pricing' },
    });
    expect(await screen.findByTestId('org-search-hit-import')).toBeTruthy();
    fireEvent.click(screen.getByTestId('org-search-hit-import'));
    expect(await screen.findByTestId('tool-builder')).toBeTruthy();
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    expect(await screen.findByTestId('import-data-preview')).toBeTruthy();
    expect(screen.getByTestId('import-preview-cards').textContent).toContain('Pro');
  });

  it('shows an empty state when nothing matches', async () => {
    renderSearch();
    fireEvent.change(await screen.findByTestId('org-search-input'), {
      target: { value: 'no-such-thing' },
    });
    expect(await screen.findByText(/No matches/, {}, { timeout: 2000 })).toBeTruthy();
  });
});
