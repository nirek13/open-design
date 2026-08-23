// Formulas, rollups, and saved views.
//
// The formula tests lean on two properties: the evaluator can only produce
// data (never reach the host), and a broken formula degrades to blank rather
// than taking a table down with it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { setUpBusinessHub } from '../src/workspace-data/hub.js';
import {
  applyFormulas,
  computeRollup,
  evaluateFormula,
  formulaDependencies,
  parseFormula,
} from '../src/workspace-data/formula.js';
import {
  createView,
  deleteView,
  ensureDefaultView,
  groupRecords,
  listViews,
  updateView,
} from '../src/workspace-data/views.js';
import { loadTableByName } from '../src/workspace-data/schema.js';
import { createRecord } from '../src/workspace-data/records.js';
import { queryRecords } from '../src/workspace-data/query.js';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

/** Evaluate a formula against a bag of values. */
const run = (source: string, values: Record<string, unknown> = {}) =>
  evaluateFormula(parseFormula(source), values);

describe('formulas', () => {
  it('does arithmetic with the precedence everyone expects', () => {
    expect(run('2 + 3 * 4')).toBe(14);
    expect(run('(2 + 3) * 4')).toBe(20);
    expect(run('10 - 2 - 3')).toBe(5);
  });

  it('reads fields by name in braces', () => {
    expect(run('{total} - {tax}', { total: 12_000, tax: 2_000 })).toBe(10_000);
  });

  it('treats a missing field as blank rather than failing', () => {
    expect(run('{nope}', {})).toBeNull();
    expect(run('{nope} + 5', {})).toBe(5);
  });

  it('returns null on divide-by-zero instead of Infinity', () => {
    // Infinity would poison every total downstream and render as garbage.
    expect(run('10 / 0')).toBeNull();
    expect(run('{a} / {b}', { a: 10, b: 0 })).toBeNull();
  });

  it('concatenates when either side is text', () => {
    expect(run('"Invoice " + {number}', { number: 1042 })).toBe('Invoice 1042');
    expect(run('{a} + {b}', { a: 2, b: 3 })).toBe(5);
  });

  it('supports the functions people reach for', () => {
    expect(run('IF({paid}, "yes", "no")', { paid: true })).toBe('yes');
    expect(run('ROUND(10 / 3, 2)')).toBe(3.33);
    expect(run('MAX(1, 9, 5)')).toBe(9);
    expect(run('COALESCE({missing}, "fallback")', {})).toBe('fallback');
    expect(run('UPPER({name})', { name: 'acme' })).toBe('ACME');
    expect(run('ISBLANK({nothing})', {})).toBe(true);
  });

  it('compares and combines conditions', () => {
    expect(run('{total} > 1000 && {status} == "sent"', { total: 5000, status: 'sent' })).toBe(true);
    expect(run('{total} > 1000 && {status} == "sent"', { total: 100, status: 'sent' })).toBe(false);
  });

  it('keeps money in minor units through a percentage', () => {
    // 20% of $120.00 is $24.00 — 2400 minor units, not 24.
    expect(run('ROUND({total} * 0.2)', { total: 12_000 })).toBe(2_400);
  });

  it('refuses anything that could reach outside the record', () => {
    // The grammar has no syntax for these at all, which is the point: there is
    // nothing to sandbox because there is no escape hatch to begin with.
    for (const source of [
      'process.exit(1)',
      'constructor',
      'this',
      'require("fs")',
      '{a}.constructor',
      'globalThis',
    ]) {
      expect(() => parseFormula(source)).toThrow();
    }
  });

  it('rejects an unknown function rather than ignoring it', () => {
    expect(() => run('LAUNCH({total})', { total: 1 })).toThrow(/unknown function/i);
  });

  it('rejects malformed input', () => {
    expect(() => parseFormula('2 +')).toThrow();
    expect(() => parseFormula('{unclosed')).toThrow();
    expect(() => parseFormula('(1 + 2')).toThrow();
    expect(() => parseFormula('1 2')).toThrow();
  });

  it('caps how complex a formula may get', () => {
    // Evaluated once per row per read, so an unbounded formula is a hang.
    expect(() => parseFormula(Array.from({ length: 400 }, () => '1').join(' + '))).toThrow(
      /too complex/i,
    );
  });

  it('reports which fields a formula depends on', () => {
    const deps = formulaDependencies(parseFormula('{total} - {tax} + IF({paid}, 0, {fee})'));
    expect(deps.sort()).toEqual(['fee', 'paid', 'tax', 'total']);
  });
});

