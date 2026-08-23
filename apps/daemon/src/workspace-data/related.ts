// Everything about one record, in one read.
//
// This is the shape a real ERP record page needs and the record engine did not
// have: the row itself, what it points at, what points back at it, the numbers
// rolled up from those, the document actions available right now, and the
// history. Assembled server-side because a client that fetched these
// separately would render six loading states and still get the ordering wrong.
//
// The reverse direction is the part that matters. A customer row is not
// interesting; a customer with their invoices, their open deals, what they owe
// and what they have paid is the thing someone actually opens. Links are
// stored one-way (invoice → customer), so "which invoices belong to this
// customer" means scanning the link fields of every table — which is why it is
// done once, here, rather than by each caller.

import type {
  JsonValue,
  RecordDetail,
  RecordRelatedList,
  RecordRollup,
  WorkspaceField,
  WorkspaceRecord,
  WorkspaceTable,
} from '@open-design/contracts';
import { listTables, loadTable } from './schema.js';
import { getRecord } from './records.js';
import { queryRecords } from './query.js';
import { applyFormulas } from './formula.js';
import { fieldWithRole, isPostableTable } from './hub.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

/** How many related rows to carry per list. A record page shows a preview and
 * links out; loading a customer with 4,000 invoices should not be possible by
 * accident. */
const RELATED_LIMIT = 25;

/** How many rows to read when totalling. Deliberately much larger than
 * RELATED_LIMIT: the *shown* list is a preview, but "invoiced: 42,500.00" must
 * count every invoice, not just the first page. A total that silently sums the
 * visible rows is worse than no total, because it looks authoritative.
 *
 * Past this ceiling the count becomes a floor and `truncated` says so. */
const AGGREGATE_LIMIT = 2_000;

interface InboundRef {
  table: WorkspaceTable;
  field: WorkspaceField;
}

/** Every (table, field) pair whose link points at `tableId`. Computed by
 * walking the schema, because links are only stored on the pointing side. */
export function inboundReferences(recordsDb: RecordsDb, tableId: string): InboundRef[] {
  const out: InboundRef[] = [];
  for (const table of listTables(recordsDb)) {
    for (const field of table.fields) {
      if (field.type !== 'link') continue;
      if ((field.config as { targetTableId?: string } | null)?.targetTableId !== tableId) continue;
      out.push({ table, field });
    }
  }
  return out;
}

/** A short human label for a row, for link chips and related lists. Prefers a
 * document number, then a name, then the first text value — the same order a
 * person would read the row in. */
export function recordLabel(table: WorkspaceTable, record: WorkspaceRecord): string {
  const numberField = fieldWithRole(table, 'document-number');
  if (numberField) {
    const value = record.data[numberField.name];
    if (typeof value === 'string' && value) return value;
  }
  for (const name of ['name', 'title', 'subject', 'reference']) {
    const value = record.data[name];
    if (typeof value === 'string' && value) return value;
  }
  const firstText = table.fields.find((field) => field.type === 'text');
  const value = firstText ? record.data[firstText.name] : null;
  return typeof value === 'string' && value ? value : record.id;
}

/** Rows in `ref.table` whose `ref.field` points at this record. */
function relatedRows(
  recordsDb: RecordsDb,
  ref: InboundRef,
  recordId: string,
): WorkspaceRecord[] {
  const { records } = queryRecords(recordsDb, ref.table, {
    filters: [{ field: ref.field.name, op: 'eq', value: recordId as JsonValue }],
    limit: AGGREGATE_LIMIT,
  });
  return records;
}

/** Money fields on a table worth totalling in a related list. */
function rollupFieldsFor(table: WorkspaceTable): WorkspaceField[] {
  const roles = ['total', 'amount', 'deal-value'] as const;
  const byRole = roles
    .map((role) => fieldWithRole(table, role))
    .filter((field): field is WorkspaceField => field !== null);
  if (byRole.length > 0) return [byRole[0]!];
  // No role marked: fall back to the first money column, which is what
  // someone building their own table would expect to see totalled.
  const money = table.fields.find((field) => field.type === 'money');
  return money ? [money] : [];
}

