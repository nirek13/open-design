// The single write chokepoint for workspace records. EVERY mutation — UI,
// CLI, agent tool, public form, and (later) approval replay, migration apply,
// and playbook confirm — flows through these functions. That is what makes
// the platform promises enforceable: validation, link integrity, soft
// delete, full row history, and audit attribution cannot be bypassed by any
// generated interface.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  JsonValue,
  WorkspaceField,
  WorkspaceRecord,
  WorkspaceRecordOp,
  WorkspaceRecordRevision,
  WorkspaceTable,
} from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import { appendAuditEvent } from './audit.js';
import { fieldForUniqueViolation, loadTable, validateRecordData } from './schema.js';
import type { WorkspaceActor } from './types.js';

type SqliteDb = Database.Database;

const RECORD_COLS = `
  id, table_id AS tableId, data_json AS dataJson, revision,
  created_by_kind AS createdByKind, created_by_id AS createdById,
  created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
`;

const REVISION_COLS = `
  id, record_id AS recordId, table_id AS tableId, revision, op,
  data_json AS dataJson, audit_event_id AS auditEventId, created_at AS createdAt
`;

export function normalizeRecordRow(row: Record<string, any>): WorkspaceRecord {
  const { dataJson, ...rest } = row;
  let data: Record<string, JsonValue> = {};
  try {
    data = JSON.parse(dataJson);
  } catch {
    data = {};
  }
  return { ...(rest as Omit<WorkspaceRecord, 'data'>), data };
}

function normalizeRevisionRow(row: Record<string, any>): WorkspaceRecordRevision {
  const { dataJson, ...rest } = row;
  let data: Record<string, JsonValue> = {};
  try {
    data = JSON.parse(dataJson);
  } catch {
    data = {};
  }
  return { ...(rest as Omit<WorkspaceRecordRevision, 'data'>), data };
}

export function getRecord(db: SqliteDb, recordId: string): WorkspaceRecord {
  const row = db.prepare(`SELECT ${RECORD_COLS} FROM od_records WHERE id = ?`).get(recordId) as
    | Record<string, any>
    | undefined;
  if (!row) {
    throw new WorkspaceDataError('WORKSPACE_RECORD_NOT_FOUND', 404, `record ${recordId} not found`);
  }
  return normalizeRecordRow(row);
}

export function listRecordRevisions(db: SqliteDb, recordId: string): WorkspaceRecordRevision[] {
  getRecord(db, recordId);
  const rows = db
    .prepare(`SELECT ${REVISION_COLS} FROM od_record_revisions WHERE record_id = ? ORDER BY revision ASC`)
    .all(recordId) as Array<Record<string, any>>;
  return rows.map(normalizeRevisionRow);
}

function linkFields(table: WorkspaceTable): WorkspaceField[] {
  return table.fields.filter((field) => field.type === 'link');
}

/** Every link value must point at an existing, non-deleted record in the
 * field's target table. Checked for the provided keys only, so partial
 * updates revalidate exactly what changed. */
function assertLinkTargetsValid(
  db: SqliteDb,
  table: WorkspaceTable,
  data: Record<string, JsonValue>,
  changedKeys: ReadonlySet<string>,
): void {
  for (const field of linkFields(table)) {
    if (!changedKeys.has(field.name)) continue;
    const value = data[field.name];
    if (value === undefined || value === null) continue;
    const targetTableId = field.config?.targetTableId;
    const target = db
      .prepare('SELECT table_id AS tableId, deleted_at AS deletedAt FROM od_records WHERE id = ?')
      .get(value as string) as { tableId: string; deletedAt: number | null } | undefined;
    if (!target || target.tableId !== targetTableId || target.deletedAt !== null) {
      throw new WorkspaceDataError(
        'WORKSPACE_LINK_VIOLATION',
        422,
        `data.${field.name}: linked record ${String(value)} not found in target table`,
      );
    }
  }
}

function rethrowUniqueViolation(err: unknown, table: WorkspaceTable): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('UNIQUE constraint failed')) {
    const field = fieldForUniqueViolation(table, message);
    throw new WorkspaceDataError(
      'WORKSPACE_UNIQUE_VIOLATION',
      409,
      field
        ? `data.${field.name}: value collides with an existing record`
        : 'a unique field collides with an existing record',
      field ? { field: field.name } : undefined,
    );
  }
  throw err;
}

