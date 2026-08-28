// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { ENTRY_NAV_ORDER_KEY } from '../../src/components/entry-nav-order';
import { I18nProvider } from '../../src/i18n';
import { OrgProvider } from '../../src/org/OrgContext';
import { fetchAllOrgApps, fetchAuthContext, updateOrgApp } from '../../src/providers/registry';
import type { OrgAppWithOrgName } from '@open-design/contracts';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      track: vi.fn(),
    }),
  };
});

vi.mock('../../src/providers/registry', () => ({
  fetchAllOrgApps: vi.fn(async () => []),
  fetchAuthContext: vi.fn(async () => ({
    mode: 'local-owner',
    viewer: { userId: 'u', displayName: 'Ada', email: null, username: null },
    organizations: [],
  })),
  recordOrgAppOpen: vi.fn(async () => {}),
  updateOrgApp: vi.fn(async () => ({})),
}));

if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

function slotIds(): string[] {
  return [...screen.getByTestId('entry-nav-dock').querySelectorAll<HTMLElement>('[data-nav-id]')]
    .map((node) => node.getAttribute('data-nav-id') ?? '');
}

function renderRail(onViewChange = vi.fn()) {
  return render(
    <I18nProvider initial="en">
      <EntryNavRail
        view="home"
        onViewChange={onViewChange}
        onNewProject={vi.fn()}
        open
        onClose={vi.fn()}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(fetchAllOrgApps).mockResolvedValue([]);
  vi.mocked(updateOrgApp).mockResolvedValue({} as never);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('EntryNavRail sidebar', () => {
  it('renders a slim sidebar with the company spine and new project', () => {
    renderRail();
    expect(screen.getByTestId('entry-nav-dock')).toBeTruthy();
    expect(screen.getByTestId('entry-nav-logo')).toBeTruthy();
    expect(screen.getByTestId('entry-nav-new-project')).toBeTruthy();
    expect(screen.getByTestId('entry-nav-logo').closest('[data-nav-id]')).toBeNull();
    expect(screen.getByTestId('entry-nav-new-project').closest('[data-nav-id]')).toBeNull();
    expect(slotIds()[0]).toBe('home');
    expect(slotIds()).toContain('pages');
    expect(slotIds()).not.toContain('search');
    expect(slotIds()).not.toContain('mail');
  });

  it('restores a saved sidebar order', () => {
    window.localStorage.setItem(
      ENTRY_NAV_ORDER_KEY,
      JSON.stringify(['apps', 'home', 'pages']),
    );
    renderRail();
    const ids = slotIds();
    expect(ids.slice(0, 3)).toEqual(['apps', 'home', 'pages']);
  });

  it('nudges a shortcut with Option-Arrow and persists the order', () => {
    renderRail();
    const home = screen.getByTestId('entry-nav-home');
    fireEvent.keyDown(home, { key: 'ArrowDown', altKey: true });
    expect(slotIds().slice(0, 2)).toEqual(['pages', 'home']);
    const stored = JSON.parse(window.localStorage.getItem(ENTRY_NAV_ORDER_KEY) ?? '[]') as string[];
    expect(stored.slice(0, 2)).toEqual(['pages', 'home']);
  });

  it('navigates on a plain click', () => {
    const onViewChange = vi.fn();
    renderRail(onViewChange);
    fireEvent.click(screen.getByTestId('entry-nav-pages'));
    expect(onViewChange).toHaveBeenCalledWith('pages');
  });

  it('still clicks through when the pointer barely moves', () => {
    const onViewChange = vi.fn();
    renderRail(onViewChange);
    const slot = screen.getByTestId('entry-nav-slot-pages');
    fireEvent.pointerDown(slot, { button: 0, clientX: 8, clientY: 8, pointerId: 1 });
    fireEvent.pointerMove(window, {
      clientX: 16,
      clientY: 12,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(screen.getByTestId('entry-nav-pages'));
    expect(onViewChange).toHaveBeenCalledWith('pages');
  });

  it('reorders a shortcut by dragging onto another row', () => {
    renderRail();
    const appsSlot = screen.getByTestId('entry-nav-slot-apps');
    const homeSlot = screen.getByTestId('entry-nav-slot-home');
    const homeRect = { top: 40, height: 36 };
    vi.spyOn(homeSlot, 'getBoundingClientRect').mockReturnValue({
      top: homeRect.top,
      bottom: homeRect.top + homeRect.height,
      height: homeRect.height,
      left: 0,
      right: 40,
      width: 40,
      x: 0,
      y: homeRect.top,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerDown(appsSlot, { button: 0, clientX: 10, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(window, {
      clientX: 10,
      clientY: 48,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 10,
      clientY: 48,
    });
    expect(slotIds()[0]).toBe('apps');
  });

  it('removes a shortcut from the context menu and can add it back', () => {
    renderRail();
    fireEvent.contextMenu(screen.getByTestId('entry-nav-slot-pages'));
    fireEvent.click(screen.getByTestId('entry-nav-dock-remove'));
    expect(slotIds()).not.toContain('pages');

    fireEvent.click(screen.getByTestId('entry-nav-dock-add'));
    fireEvent.click(screen.getByTestId('entry-nav-dock-add-pages'));
    expect(slotIds().at(-1)).toBe('pages');
  });

  it('lets the user add Mail to the sidebar without connecting first', async () => {
    renderRail();
    expect(slotIds()).not.toContain('mail');
    fireEvent.click(screen.getByTestId('entry-nav-dock-add'));
    fireEvent.click(await screen.findByTestId('entry-nav-dock-add-mail'));
    expect(slotIds()).toContain('mail');
  });

  it('offers unpinned apps in the customize menu', async () => {
    vi.mocked(fetchAllOrgApps).mockResolvedValueOnce([{
      id: 'app-1',
      orgId: 'org-1',
      orgName: 'Acme',
      name: 'Expense form',
      description: null,
      projectId: 'proj-1',
      filePath: 'app.html',
      visibility: 'org',
      status: 'active',
      accessMode: 'org',
      pinned: false,
      pinnedAt: null,
      createdBy: 'user-1',
      createdByName: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      dataScopes: [],
      webUrl: null,
    }]);
    renderRail();
    fireEvent.click(await screen.findByTestId('entry-nav-dock-add'));
    fireEvent.click(await screen.findByTestId('entry-nav-dock-add-pinned:app-1'));
    expect(slotIds()).toContain('pinned:app-1');
    await waitFor(() => {
      expect(updateOrgApp).toHaveBeenCalledWith('org-1', 'app-1', { pinned: true });
    });
  });

  it('keeps every pinned app on the sidebar', async () => {
    const apps: OrgAppWithOrgName[] = Array.from({ length: 10 }, (_, index) => ({
      id: `app-${index + 1}`,
      orgId: 'org-1',
      orgName: 'Acme',
      name: `App ${index + 1}`,
      description: null,
      projectId: 'proj-1',
      filePath: 'app.html',
      visibility: 'org',
      status: 'active',
      accessMode: 'org',
      pinned: true,
      pinnedAt: index + 1,
      createdBy: 'user-1',
      createdByName: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      dataScopes: [],
      webUrl: null,
    }));
    vi.mocked(fetchAllOrgApps).mockResolvedValueOnce(apps);
    renderRail();
    await waitFor(() => {
      expect(screen.getByTestId('entry-nav-slot-pinned:app-10')).toBeTruthy();
    });
    expect(screen.getByTestId('entry-nav-slot-pinned:app-1')).toBeTruthy();
    expect(slotIds().filter((id) => id.startsWith('pinned:'))).toHaveLength(10);
    fireEvent.pointerEnter(screen.getByTestId('entry-nav-slot-pinned:app-4'));
    expect(screen.getByRole('tooltip').textContent).toBe('App 4');
  });

  it('opens Places from the org mark', () => {
    const onViewChange = vi.fn();
    renderRail(onViewChange);
    fireEvent.click(screen.getByTestId('entry-nav-logo'));
    expect(screen.getByTestId('entry-nav-atlas')).toBeTruthy();
    expect(screen.getByTestId('entry-nav-island-work')).toBeTruthy();
    fireEvent.click(screen.getByTestId('entry-nav-atlas-pages'));
    expect(onViewChange).toHaveBeenCalledWith('pages');
  });

  it('pins a place onto the sidebar from Places', () => {
    renderRail();
    fireEvent.click(screen.getByTestId('entry-nav-logo'));
    fireEvent.click(screen.getByTestId('entry-nav-pin-mail'));
    expect(slotIds()).toContain('mail');
  });
});

describe('EntryNavRail company mark', () => {
  it('replaces the Substrate glyph with the harvested org mark', async () => {
    vi.mocked(fetchAuthContext).mockResolvedValue({
      mode: 'clerk',
      viewer: {
        userId: 'user-1',
        displayName: 'Ada',
        email: 'ada@acme.com',
        username: 'ada',
        bio: null,
        avatarUrl: null,
      },
      organizations: [
        {
          id: 'ws-1',
          name: 'Acme',
          createdBy: 'user-1',
          createdAt: 1,
          updatedAt: 1,
          websiteUrl: 'https://stripe.com',
          defaultDesignSystemId: null,
          setupCompletedAt: 1,
          role: 'owner',
          memberCount: 1,
        },
      ],
    });

    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <EntryNavRail
            view="workspace"
            onViewChange={vi.fn()}
            onNewProject={vi.fn()}
            open
            onClose={vi.fn()}
          />
        </OrgProvider>
      </I18nProvider>,
    );

    const logo = await waitFor(() => {
      const node = screen.getByTestId('entry-nav-logo').querySelector('img');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(logo.getAttribute('src')).toBe('/api/orgs/ws-1/mark?v=1');
    expect(screen.getByTestId('entry-nav-logo').getAttribute('aria-label')).toContain('Acme');
  });
});
