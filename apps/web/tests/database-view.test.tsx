// @vitest-environment jsdom

// The Database tab is the user-facing window onto the permanent workspace
// data plane. These cover the guarantees a reader of the UI must be able to
// trust: tables and records load for the selected workspace, soft-deleted rows
// stay visible-but-marked rather than vanishing from history, and the audit
// trail is surfaced alongside the data.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseView } from '../src/components/database/DatabaseView';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';

const ORG = {
  id: 'ws-1',
  name: 'Company Workspace',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

const TABLE = {
  id: 'tbl-1',
  name: 'employees',
  displayName: 'Employees',
  description: null,
  status: 'active' as const,
  schemaVersion: 1,
  protection: 'open' as const,
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  fields: [
    {
      id: 'fld-1',
      tableId: 'tbl-1',
      name: 'full_name',
      displayName: 'Full name',
      type: 'text' as const,
      required: true,
      unique: false,
      config: null,
      position: 0,
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

function makeRecord(id: string, fullName: string, deletedAt: number | null) {
  return {
    id,
    tableId: 'tbl-1',
    data: { full_name: fullName },
    revision: deletedAt ? 2 : 1,
    createdByKind: 'user' as const,
    createdById: 'wsm-1',
    createdAt: 1,
    updatedAt: 1,
    deletedAt,
  };
}

function renderView() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <DatabaseView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('DatabaseView', () => {
  beforeEach(() => {
    // EventSource is only available in a browser; the view opens one for live
    // record updates.
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener() {}
        removeEventListener() {}
        close() {}
      },
    );
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchWorkspaceTables').mockResolvedValue([TABLE]);
    vi.spyOn(registry, 'fetchWorkspaceAuditEvents').mockResolvedValue({
      events: [
        {
          id: 'aud-1',
          actorKind: 'agent',
          actorMemberId: null,
          toolId: null,
          runId: 'run-7',
          projectId: 'proj-1',
          op: 'record.create',
          subjectKind: 'record',
          subjectId: 'rec-1',
          tableId: 'tbl-1',
          summary: null,
          patch: null,
          createdAt: 1,
        },
      ],
      nextCursor: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads the workspace tables and their records', async () => {
    vi.spyOn(registry, 'queryWorkspaceRecords').mockResolvedValue({
      records: [makeRecord('rec-1', 'Ada Lovelace', null)],
      nextCursor: null,
    });

    renderView();

    // The table name appears in both the sidebar list and the panel heading.
    expect((await screen.findAllByText('Employees')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    await waitFor(() => {
      expect(registry.queryWorkspaceRecords).toHaveBeenCalledWith(
        'ws-1',
        'tbl-1',
        expect.objectContaining({ includeDeleted: false }),
      );
    });
  });

  it('marks soft-deleted records instead of hiding their history', async () => {
    vi.spyOn(registry, 'queryWorkspaceRecords').mockResolvedValue({
      records: [makeRecord('rec-2', 'Grace Hopper', 1700)],
      nextCursor: null,
    });

    renderView();

    expect(await screen.findByText('Grace Hopper')).toBeTruthy();
    // A deleted row offers Restore, never a permanent delete.
    expect(await screen.findByText('Restore')).toBeTruthy();
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('surfaces the audit trail with its actor attribution', async () => {
    vi.spyOn(registry, 'queryWorkspaceRecords').mockResolvedValue({
      records: [makeRecord('rec-1', 'Ada Lovelace', null)],
      nextCursor: null,
    });

    renderView();

    expect(await screen.findByText('Audit trail')).toBeTruthy();
    expect(await screen.findByText('record.create')).toBeTruthy();
    // Agent writes are attributable to the run that made them.
    expect(await screen.findByText(/agent · run-7/)).toBeTruthy();
  });

  it('reports a load failure instead of rendering an empty database', async () => {
    vi.spyOn(registry, 'fetchWorkspaceTables').mockRejectedValue(new Error('daemon offline'));
    vi.spyOn(registry, 'queryWorkspaceRecords').mockResolvedValue({ records: [], nextCursor: null });

    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('daemon offline');
  });
});