describe('rollups', () => {
  const rows = (values: number[]) =>
    values.map((amount, index) => ({ id: `r${index}`, data: { amount } })) as never[];

  it('sums, counts, and averages linked records', () => {
    expect(computeRollup({ via: 'customer', field: 'amount', fn: 'sum' }, rows([100, 200, 300]))).toBe(600);
    expect(computeRollup({ via: 'customer', field: 'amount', fn: 'count' }, rows([100, 200]))).toBe(2);
    expect(computeRollup({ via: 'customer', field: 'amount', fn: 'avg' }, rows([100, 201]))).toBe(151);
    expect(computeRollup({ via: 'customer', field: 'amount', fn: 'max' }, rows([100, 900]))).toBe(900);
  });

  it('sums to zero but averages to unknown when there is nothing', () => {
    // "They have ordered nothing" is 0; "their average order" is unanswerable.
    expect(computeRollup({ via: 'c', field: 'amount', fn: 'sum' }, [])).toBe(0);
    expect(computeRollup({ via: 'c', field: 'amount', fn: 'avg' }, [])).toBeNull();
  });
});

describe('computed fields on records', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-formula-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const records = () => manager.openWorkspace(orgId);

  it('fills a formula field at read time without storing it', () => {
    const table = loadTableByName(records(), 'invoices');
    const withFormula = {
      ...table,
      fields: [
        ...table.fields,
        {
          id: 'fld-net',
          tableId: table.id,
          name: 'net',
          displayName: 'Net',
          type: 'money' as const,
          required: false,
          unique: false,
          config: { formula: '{total} - {tax}' },
          position: 99,
          status: 'active' as const,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    const record = {
      id: 'rec-1',
      tableId: table.id,
      data: { total: 12_000, tax: 2_000 },
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    } as never;

    const computed = applyFormulas(withFormula as never, record);

    expect((computed as { data: Record<string, unknown> }).data.net).toBe(10_000);
    // The stored record is untouched — the value exists only in the read.
    expect((record as { data: Record<string, unknown> }).data.net).toBeUndefined();
  });

  it('shows a broken formula as blank rather than failing the whole read', () => {
    const table = loadTableByName(records(), 'invoices');
    const broken = {
      ...table,
      fields: [
        ...table.fields,
        {
          id: 'fld-bad',
          tableId: table.id,
          name: 'oops',
          displayName: 'Oops',
          type: 'number' as const,
          required: false,
          unique: false,
          config: { formula: 'NONSENSE(' },
          position: 99,
          status: 'active' as const,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    const record = { id: 'r', tableId: table.id, data: { total: 1 }, revision: 1, createdAt: 0, updatedAt: 0, deletedAt: null } as never;

    // One bad column must not make a table unopenable.
    expect(() => applyFormulas(broken as never, record)).not.toThrow();
    expect((applyFormulas(broken as never, record) as { data: Record<string, unknown> }).data.oops).toBeNull();
  });
});

describe('saved views', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-views-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const records = () => manager.openWorkspace(orgId);
  const db = () => manager.workspaceExecutor(orgId);
  const invoices = () => loadTableByName(records(), 'invoices');

  it('makes the first view on a table its default', async () => {
    const view = await createView(db(), orgId, invoices().id, 'wsm-test', { name: 'All' });
    expect(view.isDefault).toBe(true);
  });

  it('keeps exactly one default per table', async () => {
    const table = invoices();
    await createView(db(), orgId, table.id, 'wsm-test', { name: 'All' });
    await createView(db(), orgId, table.id, 'wsm-test', { name: 'Overdue', isDefault: true });

    const views = await listViews(db(), orgId, table.id);
    expect(views.filter((view) => view.isDefault)).toHaveLength(1);
    expect(views.find((view) => view.isDefault)!.name).toBe('Overdue');
  });

  it('refuses a board with nothing to group by', async () => {
    // A board with no groupBy renders one column called "everything".
    await expect(
      createView(db(), orgId, invoices().id, 'wsm-test', { name: 'Board', kind: 'board' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VALIDATION_FAILED' });
  });

  it('refuses a calendar with no date field', async () => {
    await expect(
      createView(db(), orgId, invoices().id, 'wsm-test', { name: 'Cal', kind: 'calendar' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VALIDATION_FAILED' });
  });

  it('accepts a board once it has a field to group by', async () => {
    const view = await createView(db(), orgId, invoices().id, 'wsm-test', {
      name: 'By status',
      kind: 'board',
      groupBy: 'status',
    });
    expect(view.kind).toBe('board');
    expect(view.groupBy).toBe('status');
  });

  it('hands the default to another view when the default is deleted', async () => {
    const table = invoices();
    const first = await createView(db(), orgId, table.id, 'wsm-test', { name: 'All' });
    await createView(db(), orgId, table.id, 'wsm-test', { name: 'Second' });

    await deleteView(db(), orgId, first.id);

    const remaining = await listViews(db(), orgId, table.id);
    // A table with views but no default has nowhere to open.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.isDefault).toBe(true);
  });

  it('does not create a second default view for a table that has one', async () => {
    const table = invoices();
    const first = await ensureDefaultView(db(), orgId, table, 'wsm-test');
    const again = await ensureDefaultView(db(), orgId, table, 'wsm-test');

    expect(again.id).toBe(first.id);
  });

  it('stores filters and sorts and reads them back', async () => {
    const view = await createView(db(), orgId, invoices().id, 'wsm-test', {
      name: 'Sent',
      filters: [{ field: 'status', op: 'eq', value: 'sent' }],
      sorts: [{ field: 'total', direction: 'desc' }],
    });

    const reloaded = (await listViews(db(), orgId, invoices().id)).find((v) => v.id === view.id)!;
    expect(reloaded.filters).toEqual([{ field: 'status', op: 'eq', value: 'sent' }]);
    expect(reloaded.sorts).toEqual([{ field: 'total', direction: 'desc' }]);
  });

  it('renames a view without disturbing its default flag', async () => {
    const view = await createView(db(), orgId, invoices().id, 'wsm-test', { name: 'All' });
    const renamed = await updateView(db(), orgId, view.id, { name: 'Everything' });

    expect(renamed.name).toBe('Everything');
    expect(renamed.isDefault).toBe(true);
  });

  // --- Grouping -----------------------------------------------------------

  it('groups records by a field, keeping empty option columns', () => {
    const table = invoices();
    const customers = loadTableByName(records(), 'customers');
    const customer = createRecord(records(), customers, actor, { name: 'Acme' } as never);
    for (const status of ['draft', 'sent', 'sent']) {
      createRecord(records(), table, actor, {
        invoice_number: `INV-${Math.round(Math.random() * 1e9)}`,
        customer: customer.id,
        issue_date: '2026-01-01',
        status,
        total: 100,
      } as never);
    }

    const groups = groupRecords(queryRecords(records(), table, { limit: 100 }).records, table, 'status');

    expect(groups.find((group) => group.key === 'sent')!.count).toBe(2);
    expect(groups.find((group) => group.key === 'draft')!.count).toBe(1);
    // An empty "paid" column is information — a board that hides it looks
    // like nothing has been paid.
    expect(groups.find((group) => group.key === 'paid')!.count).toBe(0);
  });

  it('gives records with no value their own visible group', () => {
    const table = loadTableByName(records(), 'customers');
    createRecord(records(), table, actor, { name: 'No notes here' } as never);

    const groups = groupRecords(queryRecords(records(), table, { limit: 10 }).records, table, 'notes');

    const blank = groups.find((group) => group.key === null)!;
    expect(blank.count).toBe(1);
    expect(blank.label).toMatch(/^No /);
  });

  it('refuses to group by a field that does not exist', () => {
    const table = invoices();
    expect(() => groupRecords([], table, 'not_a_field')).toThrow(/no field called/i);
  });
});
