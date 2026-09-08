// @vitest-environment jsdom

// The main view. What a person must be able to do the moment it loads:
// ask for visual work, add something new, or build something that does
// not exist yet. Finding records lives on Search.

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
  publicWrite: false,
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
    vi.spyOn(registry, 'fetchWorkspaceTables').mockResolvedValue([INVOICES_TABLE]);
    vi.spyOn(registry, 'fetchHubStatus').mockResolvedValue({
      ready: true,
      tables: [],
      accountCount: 8,
    });
    vi.spyOn(registry, 'fetchRecentRecords').mockResolvedValue([hit('rec-1', 'INV-1001')]);
    vi.spyOn(registry, 'fetchHomeWidgets').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchProposals').mockResolvedValue([]);
    vi.spyOn(registry, 'queryWorkspaceRecords').mockResolvedValue({ records: [], nextCursor: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens on the organization with ask ready', async () => {
    renderHome();
    expect(await screen.findByText('Northwind')).toBeTruthy();
    expect(screen.getByTestId('workspace-search')).toBeTruthy();
    expect(screen.getByTestId('workspace-ask-input')).toBeTruthy();
    expect(screen.getByTestId('workspace-magic-import')).toBeTruthy();
    expect(screen.getByTestId('workspace-create')).toBeTruthy();
    expect(screen.queryByTestId('workspace-new-invoices')).toBeNull();
    expect(screen.queryByText('INV-1001')).toBeNull();
    expect(screen.getByTestId('home-atmosphere')).toBeTruthy();
  });

  it('greets by name on the empty stage', async () => {
    renderHome();
    await screen.findByText('Northwind');
    const greeting = screen.getByTestId('workspace-greeting');
    expect(greeting.getAttribute('aria-hidden')).toBe('false');
    expect(greeting.textContent).toContain('Local');
  });

  it('does not search records from the hub ask box', async () => {
    const searchWorkspace = vi.spyOn(registry, 'searchWorkspace');
    renderHome();
    await screen.findByTestId('workspace-ask-input');
    fireEvent.change(screen.getByTestId('workspace-ask-input'), { target: { value: 'INV-2042' } });
    expect(screen.getByTestId('workspace-ask-input')).toHaveProperty('value', 'INV-2042');
    expect(screen.queryByTestId('workspace-search-results')).toBeNull();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(searchWorkspace).not.toHaveBeenCalled();
  });

  it('keeps a longer ask on the hub', async () => {
    renderHome();
    await screen.findByTestId('workspace-ask-input');
    fireEvent.change(screen.getByTestId('workspace-ask-input'), {
      target: { value: 'Make a 8-slide pitch deck for investors' },
    });
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
    expect(screen.queryByText('INV-1001')).toBeNull();
    expect(screen.getByTestId('workspace-greeting').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('home-atmosphere').parentElement?.getAttribute('data-compact')).toBeNull();
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

  it('offers upload assets from the create menu', async () => {
    renderHome();
    fireEvent.click(await screen.findByTestId('workspace-create'));
    expect(screen.getByTestId('workspace-upload-assets')).toBeTruthy();
  });

  it('opens the tool builder with routes to a new tool including a wiki', async () => {
    renderHome();
    fireEvent.click(await screen.findByTestId('workspace-create'));
    fireEvent.click(await screen.findByTestId('workspace-build-tool'));
    expect(await screen.findByTestId('tool-builder')).toBeTruthy();
    expect(screen.getByTestId('builder-describe')).toBeTruthy();
    expect(screen.getByTestId('builder-import')).toBeTruthy();
    expect(screen.getByTestId('builder-define')).toBeTruthy();
    expect(screen.getByTestId('builder-wiki')).toBeTruthy();
    expect(screen.getByTestId('builder-existing')).toBeTruthy();
  });

  it('builds an app against existing workspace tables instead of creating new ones', async () => {
    const onAskProject = vi.fn().mockResolvedValue(true);
    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <WorkspaceHome active onAskProject={onAskProject} />
        </OrgProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByTestId('workspace-create'));
    fireEvent.click(screen.getByTestId('workspace-build-tool'));
    fireEvent.click(await screen.findByTestId('builder-existing'));
    fireEvent.click(await screen.findByTestId('builder-existing-invoices'));
    fireEvent.click(screen.getByTestId('builder-existing-continue'));
    fireEvent.click(await screen.findByTestId('builder-existing-submit'));
    await waitFor(() => {
      expect(onAskProject).toHaveBeenCalled();
    });
    const payload = onAskProject.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(payload?.prompt).toContain("api.query('invoices'");
    expect(payload?.prompt).toContain('do not create a parallel one');
  });

  function dropFile(file: File, target: Window | Element = window) {
    const dataTransfer = {
      types: ['Files'],
      files: [file],
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      dropEffect: 'none',
      effectAllowed: 'all',
    };
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
  }

  it('shows a drop overlay and plans magic import from a dropped spreadsheet', async () => {
    const planImport = vi.spyOn(registry, 'planImport').mockResolvedValue({
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
    });
    renderHome();
    await screen.findByTestId('workspace-ask-input');
    const file = new File(['Name\nAda\n'], 'customers.csv', { type: 'text/csv' });
    fireEvent.dragOver(window, {
      dataTransfer: { types: ['Files'], files: [], items: [], dropEffect: 'copy' },
    });
    expect(await screen.findByTestId('workspace-import-drop')).toBeTruthy();
    dropFile(file);
    expect(await screen.findByTestId('tool-builder')).toBeTruthy();
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    expect(screen.getByText(/1 row\(s\) into customers/)).toBeTruthy();
    expect(planImport).toHaveBeenCalledWith('ws-1', 'Name\nAda\n', 'customers.csv');
    expect(screen.queryByTestId('workspace-import-drop')).toBeNull();
  });

  it('plans a dropped file from the magic import dropzone', async () => {
    const planImport = vi.spyOn(registry, 'planImport').mockResolvedValue({
      tableName: 'suppliers',
      displayName: 'Suppliers',
      appendingToExisting: false,
      columns: [
        {
          header: 'Name',
          fieldName: 'name',
          type: 'text',
          reason: 'looks like names',
          sample: ['Acme'],
        },
      ],
      rowCount: 1,
      skipped: [],
    });
    renderHome();
    fireEvent.click(await screen.findByTestId('workspace-magic-import'));
    expect(await screen.findByTestId('builder-file-drop')).toBeTruthy();
    const file = new File(['Name\nAcme\n'], 'suppliers.csv', { type: 'text/csv' });
    dropFile(file, screen.getByTestId('builder-file-drop'));
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    expect(planImport).toHaveBeenCalledWith('ws-1', 'Name\nAcme\n', 'suppliers.csv');
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
    fireEvent.click(await screen.findByTestId('workspace-magic-import'));
    fireEvent.change(screen.getByTestId('builder-import-url'), {
      target: { value: 'https://example.com/customers.csv' },
    });
    fireEvent.click(screen.getByTestId('builder-import-url-go'));
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    expect(screen.getByText(/1 row\(s\) into customers/)).toBeTruthy();
    expect(await screen.findByTestId('import-data-preview')).toBeTruthy();
    expect(screen.getByTestId('import-preview-cards').textContent).toContain('Ada');
    expect(screen.getByTestId('import-source-link').getAttribute('href')).toBe(
      'https://example.com/customers.csv',
    );
    expect(planImportFromUrl).toHaveBeenCalledWith('ws-1', 'https://example.com/customers.csv');
  });

  it('after importing a link, offers a custom interface and a refresh schedule', async () => {
    vi.spyOn(registry, 'planImportFromUrl').mockResolvedValue({
      source: {
        url: 'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
        finalUrl: 'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
        kind: 'csv',
        fileName: 'newTenderNotice-nouvelAvisAppelOffres.csv',
      },
      plan: {
        tableName: 'new_tender_notice',
        displayName: 'New tender notice',
        appendingToExisting: false,
        sourceUrl: 'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
        columns: [
          {
            header: 'Title (English)',
            fieldName: 'title_eng',
            type: 'text',
            reason: 'free-form',
            sample: ['NPP support'],
            unique: false,
          },
          {
            header: 'Reference number',
            fieldName: 'reference_number',
            type: 'text',
            reason: 'unique key',
            sample: ['cb-1'],
            unique: true,
          },
        ],
        rowCount: 1,
        skipped: [],
      },
      content: 'title_eng,reference_number\nNPP support,cb-1\n',
    });
    vi.spyOn(registry, 'commitImportPlan').mockResolvedValue({
      tableId: 'tbl-1',
      imported: 1,
      skipped: 0,
    });
    renderHome();
    fireEvent.click(await screen.findByTestId('workspace-magic-import'));
    fireEvent.change(screen.getByTestId('builder-import-url'), {
      target: {
        value: 'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
      },
    });
    fireEvent.click(screen.getByTestId('builder-import-url-go'));
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    fireEvent.click(screen.getByTestId('builder-commit'));
    expect(await screen.findByTestId('import-next-steps')).toBeTruthy();
    expect(screen.getByTestId('import-next-build')).toBeTruthy();
    expect(screen.getByTestId('import-next-refresh')).toBeTruthy();
  });

  it('lets them prompt the builder for a custom interface instead of opening an empty project', async () => {
    const onAskProject = vi.fn().mockResolvedValue(true);
    vi.spyOn(registry, 'planImportFromUrl').mockResolvedValue({
      source: {
        url: 'https://example.com/tenders.csv',
        finalUrl: 'https://example.com/tenders.csv',
        kind: 'csv',
        fileName: 'tenders.csv',
      },
      plan: {
        tableName: 'tenders',
        displayName: 'Tenders',
        appendingToExisting: false,
        sourceUrl: 'https://example.com/tenders.csv',
        columns: [
          {
            header: 'Title',
            fieldName: 'title',
            type: 'text',
            reason: 'free-form',
            sample: ['NPP'],
          },
        ],
        rowCount: 1,
        skipped: [],
      },
      content: 'title\nNPP\n',
    });
    vi.spyOn(registry, 'commitImportPlan').mockResolvedValue({
      tableId: 'tbl-1',
      imported: 1,
      skipped: 0,
    });
    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <WorkspaceHome active onAskProject={onAskProject} />
        </OrgProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByTestId('workspace-magic-import'));
    fireEvent.change(screen.getByTestId('builder-import-url'), {
      target: { value: 'https://example.com/tenders.csv' },
    });
    fireEvent.click(screen.getByTestId('builder-import-url-go'));
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    fireEvent.click(screen.getByTestId('builder-commit'));
    expect(await screen.findByTestId('import-next-steps')).toBeTruthy();
    fireEvent.click(screen.getByTestId('import-next-build'));
    expect(await screen.findByTestId('import-next-build-draft')).toBeTruthy();
    expect(onAskProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('import-next-build-prompt'), {
      target: { value: 'A board of open tenders grouped by closing week' },
    });
    fireEvent.click(screen.getByTestId('import-next-build-submit'));
    await waitFor(() => {
      expect(onAskProject).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('A board of open tenders grouped by closing week'),
          conversationMode: 'design',
        }),
      );
    });
  });

  it('keeps imported tables off the hub', async () => {
    const suppliers = {
      ...INVOICES_TABLE,
      id: 'tbl-sup',
      name: 'suppliers',
      displayName: 'Suppliers',
      fields: [
        {
          id: 'fld-name',
          tableId: 'tbl-sup',
          name: 'name',
          displayName: 'Name',
          type: 'text' as const,
          required: false,
          unique: false,
          config: null,
          position: 0,
          status: 'active' as const,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    vi.spyOn(registry, 'fetchWorkspaceTables').mockResolvedValue([INVOICES_TABLE, suppliers]);
    renderHome();
    await screen.findByTestId('workspace-ask-input');
    await waitFor(() => {
      expect(registry.fetchWorkspaceTables).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('workspace-data-sources')).toBeNull();
    expect(screen.queryByText('Acme Steel')).toBeNull();
    expect(screen.getByTestId('workspace-create')).toBeTruthy();
  });

  it('reports a load failure instead of showing an empty workspace', async () => {
    vi.spyOn(registry, 'fetchWorkspaceTables').mockRejectedValue(new Error('daemon offline'));
    renderHome();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('daemon offline');
  });

  it('asks from the hub and starts a project with the full brief', async () => {
    vi.spyOn(registry, 'interpretIntent').mockResolvedValue({
      kind: 'unsupported',
      summary: 'Ask the assistant',
      confidence: 0,
      operations: [],
      preview: null,
      query: null,
      schemaChange: null,
      unmatched: 'make a pitch deck',
      suggestions: [],
    });
    let finishAsk!: (value: true) => void;
    const onAskProject = vi.fn().mockImplementation(
      () => new Promise<true>((resolve) => {
        finishAsk = resolve;
      }),
    );
    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <WorkspaceHome active onAskProject={onAskProject} />
        </OrgProvider>
      </I18nProvider>,
    );
    await screen.findByTestId('workspace-ask');
    fireEvent.change(screen.getByTestId('workspace-ask-input'), {
      target: { value: 'Make a 8-slide pitch deck for investors' },
    });
    fireEvent.click(screen.getByTestId('workspace-ask-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-home').getAttribute('data-launching')).toBe('true');
    });
    expect(screen.getByTestId('workspace-ask-input')).toHaveProperty('value', 'Make a 8-slide pitch deck for investors');
    finishAsk(true);
    await waitFor(() => {
      expect(onAskProject).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Make a 8-slide pitch deck for investors',
          pluginInputs: { prompt: 'Make a 8-slide pitch deck for investors' },
          conversationMode: 'design',
        }),
      );
    });
  });

  it('turns a pasted public link into an import instead of a design project', async () => {
    const onAskProject = vi.fn();
    const planImportFromUrl = vi.spyOn(registry, 'planImportFromUrl').mockResolvedValue({
      source: {
        url: 'https://example.com/team',
        finalUrl: 'https://example.com/team',
        kind: 'ai',
        fileName: 'team.csv',
      },
      plan: {
        tableName: 'team',
        displayName: 'Team',
        appendingToExisting: false,
        columns: [
          { header: 'Name', fieldName: 'name', type: 'text', reason: 'names', sample: ['Ada'] },
        ],
        rowCount: 2,
        skipped: [],
      },
      content: 'name,role\nAda,eng\n',
    });
    render(
      <I18nProvider initial="en">
        <OrgProvider>
          <WorkspaceHome active onAskProject={onAskProject} />
        </OrgProvider>
      </I18nProvider>,
    );
    await screen.findByTestId('workspace-ask');
    fireEvent.change(screen.getByTestId('workspace-ask-input'), {
      target: { value: 'https://example.com/team' },
    });
    fireEvent.click(screen.getByTestId('workspace-ask-submit'));
    expect(await screen.findByTestId('tool-builder')).toBeTruthy();
    expect(await screen.findByTestId('builder-plan')).toBeTruthy();
    expect(planImportFromUrl).toHaveBeenCalledWith('ws-1', 'https://example.com/team');
    expect(onAskProject).not.toHaveBeenCalled();
  });
});