export function buildRelatedLists(
  recordsDb: RecordsDb,
  table: WorkspaceTable,
  record: WorkspaceRecord,
): RecordRelatedList[] {
  const lists: RecordRelatedList[] = [];

  for (const ref of inboundReferences(recordsDb, table.id)) {
    // A self-link would list the record under itself; skip the row rather than
    // the whole list, so `employees.manager` still shows direct reports.
    const rows = relatedRows(recordsDb, ref, record.id).filter((row) => row.id !== record.id);
    if (rows.length === 0) continue;

    const shown = rows.slice(0, RELATED_LIMIT);
    const rollups: RecordRollup[] = rollupFieldsFor(ref.table).map((field) => ({
      field: field.name,
      label: field.displayName,
      fn: 'sum',
      value: rows.reduce((total, row) => {
        const value = row.data[field.name];
        return total + (typeof value === 'number' && Number.isInteger(value) ? value : 0);
      }, 0),
    }));

    lists.push({
      tableId: ref.table.id,
      tableName: ref.table.name,
      tableDisplayName: ref.table.displayName,
      /** Which field on the other table points back here — the UI prefills it
       * when creating a related row, so "New invoice" from a customer arrives
       * with the customer already set. */
      viaField: ref.field.name,
      viaFieldLabel: ref.field.displayName,
      total: rows.length,
      // True when the shown list is a preview of a longer one, or when the
      // aggregate ceiling was reached and `total` is really a floor.
      truncated: rows.length > RELATED_LIMIT || rows.length >= AGGREGATE_LIMIT,
      rollups,
      records: shown.map((row) => ({
        recordId: row.id,
        label: recordLabel(ref.table, row),
        data: row.data,
        updatedAt: row.updatedAt,
      })),
    });
  }

  // Biggest relationships first: the list someone opened the record to see is
  // usually the one with the most in it.
  lists.sort((a, b) => b.total - a.total);
  return lists;
}

/** What this record points at, resolved to labels so the UI shows "Northwind"
 * instead of `rec-8f1c…`. */
export function buildLinkedRecords(
  recordsDb: RecordsDb,
  table: WorkspaceTable,
  record: WorkspaceRecord,
): RecordDetail['links'] {
  const links: RecordDetail['links'] = [];
  for (const field of table.fields) {
    if (field.type !== 'link') continue;
    const value = record.data[field.name];
    if (typeof value !== 'string' || !value) continue;
    const targetTableId = (field.config as { targetTableId?: string } | null)?.targetTableId;
    if (!targetTableId) continue;
    try {
      const target = loadTable(recordsDb, targetTableId);
      const linked = getRecord(recordsDb, value);
      links.push({
        field: field.name,
        fieldLabel: field.displayName,
        tableName: target.name,
        recordId: linked.id,
        // A deleted target still shows, marked, rather than vanishing — a
        // dangling reference is information.
        label: recordLabel(target, linked),
        deleted: linked.deletedAt !== null,
      });
    } catch {
      // The target is gone entirely. Say so rather than dropping the row.
      links.push({
        field: field.name,
        fieldLabel: field.displayName,
        tableName: '',
        recordId: value,
        label: value,
        deleted: true,
      });
    }
  }
  return links;
}

/** Document actions available on this record right now, so the UI does not
 * have to re-derive the hub's rules. */
export function availableActions(table: WorkspaceTable, record: WorkspaceRecord): string[] {
  const actions: string[] = [];
  if (isPostableTable(table.name)) actions.push('post');

  const conversions: Record<string, string> = {
    quotes: 'orders',
    orders: 'invoices',
    purchase_orders: 'bills',
    deals: 'quotes',
  };
  const to = conversions[table.name];
  if (to) actions.push(`convert:${to}`);

  const statusField = fieldWithRole(table, 'status');
  if (statusField) actions.push('status');
  void record;
  return actions;
}

export function buildRecordDetail(
  recordsDb: RecordsDb,
  recordId: string,
): RecordDetail {
  const record = getRecord(recordsDb, recordId);
  const table = loadTable(recordsDb, record.tableId);
  // Formula fields are filled in here too, so a record page and a grid row
  // cannot show different values for the same column.
  const withFormulas = applyFormulas(table, record);

  return {
    record: withFormulas,
    table,
    title: recordLabel(table, withFormulas),
    links: buildLinkedRecords(recordsDb, table, withFormulas),
    related: buildRelatedLists(recordsDb, table, withFormulas),
    actions: availableActions(table, withFormulas),
  };
}
