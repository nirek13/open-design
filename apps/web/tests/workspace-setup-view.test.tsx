// @vitest-environment jsdom

// After sign-up the person has to pick join or create, and a pasted invite
// URL has to work the same as a bare code. Creating a workspace then offers
// brand and a skippable import so the company is not dropped into empty tables.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSetupView } from '../src/components/org/WorkspaceSetupView';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';
import { navigate } from '../src/router';

vi.mock('../src/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/router')>();
  return { ...actual, navigate: vi.fn() };
});

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

const pendingOrg = {
  id: 'ws-new',
  name: 'Acme',
  createdBy: 'user-1',
  createdAt: 1,
  updatedAt: 1,
  websiteUrl: null as string | null,
  defaultDesignSystemId: null as string | null,
  setupCompletedAt: null as number | null,
  role: 'owner' as const,
  memberCount: 1,
};

const PLAN = {
  tableName: 'customers',
  displayName: 'Customers',
  appendingToExisting: false,
  columns: [
    { header: 'Name', fieldName: 'name', type: 'text' as const, reason: 'text', sample: ['Ada'] },
  ],
  rowCount: 2,
  skipped: [],
};

function renderSetup() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <WorkspaceSetupView />
      </OrgProvider>
    </I18nProvider>,
  );
}

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

    renderSetup();

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
        organizations: [pendingOrg],
      });

    renderSetup();

    fireEvent.click(await screen.findByTestId('setup-choose-create'));
    fireEvent.change(screen.getByTestId('setup-create-name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('setup-create-submit'));
    expect(await screen.findByTestId('setup-brand-url')).toBeTruthy();
  });

  it('replaces the Substrate mark with a site favicon once the website looks real', async () => {
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      ...emptyAuth,
      organizations: [pendingOrg],
    });

    renderSetup();

    const logo = await screen.findByTestId('setup-logo');
    expect(logo.tagName).toBe('SPAN');
    expect(logo.className).toContain('od-brand-glyph');

    fireEvent.change(await screen.findByTestId('setup-brand-url'), {
      target: { value: 'stripe.com' },
    });
    const favicon = screen.getByTestId('setup-logo');
    expect(favicon.tagName).toBe('IMG');
    expect(favicon.getAttribute('src')).toContain('domain=stripe.com');
  });

  it('offers a skippable data import after the website step', async () => {
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      ...emptyAuth,
      organizations: [pendingOrg],
    });
    const update = vi.spyOn(registry, 'updateOrganization').mockResolvedValue({
      ...pendingOrg,
      setupCompletedAt: 2,
    });

    renderSetup();

    fireEvent.click(await screen.findByTestId('setup-brand-skip'));
    expect(await screen.findByTestId('setup-import-url')).toBeTruthy();

    fireEvent.click(screen.getByTestId('setup-import-skip'));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('ws-new', expect.objectContaining({ setupCompleted: true }));
      expect(navigate).toHaveBeenCalledWith({ kind: 'home', view: 'workspace' });
    });
  });

  it('imports a pasted spreadsheet link during setup and opens the table', async () => {
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      ...emptyAuth,
      organizations: [pendingOrg],
    });
    vi.spyOn(registry, 'planImportFromUrl').mockResolvedValue({
      source: {
        url: 'https://example.com/customers.csv',
        finalUrl: 'https://example.com/customers.csv',
        kind: 'csv',
        fileName: 'customers.csv',
      },
      plan: PLAN,
      content: 'name\nAda\nGrace',
    });
    const commit = vi.spyOn(registry, 'commitImportPlan').mockResolvedValue({
      tableId: 'tbl-1',
      imported: 2,
      skipped: 0,
    });
    vi.spyOn(registry, 'updateOrganization').mockResolvedValue({
      ...pendingOrg,
      setupCompletedAt: 2,
    });

    renderSetup();
    fireEvent.click(await screen.findByTestId('setup-brand-skip'));
    fireEvent.change(await screen.findByTestId('setup-import-url'), {
      target: { value: 'https://example.com/customers.csv' },
    });
    fireEvent.click(screen.getByTestId('setup-import-url-go'));
    expect(await screen.findByTestId('setup-import-plan')).toBeTruthy();
    fireEvent.click(screen.getByTestId('setup-import-submit'));
    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith('ws-new', PLAN, 'name\nAda\nGrace');
    });
    expect(await screen.findByTestId('import-next-steps')).toBeTruthy();
    fireEvent.click(screen.getByTestId('setup-import-submit'));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        kind: 'home',
        view: 'tables',
        tableName: 'customers',
      });
    });
  });

  it('lets them connect existing tools instead of importing a file', async () => {
    vi.spyOn(registry, 'fetchPendingInvites').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      ...emptyAuth,
      organizations: [pendingOrg],
    });
    vi.spyOn(registry, 'updateOrganization').mockResolvedValue({
      ...pendingOrg,
      setupCompletedAt: 2,
    });

    renderSetup();
    fireEvent.click(await screen.findByTestId('setup-brand-skip'));
    fireEvent.click(await screen.findByTestId('setup-import-connect'));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ kind: 'home', view: 'integrations' });
    });
  });
});
