// Saved views over a table.
//
// A view stores no records — filters, sorts, grouping, which fields, drawn
// how. That is what makes them free to create: you cannot damage data with a
// lens, so nobody has to think before making one.
//
// Written against SqlExecutor so it runs on SQLite and Postgres unchanged.

import { randomUUID } from 'node:crypto';
import {
  VIEW_KINDS,
  type CreateWorkspaceViewRequest,
  type UpdateWorkspaceViewRequest,
  type ViewGroup,
  type ViewKind,
  type WorkspaceRecord,
  type WorkspaceRecordFilter,
  type WorkspaceRecordSort,
  type WorkspaceTable,
  type WorkspaceView,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';

const VIEW_COLS = `
  id, workspace_id AS "orgId", table_id AS "tableId", name, kind,
  filters_json AS "filtersJson", sorts_json AS "sortsJson",
  group_by AS "groupBy", date_field AS "dateField",
  visible_fields_json AS "visibleFieldsJson", position,
  is_default AS "isDefault", created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toView(row: Record<string, any>): WorkspaceView {
  return {
    id: row.id,
    orgId: row.orgId,
    tableId: row.tableId,
    name: row.name,
    kind: row.kind as ViewKind,
    filters: parseJson<WorkspaceRecordFilter[]>(row.filtersJson, []),
    sorts: parseJson<WorkspaceRecordSort[]>(row.sortsJson, []),
    groupBy: row.groupBy ?? null,
    dateField: row.dateField ?? null,
    visibleFields:
      row.visibleFieldsJson === null || row.visibleFieldsJson === undefined
        ? null
        : parseJson<string[] | null>(row.visibleFieldsJson, null),
    position: num(row.position),
    isDefault: row.isDefault === 1 || row.isDefault === true,
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

/** A board needs something to make columns out of, and a calendar needs a
 * date. Refusing here beats rendering one column called "everything" and
 * leaving the person to work out why. */
function assertShape(kind: ViewKind, groupBy: string | null, dateField: string | null): void {
  if (!VIEW_KINDS.includes(kind)) {
    throw workspaceValidationError([
      { path: 'kind', message: `kind must be one of: ${VIEW_KINDS.join(', ')}` },
    ]);
  }
  if (kind === 'board' && !groupBy) {
    throw workspaceValidationError([
      { path: 'groupBy', message: 'a board view needs a field to group its columns by' },
    ]);
  }
  if (kind === 'calendar' && !dateField) {
    throw workspaceValidationError([
      { path: 'dateField', message: 'a calendar view needs a date field to lay records out on' },
    ]);
  }
}

export async function listViews(
  db: SqlExecutor,
  orgId: string,
  tableId: string,
): Promise<WorkspaceView[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT ${VIEW_COLS} FROM od_views WHERE workspace_id = ? AND table_id = ?
      ORDER BY position ASC, created_at ASC`,
    [orgId, tableId],
  );
  return rows.map(toView);
}

export async function getView(db: SqlExecutor, orgId: string, viewId: string): Promise<WorkspaceView> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${VIEW_COLS} FROM od_views WHERE id = ? AND workspace_id = ?`,
    [viewId, orgId],
  );
  if (!row) throw new WorkspaceDataError('WORKSPACE_TABLE_NOT_FOUND', 404, `no view ${viewId}`);
  return toView(row);
}

export async function createView(
  db: SqlExecutor,
  orgId: string,
  tableId: string,
  createdBy: string,
  input: CreateWorkspaceViewRequest,
): Promise<WorkspaceView> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw workspaceValidationError([{ path: 'name', message: 'a view needs a name' }]);

  const kind = input.kind ?? 'table';
  const groupBy = input.groupBy ?? null;
  const dateField = input.dateField ?? null;
  assertShape(kind, groupBy, dateField);

  const existing = await listViews(db, orgId, tableId);
  // The first view on a table is its default; there is nothing else to open.
  const isDefault = input.isDefault ?? existing.length === 0;
  if (isDefault) await clearDefault(db, orgId, tableId);

  const now = Date.now();
  const id = `vw-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_views
       (id, workspace_id, table_id, name, kind, filters_json, sorts_json,
        group_by, date_field, visible_fields_json, position, is_default,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      tableId,
      name,
      kind,
      JSON.stringify(input.filters ?? []),
      JSON.stringify(input.sorts ?? []),
      groupBy,
      dateField,
      input.visibleFields ? JSON.stringify(input.visibleFields) : null,
      existing.length,
      isDefault ? 1 : 0,
      createdBy,
      now,
      now,
    ],
  );
  return getView(db, orgId, id);
}

