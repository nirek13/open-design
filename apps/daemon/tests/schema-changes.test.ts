// Changing a schema that already holds data.
//
// A rename rewrites every record document, rebuilds an index, and updates
// formulas and views. A retype converts or drops values. These are the
// operations that can lose a customer's data, so the tests are written around
// what must survive and what must be refused.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { setUpBusinessHub } from '../src/workspace-data/hub.js';
import {
  blastRadius,
  coerceToType,
  removeField,
  renameField,
  reorderFields,
  restoreField,
  retypeField,
  updateFieldConfig,
} from '../src/workspace-data/schema-changes.js';
import { createTable, loadTableByName } from '../src/workspace-data/schema.js';
import { createRecord, getRecord, updateRecord } from '../src/workspace-data/records.js';
import { queryRecords } from '../src/workspace-data/query.js';
import { createView, listViews } from '../src/workspace-data/views.js';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

describe('schema changes', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-schema-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.openWorkspace(orgId);
  const customers = () => loadTableByName(db(), 'customers');

  const newCustomer = (data: Record<string, unknown>) =>
    createRecord(db(), customers(), actor, data as never);

  // --- Rename -------------------------------------------------------------

  it('renames a field and carries every value across', () => {
    newCustomer({ name: 'Acme', phone: '555-0100' });
    newCustomer({ name: 'Northwind', phone: '555-0200' });

    renameField(db(), actor, 'customers', 'phone', 'telephone');

    const table = customers();
    expect(table.fields.some((field) => field.name === 'telephone')).toBe(true);
    expect(table.fields.some((field) => field.name === 'phone')).toBe(false);

    const rows = queryRecords(db(), table, { limit: 10 }).records;
    // The values moved with the name; a rename that empties a column is the
    // failure everyone fears.
    expect(rows.map((row) => row.data.telephone).sort()).toEqual(['555-0100', '555-0200']);
    expect(rows.every((row) => row.data.phone === undefined)).toBe(true);
  });

  it('leaves other fields untouched by a rename', () => {
    const record = newCustomer({ name: 'Acme', phone: '555-0100', email: 'a@acme.com' });

    renameField(db(), actor, 'customers', 'phone', 'telephone');

    const after = getRecord(db(), record.id);
    expect(after.data.name).toBe('Acme');
    expect(after.data.email).toBe('a@acme.com');
  });

  it('refuses a rename onto a name already in use', () => {
    expect(() => renameField(db(), actor, 'customers', 'phone', 'email')).toThrowError(
      /already exists/i,
    );
  });

  it('refuses an illegal or reserved new name', () => {
    expect(() => renameField(db(), actor, 'customers', 'phone', 'Not Legal')).toThrowError(
      /not a usable field name/i,
    );
    expect(() => renameField(db(), actor, 'customers', 'phone', 'revision')).toThrowError(
      /reserved/i,
    );
  });

  it('keeps a unique constraint working after a rename', () => {
    const invoices = () => loadTableByName(db(), 'invoices');
    const customer = newCustomer({ name: 'Acme' });
    const make = (number: string) =>
      createRecord(db(), invoices(), actor, {
        invoice_number: number,
        customer: customer.id,
        issue_date: '2026-01-01',
        status: 'sent',
        total: 100,
      } as never);
    make('INV-1');

    renameField(db(), actor, 'invoices', 'invoice_number', 'doc_number');

    // The index was rebuilt over the new key, so uniqueness still bites.
    expect(() =>
      createRecord(db(), invoices(), actor, {
        doc_number: 'INV-1',
        customer: customer.id,
        issue_date: '2026-01-01',
        status: 'sent',
        total: 100,
      } as never),
    ).toThrowError();
  });

  it('follows the rename into formulas that read the field', () => {
    const table = createTable(
      db(),
      {
        name: 'quotes_calc',
        displayName: 'Quote maths',
        fields: [
          { name: 'gross', displayName: 'Gross', type: 'money' },
          { name: 'net', displayName: 'Net', type: 'money', config: { formula: '{gross} - 100' } },
        ],
      },
      actor,
    );
    void table;

    renameField(db(), actor, 'quotes_calc', 'gross', 'total_gross');

    const formula = loadTableByName(db(), 'quotes_calc').fields.find((f) => f.name === 'net')!;
    // A formula left pointing at the old name would silently compute from
    // nothing, which is worse than an error.
    expect((formula.config as { formula: string }).formula).toBe('{total_gross} - 100');
  });

  it('follows the rename into saved views', async () => {
    const orgDb = manager.workspaceExecutor(orgId);
    await createView(orgDb, orgId, customers().id, 'wsm-test', {
      name: 'By phone',
      filters: [{ field: 'phone', op: 'eq', value: '555-0100' }],
      sorts: [{ field: 'phone', direction: 'asc' }],
    });

    renameField(db(), actor, 'customers', 'phone', 'telephone');

    const view = (await listViews(orgDb, orgId, customers().id)).find((v) => v.name === 'By phone')!;
    expect(view.filters[0]!.field).toBe('telephone');
    expect(view.sorts[0]!.field).toBe('telephone');
  });

  // --- Retype -------------------------------------------------------------

  it('converts values that can convert', () => {
    const table = createTable(
      db(),
      {
        name: 'counts',
        displayName: 'Counts',
        fields: [{ name: 'amount', displayName: 'Amount', type: 'text' }],
      },
      actor,
    );
    createRecord(db(), table, actor, { amount: '42' } as never);

    retypeField(db(), actor, 'counts', 'amount', 'integer');

    const row = queryRecords(db(), loadTableByName(db(), 'counts'), { limit: 5 }).records[0]!;
    expect(row.data.amount).toBe(42);
  });

  it('refuses a retype that would lose values, until the loss is accepted', () => {
    const table = createTable(
      db(),
      {
        name: 'mixed',
        displayName: 'Mixed',
        fields: [{ name: 'amount', displayName: 'Amount', type: 'text' }],
      },
      actor,
    );
    createRecord(db(), table, actor, { amount: '42' } as never);
    createRecord(db(), table, actor, { amount: 'twelve apples' } as never);

    // Refused by default: nobody should drop data without seeing what.
    expect(() => retypeField(db(), actor, 'mixed', 'amount', 'integer')).toThrowError(
      /cannot become integer/i,
    );

    retypeField(db(), actor, 'mixed', 'amount', 'integer', { acceptDataLoss: true });

    const values = queryRecords(db(), loadTableByName(db(), 'mixed'), { limit: 5 }).records.map(
      (row) => row.data.amount,
    );
    expect(values).toContain(42);
    // The unconvertible one is blank rather than left as the wrong type.
    expect(values).toContain(null);
  });

  it('does not guess a number out of prose', () => {
    // "12 apples" becoming 12 is how a retype quietly corrupts a column.
    expect(coerceToType('12 apples', 'integer')).toBeUndefined();
    expect(coerceToType('42', 'integer')).toBe(42);
    expect(coerceToType('10.5', 'integer')).toBeUndefined();
    expect(coerceToType('10.5', 'number')).toBe(10.5);
    expect(coerceToType('yes', 'boolean')).toBe(true);
    expect(coerceToType('maybe', 'boolean')).toBeUndefined();
    expect(coerceToType('2026-03-01', 'date')).toBe('2026-03-01');
    // Inventing a record reference is worse than refusing.
    expect(coerceToType('not-an-id', 'link')).toBeUndefined();
  });

  // --- Impact -------------------------------------------------------------

  it('reports what a change would cost before making it', () => {
    const table = createTable(
      db(),
      {
        name: 'impacted',
        displayName: 'Impacted',
        fields: [
          { name: 'amount', displayName: 'Amount', type: 'text' },
          { name: 'doubled', displayName: 'Doubled', type: 'number', config: { formula: '{amount} * 2' } },
        ],
      },
      actor,
    );
    createRecord(db(), table, actor, { amount: '42' } as never);
    createRecord(db(), table, actor, { amount: 'nope' } as never);
    createRecord(db(), table, actor, {} as never);

    const impact = blastRadius(db(), 'impacted', 'amount', { kind: 'retype', to: 'integer' });

    expect(impact.recordCount).toBe(3);
    expect(impact.populatedCount).toBe(2);
    expect(impact.valuesAtRisk).toBe(1);
    expect(impact.sampleLosses[0]!.value).toBe('nope');
    expect(impact.referencedByFormulas).toContain('doubled');
    expect(impact.reversible).toBe(false);
  });

  it('reports a rename as reversible and lossless', () => {
    newCustomer({ name: 'Acme', phone: '555' });

    const impact = blastRadius(db(), 'customers', 'phone', { kind: 'rename', to: 'telephone' });

    expect(impact.valuesAtRisk).toBe(0);
    expect(impact.reversible).toBe(true);
  });

  // --- Remove and restore -------------------------------------------------

  it('removes a field but keeps its values, so restoring brings them back', () => {
    const record = newCustomer({ name: 'Acme', phone: '555-0100' });

    removeField(db(), actor, 'customers', 'phone');
    expect(customers().fields.some((field) => field.name === 'phone')).toBe(false);

    restoreField(db(), actor, 'customers', 'phone');

    expect(customers().fields.some((field) => field.name === 'phone')).toBe(true);
    // Nothing truly deletes — the value was there the whole time.
    expect(getRecord(db(), record.id).data.phone).toBe('555-0100');
  });

  it('refuses to restore a field whose name has been taken since', () => {
    newCustomer({ name: 'Acme', phone: '555' });
    removeField(db(), actor, 'customers', 'phone');
    renameField(db(), actor, 'customers', 'email', 'phone');

    expect(() => restoreField(db(), actor, 'customers', 'phone')).toThrowError(/exists again/i);
  });

  // --- Config -------------------------------------------------------------

  it('changes a label without touching data', () => {
    const record = newCustomer({ name: 'Acme' });

    updateFieldConfig(db(), actor, 'customers', 'name', { displayName: 'Company name' });

    expect(customers().fields.find((f) => f.name === 'name')!.displayName).toBe('Company name');
    expect(getRecord(db(), record.id).data.name).toBe('Acme');
  });

  it('refuses to remove a select option rows still use', () => {
    const customer = newCustomer({ name: 'Acme' });
    createRecord(db(), loadTableByName(db(), 'invoices'), actor, {
      invoice_number: 'INV-1',
      customer: customer.id,
      issue_date: '2026-01-01',
      status: 'sent',
      total: 100,
    } as never);

    // Dropping 'sent' would make that row invalid on its next save — a failure
    // the person editing options did not intend and the row's owner did not
    // cause.
    expect(() =>
      updateFieldConfig(db(), actor, 'invoices', 'status', { options: ['draft', 'paid'] }),
    ).toThrowError(/still in use/i);
  });

  it('adds a select option freely', () => {
    updateFieldConfig(db(), actor, 'invoices', 'status', {
      options: ['draft', 'sent', 'paid', 'void', 'disputed'],
    });

    const field = loadTableByName(db(), 'invoices').fields.find((f) => f.name === 'status')!;
    expect((field.config as { options: string[] }).options).toContain('disputed');
  });

  it('refuses to make a field required while rows are missing it', () => {
    newCustomer({ name: 'Acme' });

    expect(() =>
      updateFieldConfig(db(), actor, 'customers', 'phone', { required: true }),
    ).toThrowError(/have no 'phone'/i);
  });

  it('allows making a field required once every row has one', () => {
    const record = newCustomer({ name: 'Acme' });
    updateRecord(db(), customers(), actor, record.id, { phone: '555' } as never);

    updateFieldConfig(db(), actor, 'customers', 'phone', { required: true });

    expect(customers().fields.find((f) => f.name === 'phone')!.required).toBe(true);
  });

  it('reorders fields, leaving unnamed ones after the ones listed', () => {
    reorderFields(db(), actor, 'customers', ['email', 'name']);

    const names = customers().fields.map((field) => field.name);
    expect(names[0]).toBe('email');
    expect(names[1]).toBe('name');
    // A partial order is still a valid order.
    expect(names).toContain('phone');
  });

  it('refuses to reorder around a field that does not exist', () => {
    expect(() => reorderFields(db(), actor, 'customers', ['nope'])).toThrowError(/not a field/i);
  });
});

describe('labels after a rename', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-labels-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.openWorkspace(orgId);

  it('carries an auto-derived label along with the rename', () => {
    createTable(
      db(),
      {
        name: 'vehicles',
        displayName: 'Vehicles',
        fields: [{ name: 'registration', displayName: 'Registration', type: 'text' }],
      },
      actor,
    );

    renameField(db(), actor, 'vehicles', 'registration', 'plate');

    // Otherwise the column reads "Registration" while being called `plate`.
    const field = loadTableByName(db(), 'vehicles').fields.find((f) => f.name === 'plate')!;
    expect(field.displayName).toBe('Plate');
  });

  it('leaves a label someone chose alone', () => {
    createTable(
      db(),
      {
        name: 'fleet',
        displayName: 'Fleet',
        fields: [{ name: 'registration', displayName: 'Reg. plate (DVLA)', type: 'text' }],
      },
      actor,
    );

    renameField(db(), actor, 'fleet', 'registration', 'plate');

    // A chosen label is a decision, not a default.
    const field = loadTableByName(db(), 'fleet').fields.find((f) => f.name === 'plate')!;
    expect(field.displayName).toBe('Reg. plate (DVLA)');
  });
});
