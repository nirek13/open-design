// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TablesView } from '../../src/components/grid/TablesView';
import { I18nProvider } from '../../src/i18n';
import { OrgProvider } from '../../src/org/OrgContext';
import * as registry from '../../src/providers/registry';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

function field(id: string, name: string, displayName: string, tableId: string) {
  return {
    id,
    tableId,
    name,
    displayName,
    type: 'text' as const,
    required: false,
    unique: false,
    config: null,
    position: 0,
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

function table(id: string, name: string, displayName: string) {
  return {
    id,
    name,
    displayName,
    description: null,
    status: 'active' as const,
    schemaVersion: 1,
    protection: 'open' as const,
    publicWrite: false,
    createdBy: 'wsm-1',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    fields: [field(`fld-${id}`, 'name', 'Name', id)],
  };
}

const INVOICES = table('tbl-inv', 'invoices', 'Invoices');
const SUPPLIERS = table('tbl-sup', 'suppliers', 'Suppliers');

const DEFAULT_VIEW = {
  id: 'view-1',
  orgId: 'ws-1',
  tableId: SUPPLIERS.id,
  name: 'All',
  kind: 'table' as const,
  filters: [],
  sorts: [],
  groupBy: null,
  dateField: null,
  visibleFields: null,
  position: 0,
  isDefault: true,
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
};

function renderTables(initialTableName?: string) {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <TablesView active {...(initialTableName ? { initialTableName } : {})} />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('TablesView', () => {
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
    vi.spyOn(registry, 'fetchWorkspaceTables').mockResolvedValue([INVOICES, SUPPLIERS]);
    vi.spyOn(registry, 'fetchViews').mockResolvedValue([DEFAULT_VIEW]);
    vi.spyOn(registry, 'fetchViewRecords').mockResolvedValue({
      view: DEFAULT_VIEW,
      records: [
        { id: 'rec-1', data: { name: 'Acme Steel' }, revision: 1, updatedAt: 1 },
      ],
      groups: null,
      nextCursor: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens a named table as cards of the actual rows', async () => {
    renderTables('suppliers');
    expect(await screen.findByTestId('tables-view')).toBeTruthy();
    expect(await screen.findByText('Acme Steel')).toBeTruthy();
    expect(screen.getByTestId('record-gallery')).toBeTruthy();
    expect(screen.getByTestId('tables-pick-suppliers').getAttribute('aria-current')).toBe('true');
  });

  it('lets someone mark the open table as a public form', async () => {
    const patch = vi.spyOn(registry, 'patchWorkspaceTable').mockResolvedValue({
      ...SUPPLIERS,
      publicWrite: true,
    });
    renderTables('suppliers');
    const toggle = await screen.findByTestId('tables-public-write');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith('ws-1', SUPPLIERS.id, { publicWrite: true });
    });
  });

  it('can switch from cards to a table grid', async () => {
    renderTables('suppliers');
    await screen.findByTestId('record-gallery');
    fireEvent.click(screen.getByTestId('tables-layout-table'));
    expect(await screen.findByTestId('editable-grid')).toBeTruthy();
    expect(screen.queryByTestId('record-gallery')).toBeNull();
  });
});
