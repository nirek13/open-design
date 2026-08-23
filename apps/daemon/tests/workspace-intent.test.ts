// Turning sentences into plans.
//
// The tests that matter most here are the refusals. A parser that guesses
// produces a confident wrong plan, and a confident wrong plan is the one a
// person approves without reading — so "declines cleanly" is the property
// under test at least as much as "understands".

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { setUpBusinessHub } from '../src/workspace-data/hub.js';
import { installTemplateWithRequirements } from '../src/workspace-data/templates.js';
import {
  coerceValue,
  editDistance,
  inferFieldType,
  interpretIntent,
  machineName,
  parseMoney,
  resolveTableName,
} from '../src/workspace-data/intent.js';
import { listTables, loadTableByName } from '../src/workspace-data/schema.js';
import { MIN_APPLY_CONFIDENCE } from '@open-design/contracts';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

describe('natural-language workspace commands', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-intent-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
    await installTemplateWithRequirements(
      manager.openWorkspace(orgId),
      manager.workspaceExecutor(orgId),
      orgId,
      'crm',
      actor,
    );
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.openWorkspace(orgId);
  const ask = (text: string, tableRef?: string) =>
    interpretIntent(db(), text, tableRef ? { tableRef } : {});

  // --- Adding a field -----------------------------------------------------

  it('adds a column to a named table', () => {
    const result = ask('add a website column to customers');

    expect(result.kind).toBe('schema');
    expect(result.operations).toEqual([
      {
        kind: 'add-field',
        tableRef: 'customers',
        field: { name: 'website', displayName: 'Website', type: 'text' },
      },
    ]);
    expect(result.confidence).toBeGreaterThan(MIN_APPLY_CONFIDENCE);
  });

  it('uses the table you are looking at when the sentence omits one', () => {
    const invoices = loadTableByName(db(), 'invoices');

    const result = ask('add a reference column', invoices.id);

    expect(result.kind).toBe('schema');
    expect((result.operations[0] as { tableRef: string }).tableRef).toBe('invoices');
  });

  it('refuses when no table is named and none is open', () => {
    // Guessing a table here would put a column on something arbitrary.
    expect(ask('add a reference column').kind).toBe('unsupported');
  });

  it('does not fall back to the open table when the sentence names a missing one', () => {
    const invoices = loadTableByName(db(), 'invoices');

    // "add a phone column to suppliers" while looking at invoices must not
    // quietly put the column on invoices.
    expect(ask('add a phone column to suppliers', invoices.id).kind).toBe('unsupported');
  });

  it('says so when the field already exists instead of proposing a duplicate', () => {
    // customers already ships with an email field.
    const result = ask('add an email column to customers');

    expect(result.kind).toBe('unsupported');
    expect(result.summary).toMatch(/already has a field/i);
    expect(result.operations).toEqual([]);
  });

  it('infers a type from the word used', () => {
    expect(fieldTypeOf(ask('add a reminder date column to invoices'))).toBe('date');
    expect(fieldTypeOf(ask('add a discount money column to invoices'))).toBe('money');
    expect(fieldTypeOf(ask('add an archived checkbox column to customers'))).toBe('boolean');
  });

  it('infers a type from the field name when no type word is given', () => {
    // Nobody says "add a money column called deposit"; they say "add a deposit".
    expect(fieldTypeOf(ask('add a deposit_amount column to invoices'))).toBe('money');
    expect(fieldTypeOf(ask('add a shipped_on column to orders'))).toBe('date');
  });

  it('reads "phone number" as a phone, not as a number', () => {
    expect(fieldTypeOf(ask('add a phone number column to vendors_unused'))).toBeUndefined();
    // On a table without one, it reads as text rather than as a number.
    expect(fieldTypeOf(ask('add a phone number column to orders'))).toBe('text');
  });

  // --- Adding a row -------------------------------------------------------

  it('adds a row and puts a bare name in the name field', () => {
    const result = ask('add a customer called Northwind');

    expect(result.kind).toBe('data');
    expect(result.operations[0]).toMatchObject({
      kind: 'create-record',
      tableRef: 'customers',
      data: { name: 'Northwind' },
    });
  });

  it('reads several field values out of one sentence', () => {
    const result = ask('add a customer called Acme with email hi@acme.com and phone 555-0100');

    expect((result.operations[0] as { data: Record<string, unknown> }).data).toMatchObject({
      name: 'Acme',
      email: 'hi@acme.com',
      phone: '555-0100',
    });
  });

  it('converts a written amount into integer minor units', () => {
    const result = ask('add a deal called Renewal with value $1,250.50');

    expect((result.operations[0] as { data: Record<string, unknown> }).data.value).toBe(125_050);
  });

  it('reports the part of the sentence it could not use', () => {
    const result = ask('add a customer called Acme with vibes excellent');

    expect(result.unmatched).toContain('vibes excellent');
    // Half-understood means less certain, and the UI shows both.
    expect(result.confidence).toBeLessThan(0.9);
  });

  // --- Creating a table ---------------------------------------------------

  it('creates a table with the fields listed', () => {
    const result = ask('create a table called suppliers with name, email, phone');

    expect(result.kind).toBe('schema');
    const table = (result.operations[0] as unknown as { table: { name: string; fields: unknown[] } }).table;
    expect(table.name).toBe('suppliers');
    expect(table.fields).toHaveLength(3);
  });

  it('refuses to create a table that already exists', () => {
    const result = ask('create a table called customers');

    expect(result.kind).toBe('unsupported');
    expect(result.summary).toMatch(/already exists/i);
  });

  it('does not read "create a table called X" as adding a row', () => {
    // The generic add-row rule would happily match this sentence.
    expect(ask('create a table called suppliers with name').kind).toBe('schema');
  });

  // --- Queries ------------------------------------------------------------

  it('turns a where clause into filters', () => {
    const result = ask('show invoices where status is sent');

    expect(result.kind).toBe('query');
    expect(result.query!.tableRef).toBe('invoices');
    expect(result.query!.filters).toEqual([{ field: 'status', op: 'eq', value: 'sent' }]);
    expect(result.operations).toEqual([]);
  });

  it('reads "is not" as a negation', () => {
    const result = ask('show invoices where status is not paid');

    expect(result.query!.filters[0]!.op).toBe('neq');
  });

  it('understands overdue as a date test plus an unsettled status', () => {
    const result = ask('show overdue invoices');

    expect(result.kind).toBe('query');
    const filters = result.query!.filters;
    // A paid invoice with a past due date is not overdue, so the status test
    // has to be there too.
    expect(filters.some((f) => f.field === 'due_date' && f.op === 'lt')).toBe(true);
    const status = filters.find((f) => f.field === 'status');
    expect(status?.op).toBe('in');
    expect(status?.value as string[]).not.toContain('paid');
  });

  it('reads a sort direction', () => {
    const result = ask('show deals by value descending');

    expect(result.query!.sort).toEqual({ field: 'value', direction: 'desc' });
  });

  it('never returns operations for a question', () => {
    // A read must not be able to write, whatever the sentence looked like.
    for (const text of ['show invoices', 'list customers', 'find deals where stage is won']) {
      expect(ask(text).operations).toEqual([]);
    }
  });

  // --- Grouping -----------------------------------------------------------

  it('reads a grouping request as a view change, not a query', () => {
    const result = ask('group deals by stage');

    expect(result.kind).toBe('view');
    expect(result.query!.tableRef).toBe('deals');
  });

  // --- Declining ----------------------------------------------------------

  it('declines nonsense and points at the assistant', () => {
    const result = ask('please reconcile the quarterly variance against last year');

    expect(result.kind).toBe('unsupported');
    expect(result.confidence).toBe(0);
    expect(result.summary).toMatch(/assistant/i);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('declines an empty instruction', () => {
    expect(ask('   ').kind).toBe('unsupported');
  });

  it('offers examples whenever it is unsure', () => {
    const result = ask('add a phone column to custmers');
    if (result.confidence < 0.75) expect(result.suggestions.length).toBeGreaterThan(0);
  });

  // --- Fuzzy matching -----------------------------------------------------

  it('forgives a typo in a table name but is less certain about it', () => {
    const exact = ask('add a nickname column to customers');
    const typo = ask('add a nickname column to custmers');

    expect(typo.kind).toBe('schema');
    expect((typo.operations[0] as { tableRef: string }).tableRef).toBe('customers');
    expect(typo.confidence).toBeLessThan(exact.confidence);
  });

  it('matches a singular against a plural table name', () => {
    const resolved = resolveTableName(listTables(db()), 'customer');
    expect(resolved?.value.name).toBe('customers');
  });

  it('does not forgive a typo on a short name, where it would be a guess', () => {
    // 'tax' -> 'fax' is one edit but a completely different word.
    expect(editDistance('tax', 'fax')).toBe(1);
    const invoices = loadTableByName(db(), 'invoices');
    const result = ask('add a fax column', invoices.id);
    // It becomes a new `fax` field rather than resolving to the tax field.
    expect((result.operations[0] as unknown as { field: { name: string } }).field.name).toBe('fax');
  });

  // --- Units --------------------------------------------------------------

  it('parses written money into minor units', () => {
    expect(parseMoney('$1,250.50')).toBe(125_050);
    expect(parseMoney('99')).toBe(9_900);
    expect(parseMoney('0.05')).toBe(5);
    // A float in a money field is always a bug; unreadable input must not
    // silently become one.
    expect(parseMoney('twelve dollars')).toBeNull();
  });

  it('coerces values to what the field type needs', () => {
    expect(coerceValue('yes', 'boolean')).toBe(true);
    expect(coerceValue('2026-03-01', 'date')).toBe('2026-03-01');
    expect(coerceValue('42', 'integer')).toBe(42);
    expect(coerceValue('not a number', 'integer')).toBeUndefined();
  });

  it('normalizes a phrase into a legal machine name', () => {
    expect(machineName('Phone Number')).toBe('phone_number');
    expect(machineName('  weird!! name  ')).toBe('weird_name');
    // A leading digit is not a legal field name.
    expect(machineName('2024 total')).toMatch(/^f_2024/);
  });

  it('never proposes a field name the schema would reject', () => {
    const pattern = /^[a-z][a-z0-9_]{0,63}$/;
    for (const text of [
      'add a Phone Number column to customers',
      'add a "weird!! name" column to customers',
      'add a 2024 total column to customers',
    ]) {
      const result = ask(text);
      if (result.kind !== 'schema') continue;
      const field = (result.operations[0] as unknown as { field: { name: string } }).field;
      expect(field.name).toMatch(pattern);
    }
  });

  it('infers types consistently from a bare phrase', () => {
    expect(inferFieldType('total', 'total')).toBe('money');
    expect(inferFieldType('is_active', 'is_active')).toBe('boolean');
    expect(inferFieldType('something unknown', 'something_unknown')).toBe('text');
  });
});

function fieldTypeOf(result: { operations: unknown[] }): string | undefined {
  const op = result.operations[0] as { field?: { type?: string } } | undefined;
  return op?.field?.type;
}

describe('reshaping a table by saying so', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-intent-schema-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const ask = (text: string, tableRef?: string) =>
    interpretIntent(manager.openWorkspace(orgId), text, tableRef ? { tableRef } : {});

  it('reads a rename', () => {
    const result = ask('rename phone to mobile on customers');

    expect(result.kind).toBe('schema');
    expect(result.schemaChange).toEqual({
      kind: 'rename',
      table: 'customers',
      field: 'phone',
      to: 'mobile',
    });
    // A rename migrates rows, so it is not a proposal operation.
    expect(result.operations).toEqual([]);
  });

  it('says a rename keeps the values, because that is the worry', () => {
    expect(ask('rename phone to mobile on customers').summary).toMatch(/carried across/i);
  });

  it('reads a removal and says it can be undone', () => {
    const result = ask('delete the phone column from customers');

    expect(result.schemaChange).toMatchObject({ kind: 'remove', table: 'customers', field: 'phone' });
    expect(result.summary).toMatch(/undone/i);
  });

  it('uses the open table when the sentence omits one', () => {
    const customers = loadTableByName(manager.openWorkspace(orgId), 'customers');

    expect(ask('rename phone to mobile', customers.id).schemaChange).toMatchObject({
      table: 'customers',
      field: 'phone',
    });
  });

  it('declines a rename of a field that does not exist', () => {
    expect(ask('rename nonexistent to something on customers').kind).toBe('unsupported');
  });

  it('does not read "delete the customer called Acme" as dropping a column', () => {
    // Deleting rows is not in the grammar; it must not be mistaken for a
    // schema change.
    const result = ask('delete the customer called Acme');
    expect(result.schemaChange?.kind).not.toBe('remove');
  });
});
