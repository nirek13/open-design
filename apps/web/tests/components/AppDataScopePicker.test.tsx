/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_GMAIL_SCOPE_TABLE } from '@open-design/contracts';

import {
  AppDataScopePicker,
  applyOrgDataWriteConsent,
  grantReadOnExistingTables,
  setTableAccessMode,
  splitGmailScope,
  tableAccessMode,
  withGmailScope,
} from '../../src/components/apps/AppDataScopePicker';
import { I18nProvider } from '../../src/i18n';
import * as registry from '../../src/providers/registry';

const LEADS = {
  id: 'tbl-leads',
  name: 'leads',
  displayName: 'Leads',
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

describe('app data scope helpers', () => {
  it('treats write as covering read, and off as a revoke', () => {
    const write = setTableAccessMode([], 'leads', 'write');
    expect(tableAccessMode(write, 'leads')).toBe('write');
    expect(setTableAccessMode(write, 'leads', 'off')).toEqual([]);
  });

  it('keeps gmail as its own grant so a table list cannot drop it by accident', () => {
    const withMail = withGmailScope([{ table: 'leads', mode: 'write' }], true);
    expect(withMail).toEqual([
      { table: 'leads', mode: 'write' },
      { table: APP_GMAIL_SCOPE_TABLE, mode: 'write' },
    ]);
    expect(splitGmailScope(withMail)).toEqual({
      tables: [{ table: 'leads', mode: 'write' }],
      allowGmail: true,
    });
  });

  it('grants inferred writes only after org-data consent, and demotes them when withdrawn', () => {
    const inferred = [{ table: 'leads', mode: 'write' as const }];
    expect(applyOrgDataWriteConsent([], inferred, true)).toEqual([{ table: 'leads', mode: 'write' }]);
    expect(applyOrgDataWriteConsent([{ table: 'leads', mode: 'write' }], inferred, false)).toEqual([
      { table: 'leads', mode: 'read' },
    ]);
  });

  it('adds read on existing tables without demoting a write already granted', () => {
    expect(
      grantReadOnExistingTables([{ table: 'leads', mode: 'write' }], [{ name: 'leads' }, { name: 'invoices' }]),
    ).toEqual([
      { table: 'leads', mode: 'write' },
      { table: 'invoices', mode: 'read' },
    ]);
  });
});

describe('AppDataScopePicker', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lets someone grant write on a workspace table', async () => {
    vi.spyOn(registry, 'fetchWorkspaceTables').mockResolvedValue([LEADS]);
    const onChange = vi.fn();

    render(
      <I18nProvider initial="en">
        <AppDataScopePicker orgId="ws-1" value={[]} onChange={onChange} />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('app-scope-leads-write'));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([{ table: 'leads', mode: 'write' }]);
    });
  });

  it('lists inferred tables that are not in the workspace yet, and grants read on every existing table', async () => {
    const invoices = { ...LEADS, id: 'tbl-invoices', name: 'invoices', displayName: 'Invoices' };
    vi.spyOn(registry, 'fetchWorkspaceTables').mockResolvedValue([LEADS, invoices]);
    const onChange = vi.fn();

    render(
      <I18nProvider initial="en">
        <AppDataScopePicker
          orgId="ws-1"
          value={[]}
          onChange={onChange}
          suggested={[{ table: 'prospects', mode: 'read' }]}
        />
      </I18nProvider>,
    );

    expect(await screen.findByTestId('app-scope-prospects-read')).toBeTruthy();
    fireEvent.click(screen.getByTestId('app-scope-read-all'));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        { table: 'leads', mode: 'read' },
        { table: 'invoices', mode: 'read' },
      ]);
    });
  });
});
