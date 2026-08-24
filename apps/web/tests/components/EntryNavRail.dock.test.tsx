// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { ENTRY_NAV_ORDER_KEY } from '../../src/components/entry-nav-order';
import { I18nProvider } from '../../src/i18n';
import { fetchAllOrgApps } from '../../src/providers/registry';
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
  recordOrgAppOpen: vi.fn(async () => {}),
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
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('EntryNavRail dock reorder', () => {
  it('renders destinations in a reorderable dock, with logo and new project pinned', () => {
    renderRail();
    expect(screen.getByTestId('entry-nav-dock')).toBeTruthy();
    expect(screen.getByTestId('entry-nav-logo')).toBeTruthy();
    expect(screen.getByTestId('entry-nav-new-project')).toBeTruthy();
    expect(screen.getByTestId('entry-nav-logo').closest('[data-nav-id]')).toBeNull();
    expect(screen.getByTestId('entry-nav-new-project').closest('[data-nav-id]')).toBeNull();
    expect(slotIds()[0]).toBe('search');
    expect(slotIds()).toContain('home');
    expect(slotIds()).toContain('pages');
  });

  it('restores a saved dock order', () => {
    window.localStorage.setItem(
      ENTRY_NAV_ORDER_KEY,
      JSON.stringify(['home', 'pages', 'erp']),
    );
    renderRail();
    const ids = slotIds();
    expect(ids.slice(0, 3)).toEqual(['home', 'pages', 'erp']);
  });

  it('nudges an icon with Option-Arrow and persists the order', () => {
    renderRail();
    const home = screen.getByTestId('entry-nav-home');
    const before = slotIds();
    const homeIndex = before.indexOf('home');
    fireEvent.keyDown(home, { key: 'ArrowDown', altKey: true });
    const after = slotIds();
    expect(after[homeIndex + 1]).toBe('home');
    expect(after[homeIndex]).toBe(before[homeIndex + 1]);
    const stored = JSON.parse(window.localStorage.getItem(ENTRY_NAV_ORDER_KEY) ?? '[]') as string[];
    expect(stored).toEqual(after);
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

  it('reorders by dragging one icon onto another', () => {
    renderRail();
    const erpSlot = screen.getByTestId('entry-nav-slot-erp');
    const homeSlot = screen.getByTestId('entry-nav-slot-home');
    vi.spyOn(homeSlot, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 200,
      top: 200,
      bottom: 240,
      left: 0,
      right: 38,
      width: 38,
      height: 40,
      toJSON: () => ({}),
    });
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => homeSlot;

    fireEvent.pointerDown(erpSlot, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, {
      clientX: 10,
      clientY: 230,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 10,
      clientY: 230,
    });

    document.elementFromPoint = originalFromPoint ?? (() => null);
    const ids = slotIds();
    expect(ids.indexOf('erp')).toBeGreaterThan(ids.indexOf('home'));
  });

  it('removes an icon from the context menu and can add it back', () => {
    renderRail();
    fireEvent.contextMenu(screen.getByTestId('entry-nav-slot-mail'));
    fireEvent.click(screen.getByTestId('entry-nav-dock-remove'));
    expect(slotIds()).not.toContain('mail');

    fireEvent.click(screen.getByTestId('entry-nav-dock-add'));
    fireEvent.click(screen.getByTestId('entry-nav-dock-add-mail'));
    expect(slotIds().at(-1)).toBe('mail');
  });

  it('keeps every pinned app in the scrollable dock wheel', async () => {
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
    const dock = screen.getByTestId('entry-nav-dock');
    expect(slotIds().filter((id) => id.startsWith('pinned:'))).toHaveLength(10);
    fireEvent.pointerEnter(screen.getByTestId('entry-nav-slot-pinned:app-4'));
    expect(screen.getByRole('tooltip').textContent).toBe('App 4');
    expect(dock.className).toContain('entry-nav-rail__dock');
  });
});