/** Exactly one default per table. Cleared before setting a new one rather
 * than checked afterwards, so two tabs racing cannot both win. */
async function clearDefault(db: SqlExecutor, orgId: string, tableId: string): Promise<void> {
  await db.run(
    'UPDATE od_views SET is_default = 0 WHERE workspace_id = ? AND table_id = ? AND is_default = 1',
    [orgId, tableId],
  );
}

export async function updateView(
  db: SqlExecutor,
  orgId: string,
  viewId: string,
  input: UpdateWorkspaceViewRequest,
): Promise<WorkspaceView> {
  const current = await getView(db, orgId, viewId);
  const kind = input.kind ?? current.kind;
  const groupBy = input.groupBy === undefined ? current.groupBy : input.groupBy;
  const dateField = input.dateField === undefined ? current.dateField : input.dateField;
  assertShape(kind, groupBy, dateField);

  if (input.isDefault) await clearDefault(db, orgId, current.tableId);

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw workspaceValidationError([{ path: 'name', message: 'a view needs a name' }]);
    set('name', name);
  }
  if (input.kind !== undefined) set('kind', kind);
  if (input.filters !== undefined) set('filters_json', JSON.stringify(input.filters));
  if (input.sorts !== undefined) set('sorts_json', JSON.stringify(input.sorts));
  if (input.groupBy !== undefined) set('group_by', groupBy);
  if (input.dateField !== undefined) set('date_field', dateField);
  if (input.visibleFields !== undefined) {
    set('visible_fields_json', input.visibleFields ? JSON.stringify(input.visibleFields) : null);
  }
  if (input.position !== undefined) set('position', input.position);
  if (input.isDefault !== undefined) set('is_default', input.isDefault ? 1 : 0);

  if (sets.length === 0) return current;
  set('updated_at', Date.now());
  params.push(viewId);
  await db.run(`UPDATE od_views SET ${sets.join(', ')} WHERE id = ?`, params);
  return getView(db, orgId, viewId);
}

export async function deleteView(db: SqlExecutor, orgId: string, viewId: string): Promise<void> {
  const view = await getView(db, orgId, viewId);
  await db.run('DELETE FROM od_views WHERE id = ?', [viewId]);
  // Never leave a table with views but no default — the next one along takes
  // over, so opening the table still lands somewhere.
  if (view.isDefault) {
    const remaining = await listViews(db, orgId, view.tableId);
    const next = remaining[0];
    if (next) await db.run('UPDATE od_views SET is_default = 1 WHERE id = ?', [next.id]);
  }
}

/** The starting view every table gets, so a table is never viewless. */
export async function ensureDefaultView(
  db: SqlExecutor,
  orgId: string,
  table: WorkspaceTable,
  createdBy: string,
): Promise<WorkspaceView> {
  const existing = await listViews(db, orgId, table.id);
  const current = existing.find((view) => view.isDefault) ?? existing[0];
  if (current) return current;
  return createView(db, orgId, table.id, createdBy, { name: 'All', kind: 'table', isDefault: true });
}

// --- Grouping -------------------------------------------------------------

/** Bucket records by a field's value, for a board's columns or a grouped
 * table's sections. */
export function groupRecords(
  records: WorkspaceRecord[],
  table: WorkspaceTable,
  fieldName: string,
): ViewGroup[] {
  const field = table.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw workspaceValidationError([
      { path: 'groupBy', message: `${table.name} has no field called ${fieldName}` },
    ]);
  }

  const buckets = new Map<string | null, string[]>();
  // A select field's own options seed the map so empty columns still render —
  // an empty "Blocked" column is information, and a board that hides it looks
  // like nothing is blocked.
  const options = (field.config as { options?: string[] } | null)?.options;
  if (Array.isArray(options)) for (const option of options) buckets.set(option, []);

  for (const record of records) {
    const raw = record.data[fieldName];
    const key = raw === null || raw === undefined || raw === '' ? null : String(raw);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record.id);
    else buckets.set(key, [record.id]);
  }

  const groups: ViewGroup[] = [];
  for (const [key, recordIds] of buckets) {
    groups.push({
      key,
      // "No status" is a real answer people need to see, not rows to hide.
      label: key ?? `No ${field.displayName.toLowerCase()}`,
      recordIds,
      count: recordIds.length,
    });
  }
  // Empty groups last, so a board opens on the columns that have work in them.
  groups.sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0));
  return groups;
}
