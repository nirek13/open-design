// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchPalette } from '../../src/components/search/SearchView';
import { I18nProvider } from '../../src/i18n';
import { OrgProvider } from '../../src/org/OrgContext';
import * as registry from '../../src/providers/registry';

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

function renderPalette(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <I18nProvider initial="en">
        <OrgProvider>
          <SearchPalette open onClose={onClose} />
        </OrgProvider>
      </I18nProvider>,
    ),
  };
}

describe('SearchPalette', () => {
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

  it('focuses the field and closes on Escape', async () => {
    const { onClose } = renderPalette();
    const input = await screen.findByTestId('org-search-palette-input');
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('searches from the palette', async () => {
    renderPalette();
    fireEvent.change(await screen.findByTestId('org-search-palette-input'), {
      target: { value: 'handbook' },
    });
    await waitFor(() => {
      expect(registry.searchOrg).toHaveBeenCalledWith('ws-1', 'handbook');
    });
  });
});
