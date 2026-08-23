// Finding anything, from one box.
//
// People do not think in tables. They think "Northwind" or "INV-1042" and
// expect the thing to come back. So search runs across every table in the
// organization at once and returns results that name themselves — a label
// worth reading, not a row id.
//
// Deliberately simple matching (case-insensitive substring) rather than a
// full-text index. At the scale one organization's records reach, a scan is
// fast and always correct; an index that can fall out of date is worse than
// no index. If this ever gets slow, the fix is FTS5 over the same shape.

import type { WorkspaceField, WorkspaceRecord, WorkspaceTable } from '@open-design/contracts';
import { listTables } from './schema.js';
import { queryRecords } from './query.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

export interface SearchHit {
  tableId: string;
  tableName: string;
  tableDisplayName: string;
  recordId: string;
  /** What to show as the result's title. */
  label: string;
  /** A second line of context, when there is something worth saying. */
  secondary: string | null;
  /** The field the match was found in, so the UI can explain the hit. */
  matchedField: string;
  updatedAt: number;
}

export interface SearchResultGroup {
  tableId: string;
  tableName: string;
  tableDisplayName: string;
  hits: SearchHit[];
  /** Total matches in this table, which may exceed the hits returned. */
  total: number;
}

/** Which field best identifies a record to a human. Prefers an explicit
 * document number, then a name-ish field, then the first required text
 * field — anything but the uuid. */
export function labelField(table: WorkspaceTable): WorkspaceField | null {
  const byRole = table.fields.find(
    (field) => (field.config as { role?: string } | null)?.role === 'document-number',
  );
  if (byRole) return byRole;
  const byName = table.fields.find(
    (field) => field.type === 'text' && /^(name|title|label|full_name)$/.test(field.name),
  );
  if (byName) return byName;
  const required = table.fields.find((field) => field.type === 'text' && field.required);
  if (required) return required;
  return table.fields.find((field) => field.type === 'text') ?? null;
}

/** A short second line: the customer, the status, the total — whatever the
 * table happens to carry that adds context. */
function secondaryText(table: WorkspaceTable, record: WorkspaceRecord): string | null {
  const parts: string[] = [];
  for (const field of table.fields) {
    const role = (field.config as { role?: string } | null)?.role;
    if (role !== 'status' && role !== 'total' && role !== 'amount' && role !== 'issue-date') continue;
    const value = record.data[field.name];
    if (value === undefined || value === null) continue;
    if (field.type === 'money' && typeof value === 'number') {
      parts.push(`${(value / 100).toFixed(2)}`);
    } else {
      parts.push(String(value));
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function recordLabel(table: WorkspaceTable, record: WorkspaceRecord): string {
  const field = labelField(table);
  const value = field ? record.data[field.name] : undefined;
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  // Nothing readable on the record — fall back to something that at least
  // says what it is rather than showing a bare uuid.
  return `${table.displayName || table.name} record`;
}

/** Fields worth searching: text-ish ones a person would actually type. */
function searchableFields(table: WorkspaceTable): WorkspaceField[] {
  return table.fields.filter(
    (field) => field.type === 'text' || field.type === 'select' || field.type === 'date',
  );
}

export interface SearchOptions {
  /** Cap per table, so one huge table cannot crowd out the rest. */
  perTable?: number;
  /** Restrict to specific tables by name or id. */
  tableRefs?: string[];
  includeDeleted?: boolean;
}

export function searchWorkspace(
  db: RecordsDb,
  query: string,
  options: SearchOptions = {},
): SearchResultGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const perTable = Math.min(25, Math.max(1, options.perTable ?? 5));

  const tables = listTables(db).filter((table) => {
    if (!options.tableRefs || options.tableRefs.length === 0) return true;
    return options.tableRefs.includes(table.name) || options.tableRefs.includes(table.id);
  });

  const groups: SearchResultGroup[] = [];
  for (const table of tables) {
    const fields = searchableFields(table);
    if (fields.length === 0) continue;

    // One pass over the table's records. `queryRecords` already excludes
    // soft-deleted rows unless asked otherwise.
    const { records } = queryRecords(db, table, {
      limit: 200,
      ...(options.includeDeleted ? { includeDeleted: true } : {}),
    });

    const hits: SearchHit[] = [];
    for (const record of records) {
      let matchedField: string | null = null;
      for (const field of fields) {
        const value = record.data[field.name];
        if (typeof value !== 'string') continue;
        if (value.toLowerCase().includes(needle)) {
          matchedField = field.name;
          break;
        }
      }
      if (!matchedField) continue;
      hits.push({
        tableId: table.id,
        tableName: table.name,
        tableDisplayName: table.displayName || table.name,
        recordId: record.id,
        label: recordLabel(table, record),
        secondary: secondaryText(table, record),
        matchedField,
        updatedAt: record.updatedAt,
      });
    }

    if (hits.length === 0) continue;
    hits.sort((a, b) => b.updatedAt - a.updatedAt);
    groups.push({
      tableId: table.id,
      tableName: table.name,
      tableDisplayName: table.displayName || table.name,
      hits: hits.slice(0, perTable),
      total: hits.length,
    });
  }

  // Tables with more matches first — if someone types a customer name, the
  // customer itself should outrank the twelve invoices mentioning them.
  groups.sort((a, b) => b.total - a.total);
  return groups;
}

export interface RecentRecord extends SearchHit {}

/** The most recently touched records across the whole organization — what
 * someone opening the app wants to see before they have typed anything. */
export function recentRecords(db: RecordsDb, limit = 12): RecentRecord[] {
  const out: RecentRecord[] = [];
  for (const table of listTables(db)) {
    const { records } = queryRecords(db, table, {
      sort: { field: 'updated_at', direction: 'desc' },
      limit,
    });
    for (const record of records) {
      out.push({
        tableId: table.id,
        tableName: table.name,
        tableDisplayName: table.displayName || table.name,
        recordId: record.id,
        label: recordLabel(table, record),
        secondary: secondaryText(table, record),
        matchedField: '',
        updatedAt: record.updatedAt,
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}
