import { describe, expect, it } from 'vitest';
import {
  APP_GMAIL_SCOPE_TABLE,
  alignAppScopesToTables,
  inferAppScopesFromHtml,
} from '../src/api/app-runtime.js';

describe('inferAppScopesFromHtml', () => {
  it('treats query/describe as read and create/update as write', () => {
    expect(
      inferAppScopesFromHtml(`
        const api = window.od;
        await api.describe('leads');
        await api.query('leads', { limit: 20 });
        await api.create('leads', { name });
        await od.update('invoices', id, { status: 'paid' });
      `),
    ).toEqual([
      { table: 'leads', mode: 'write' },
      { table: 'invoices', mode: 'write' },
    ]);
  });

  it('keeps read-only tables when the page never writes them', () => {
    expect(inferAppScopesFromHtml(`await od.query('tenders', { limit: 200 })`)).toEqual([
      { table: 'tenders', mode: 'read' },
    ]);
  });

  it('detects Gmail send without treating it as a workspace table', () => {
    expect(inferAppScopesFromHtml(`await api.mail.send({ to, subject, body })`)).toEqual([
      { table: APP_GMAIL_SCOPE_TABLE, mode: 'write' },
    ]);
  });

  it('ignores lookalike property access', () => {
    expect(inferAppScopesFromHtml('<p>Load the food.query report</p>')).toEqual([]);
    expect(inferAppScopesFromHtml('period.query = true')).toEqual([]);
  });
});

describe('alignAppScopesToTables', () => {
  const leads = { name: 'leads', displayName: 'Leads' };
  const invoices = { name: 'invoices', displayName: 'Invoices' };

  it('rewrites display names and mismatched casing onto the live table name', () => {
    expect(
      alignAppScopesToTables(
        [
          { table: 'Leads', mode: 'read' },
          { table: 'INVOICES', mode: 'write' },
        ],
        [leads, invoices],
      ),
    ).toEqual([
      { table: 'leads', mode: 'read' },
      { table: 'invoices', mode: 'write' },
    ]);
  });

  it('leaves unmatched names and Gmail alone so a missing table can still be granted', () => {
    expect(
      alignAppScopesToTables(
        [
          { table: 'prospects', mode: 'read' },
          { table: APP_GMAIL_SCOPE_TABLE, mode: 'write' },
        ],
        [leads],
      ),
    ).toEqual([
      { table: 'prospects', mode: 'read' },
      { table: APP_GMAIL_SCOPE_TABLE, mode: 'write' },
    ]);
  });
});