function insertRevision(
  db: SqliteDb,
  record: { id: string; tableId: string; revision: number },
  op: WorkspaceRecordOp,
  dataJson: string,
  auditEventId: string,
): void {
  db.prepare(
    `INSERT INTO od_record_revisions
       (id, record_id, table_id, revision, op, data_json, audit_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`rev-${randomUUID()}`, record.id, record.tableId, record.revision, op, dataJson, auditEventId, Date.now());
}

export function createRecord(
  db: SqliteDb,
  table: WorkspaceTable,
  actor: WorkspaceActor,
  data: Record<string, JsonValue>,
): WorkspaceRecord {
  if (table.status !== 'active') {
    throw new WorkspaceDataError('WORKSPACE_TABLE_NOT_FOUND', 404, `table ${table.id} is archived`);
  }
  validateRecordData(table, data);
  assertLinkTargetsValid(db, table, data, new Set(Object.keys(data)));
  const now = Date.now();
  const id = `rec-${randomUUID()}`;
  const dataJson = JSON.stringify(data);
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO od_records
         (id, table_id, data_json, revision, created_by_kind, created_by_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
    ).run(id, table.id, dataJson, actor.kind, actor.memberId ?? actor.runId ?? null, now, now);
    const auditEventId = appendAuditEvent(db, {
      actor,
      op: 'record.create',
      subjectKind: 'record',
      subjectId: id,
      tableId: table.id,
      patch: { before: null, after: data },
    });
    insertRevision(db, { id, tableId: table.id, revision: 1 }, 'create', dataJson, auditEventId);
  });
  try {
    insert();
  } catch (err) {
    rethrowUniqueViolation(err, table);
  }
  return getRecord(db, id);
}

export function updateRecord(
  db: SqliteDb,
  table: WorkspaceTable,
  actor: WorkspaceActor,
  recordId: string,
  patch: Record<string, JsonValue>,
  expectedRevision?: number,
): WorkspaceRecord {
  const existing = getRecord(db, recordId);
  if (existing.tableId !== table.id) {
    throw new WorkspaceDataError('WORKSPACE_RECORD_NOT_FOUND', 404, `record ${recordId} not found`);
  }
  if (existing.deletedAt !== null) {
    throw new WorkspaceDataError('WORKSPACE_RECORD_DELETED', 409, `record ${recordId} is deleted; restore it first`);
  }
  if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
    throw new WorkspaceDataError(
      'WORKSPACE_REVISION_CONFLICT',
      409,
      `record ${recordId} is at revision ${existing.revision}, expected ${expectedRevision}`,
    );
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'data must be an object');
  }
  const merged: Record<string, JsonValue> = { ...existing.data };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  validateRecordData(table, merged);
  assertLinkTargetsValid(db, table, merged, new Set(Object.keys(patch)));
  const revision = existing.revision + 1;
  const dataJson = JSON.stringify(merged);
  const apply = db.transaction(() => {
    db.prepare('UPDATE od_records SET data_json = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(dataJson, revision, Date.now(), recordId);
    const auditEventId = appendAuditEvent(db, {
      actor,
      op: 'record.update',
      subjectKind: 'record',
      subjectId: recordId,
      tableId: table.id,
      patch: { before: existing.data, after: merged },
    });
    insertRevision(db, { id: recordId, tableId: table.id, revision }, 'update', dataJson, auditEventId);
  });
  try {
    apply();
  } catch (err) {
    rethrowUniqueViolation(err, table);
  }
  return getRecord(db, recordId);
}

interface InboundLink {
  table: WorkspaceTable;
  field: WorkspaceField;
  onDelete: 'restrict' | 'clear';
}

/** All active link fields anywhere in the workspace that target `tableId`. */
function inboundLinksTo(db: SqliteDb, tableId: string): InboundLink[] {
  const rows = db
    .prepare(
      `SELECT f.table_id AS tableId, f.id AS fieldId
         FROM od_fields f JOIN od_tables t ON t.id = f.table_id
        WHERE f.status = 'active' AND t.status = 'active' AND f.type = 'link'`,
    )
    .all() as Array<{ tableId: string; fieldId: string }>;
  const out: InboundLink[] = [];
  for (const row of rows) {
    const table = loadTable(db, row.tableId);
    const field = table.fields.find((candidate) => candidate.id === row.fieldId);
    if (!field || field.config?.targetTableId !== tableId) continue;
    out.push({ table, field, onDelete: field.config?.onDelete === 'clear' ? 'clear' : 'restrict' });
  }
  return out;
}

export function softDeleteRecord(
  db: SqliteDb,
  table: WorkspaceTable,
  actor: WorkspaceActor,
  recordId: string,
): WorkspaceRecord {
  const existing = getRecord(db, recordId);
  if (existing.tableId !== table.id) {
    throw new WorkspaceDataError('WORKSPACE_RECORD_NOT_FOUND', 404, `record ${recordId} not found`);
  }
  if (existing.deletedAt !== null) {
    throw new WorkspaceDataError('WORKSPACE_RECORD_DELETED', 409, `record ${recordId} is already deleted`);
  }
  const inbound = inboundLinksTo(db, table.id);
  const referrersByLink = inbound.map((link) => ({
    link,
    referrers: db
      .prepare(
        `SELECT ${RECORD_COLS} FROM od_records
          WHERE table_id = ? AND deleted_at IS NULL
            AND json_extract(data_json, '$.${link.field.name}') = ?`,
      )
      .all(link.table.id, recordId) as Array<Record<string, any>>,
  }));
  for (const { link, referrers } of referrersByLink) {
    if (link.onDelete === 'restrict' && referrers.length > 0) {
      throw new WorkspaceDataError(
        'WORKSPACE_LINK_VIOLATION',
        409,
        `${referrers.length} active record(s) in '${link.table.name}' still link to ${recordId} via '${link.field.name}'`,
      );
    }
  }
  const revision = existing.revision + 1;
  const apply = db.transaction(() => {
    const now = Date.now();
    // onDelete 'clear' referrers lose the link in the same transaction, each
    // with its own revision + audit event so the history stays complete.
    for (const { link, referrers } of referrersByLink) {
      if (link.onDelete !== 'clear') continue;
      for (const row of referrers) {
        const referrer = normalizeRecordRow(row);
        const cleared: Record<string, JsonValue> = { ...referrer.data };
        delete cleared[link.field.name];
        const clearedJson = JSON.stringify(cleared);
        const nextRevision = referrer.revision + 1;
        db.prepare('UPDATE od_records SET data_json = ?, revision = ?, updated_at = ? WHERE id = ?')
          .run(clearedJson, nextRevision, now, referrer.id);
        const clearAuditId = appendAuditEvent(db, {
          actor,
          op: 'record.update',
          subjectKind: 'record',
          subjectId: referrer.id,
          tableId: link.table.id,
          summary: `link '${link.field.name}' cleared by soft-delete of ${recordId}`,
          patch: { before: referrer.data, after: cleared },
        });
        insertRevision(
          db,
          { id: referrer.id, tableId: link.table.id, revision: nextRevision },
          'update',
          clearedJson,
          clearAuditId,
        );
      }
    }
    db.prepare('UPDATE od_records SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(now, revision, now, recordId);
    const auditEventId = appendAuditEvent(db, {
      actor,
      op: 'record.soft-delete',
      subjectKind: 'record',
      subjectId: recordId,
      tableId: table.id,
    });
    insertRevision(
      db,
      { id: recordId, tableId: table.id, revision },
      'soft-delete',
      JSON.stringify(existing.data),
      auditEventId,
    );
  });
  apply();
  return getRecord(db, recordId);
}

export function restoreRecord(
  db: SqliteDb,
  table: WorkspaceTable,
  actor: WorkspaceActor,
  recordId: string,
): WorkspaceRecord {
  const existing = getRecord(db, recordId);
  if (existing.tableId !== table.id) {
    throw new WorkspaceDataError('WORKSPACE_RECORD_NOT_FOUND', 404, `record ${recordId} not found`);
  }
  if (existing.deletedAt === null) {
    throw new WorkspaceDataError('CONFLICT', 409, `record ${recordId} is not deleted`);
  }
  const revision = existing.revision + 1;
  const apply = db.transaction(() => {
    // Re-entering the live set re-applies the partial unique indexes, so a
    // restore that would collide with a newer record fails atomically here.
    db.prepare('UPDATE od_records SET deleted_at = NULL, revision = ?, updated_at = ? WHERE id = ?')
      .run(revision, Date.now(), recordId);
    const auditEventId = appendAuditEvent(db, {
      actor,
      op: 'record.restore',
      subjectKind: 'record',
      subjectId: recordId,
      tableId: table.id,
    });
    insertRevision(
      db,
      { id: recordId, tableId: table.id, revision },
      'restore',
      JSON.stringify(existing.data),
      auditEventId,
    );
  });
  try {
    apply();
  } catch (err) {
    rethrowUniqueViolation(err, table);
  }
  return getRecord(db, recordId);
}
