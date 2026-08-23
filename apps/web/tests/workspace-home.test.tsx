// @vitest-environment jsdom

// The main view. What a person must be able to do the moment it loads:
// find something they already have, add something new, or build something
// that does not exist yet.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceHome } from '../src/components/workspace-home/WorkspaceHome';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

const INVOICES_TABLE = {
  id: 'tbl-inv',
  name: 'invoices',
  displayName: 'Invoices',
  description: null,
  status: 'active' as const,
  schemaVersion: 1,
  protection: 'open' as const,
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  fields: [],
};

function hit(recordId: string, label: string) {
  return {
    tableId: 'tbl-inv',
    tableName: 'invoices',
    tableDisplayName: 'Invoices',
    recordId,
    label,
    secondary: 'sent · 1200.00',
    matchedField: 'invoice_number',
    updatedAt: Date.now(),
  };
}

function renderHome() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <WorkspaceHome active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('WorkspaceHome', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchWorkspaceTables').mockResolvedValue([INVOICES_TABLE]);
    vi.spyOn(registry, 'fetchHubStatus').mockResolvedValue({
      ready: true,
      tables: [],
      accountCount: 8,
    });
    vi.spyOn(registry, 'fetchRecentRecords').mockResolvedValue([hit('rec-1', 'INV-1001')]);
    vi.spyOn(registry, 'fetchHomeWidgets').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchProposals').mockResolvedValue([]);
    vi.spyOn(registry, 'searchWorkspace').mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens on the organization with search ready and recent work shown', async () => {
    renderHome();
    expect(await screen.findByText('Northwind')).toBeTruthy();
    // Recent work is what you see before typing anything.
    expect(await screen.findByText('INV-1001')).toBeTruthy();
    expect(screen.getByTestId('workspace-search')).toBeTruthy();
  });

  it('searches across everything as you type', async () => {
    vi.spyOn(registry, 'searchWorkspace').mockResolvedValue([
      {
        tableId: 'tbl-inv',
        tableName: 'invoices',
        tableDisplayName: 'Invoices',
        hits: [hit('rec-9', 'INV-2042')],
        total: 1,
      },
    ]);
    renderHome();
    await screen.findByTestId('workspace-search');
    fireEvent.change(screen.getByTestId('workspace-search'), { target: { value: 'INV-2042' } });
    expect(await screen.findByText('INV-2042')).toBeTruthy();
    await waitFor(() => {
      expect(registry.searchWorkspace).toHaveBeenCalledWith('ws-1', 'INV-2042');
    });
  });

  it('says so plainly when nothing matches', async () => {
    renderHome();
    await screen.findByTestId('workspace-search');
    fireEvent.change(screen.getByTestId('workspace-search'), { target: { value: 'nothing here' } });
    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
  });

  it('offers to set up the business when it has not been set up', async () => {
    vi.spyOn(registry, 'fetchHubStatus').mockResolvedValue({
      ready: false,
      tables: [],
      accountCount: 0,
    });
    renderHome();
    expect(await screen.findByTestId('workspace-hub-setup')).toBeTruthy();
    expect(screen.getByText('Set it up')).toBeTruthy();
  });

  it('surfaces pending approvals with their preview', async () => {
    vi.spyOn(registry, 'fetchProposals').mockResolvedValue([
      {
        id: 'prop-1',
        orgId: 'ws-1',
        intent: 'Add PO numbers to orders',
        origin: 'agent',
        runId: null,
        status: 'pending',
        operations: [],
        preview: {
          lines: [{ summary: 'Add "po_number" to Orders', detail: 'type: text' }],
          warnings: [],
        },
        appliedEffects: [],
        error: null,
        createdBy: 'wsm-1',
        decidedBy: null,
        decidedAt: null,
        appliedAt: null,
        undoneAt: null,
        createdAt: Date.now(),
      },
    ]);
    renderHome();
    expect(await screen.findByTestId('workspace-proposals')).toBeTruthy();
    expect(screen.getByText('Add PO numbers to orders')).toBeTruthy();
    // The preview is on screen, so approving is a decision about a described
    // outcome rather than a leap of faith.
    expect(screen.getByText(/Add "po_number" to Orders/)).toBeTruthy();
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  it('opens the tool builder with routes to a new tool including a wiki', async () => {
    renderHome();
    fireEvent.click(await screen.findByTestId('workspace-build-tool'));
    expect(await screen.findByTestId('tool-builder')).toBeTruthy();
    expect(screen.getByTestId('builder-describe')).toBeTruthy();
    expect(screen.getByTestId('builder-import')).toBeTruthy();
    expect(screen.getByTestId('builder-define')).toBeTruthy();
    expect(screen.getByTestId('builder-wiki')).toBeTruthy();
  });

  it('plans a magic import from a public link before writing', async () => {
    const planImportFromUrl = vi.spyOn(registry, 'planImportFromUrl').mockResolvedValue({
      source: {
        url: 'https://example.com/customers.csv',
        finalUrl: 'https://example.com/customers.csv',
        kind: 'csv',
        fileName: 'customers.csv',
      },
      plan: {
        tableName: 'customers',
        displayName: 'Customers',
        appendingToExisting: false,
        columns: [
          {
            header: 'Name',
            fieldName: 'name',
            type: 'text',
            reason: 'looks like names',
            sample: ['Ada'],
          },
        ],
        rowCount: 1,
        skipped: [],
      },
      content: 'Name\nAda\n',
    });
    renderHome();
    fireEvent.click(await screen.findByTestId('workspace-build-tool'));
    fireEvent.click(await screen.findByTestId('builder-import'));
    fireEvent.change(screen.getByTestId('builder-import-url'), {
      target: { value: 'https://example.com/customers.csv' },
    });
    fireEvent.click(screen.getByTestId('builder-import-url-go'));
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    expect(screen.getByText(/1 row\(s\) into customers/)).toBeTruthy();
    expect(planImportFromUrl).toHaveBeenCalledWith('ws-1', 'https://example.com/customers.csv');
  });

  it('reports a load failure instead of showing an empty workspace', async () => {
    vi.spyOn(registry, 'fetchWorkspaceTables').mockRejectedValue(new Error('daemon offline'));
    renderHome();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('daemon offline');
  });
});
