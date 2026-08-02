// Append-only audit trail. Rows are guarded by BEFORE UPDATE/DELETE triggers
// in storage/workspace-db.ts, so this module only ever inserts and reads.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { JsonValue, WorkspaceAuditEvent, WorkspaceAuditSubjectKind } from '@open-design/contracts';
import type { WorkspaceActor } from './types.js';

type SqliteDb = Database.Database;

// `rowid` is the insertion sequence and is the ONLY correct sort key for this
// table. created_at has millisecond resolution, so several events in one write
// transaction (e.g. clearing referrer links while soft-deleting their target)
// share a timestamp; tie-breaking on the random UUID id would let the trail
// report effects before their causes. Deletes are blocked by trigger, so rowid
// is strictly increasing and never reused.
const AUDIT_COLS = `
  rowid AS seq,
  id, actor_kind AS actorKind, actor_member_id AS actorMemberId,
  tool_id AS toolId, run_id AS runId, project_id AS projectId,
  op, subject_kind AS subjectKind, subject_id AS subjectId,
  table_id AS tableId, summary, patch_json AS patchJson, created_at AS createdAt
`;

export interface AppendAuditEventInput {
  actor: WorkspaceActor;
  op: string;
  subjectKind: WorkspaceAuditSubjectKind;
  subjectId: string;
  tableId?: string | null;
  summary?: string | null;
  patch?: JsonValue | null;
}

/** Insert one audit event. Call inside the caller's write transaction so the
 * event commits (or rolls back) atomically with the mutation it describes. */
export function appendAuditEvent(db: SqliteDb, input: AppendAuditEventInput): string {
  const id = `aud-${randomUUID()}`;
  db.prepare(
    `INSERT INTO od_audit_events
       (id, actor_kind, actor_member_id, tool_id, run_id, project_id,
        op, subject_kind, subject_id, table_id, summary, patch_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.actor.kind,
    input.actor.memberId ?? null,
    input.actor.toolId ?? null,
    input.actor.runId ?? null,
    input.actor.projectId ?? null,
    input.op,
    input.subjectKind,
    input.subjectId,
    input.tableId ?? null,
    input.summary ?? null,
    input.patch === undefined || input.patch === null ? null : JSON.stringify(input.patch),
    Date.now(),
  );
  return id;
}

function normalizeAuditRow(row: Record<string, unknown>): WorkspaceAuditEvent {
  const { patchJson, seq, ...rest } = row as Record<string, any>;
  void seq;
  let patch: JsonValue | null = null;
  if (typeof patchJson === 'string') {
    try {
      patch = JSON.parse(patchJson);
    } catch {
      patch = null;
    }
  }
  return { ...(rest as Omit<WorkspaceAuditEvent, 'patch'>), patch };
}

export interface ListAuditEventsOptions {
  tableId?: string | undefined;
  subjectId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | null | undefined;
}

export interface AuditEventsPage {
  events: WorkspaceAuditEvent[];
  nextCursor: string | null;
}

interface AuditCursor {
  /** Insertion sequence (rowid) of the last row on the previous page. */
  seq: number;
}

function decodeAuditCursor(cursor: string): AuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.seq === 'number') return { seq: parsed.seq };
  } catch {
    // fall through
  }
  throw Object.assign(new Error('invalid audit cursor'), { code: 'BAD_REQUEST' });
}

export function listAuditEvents(db: SqliteDb, options: ListAuditEventsOptions = {}): AuditEventsPage {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.tableId) {
    where.push('table_id = ?');
    params.push(options.tableId);
  }
  if (options.subjectId) {
    where.push('subject_id = ?');
    params.push(options.subjectId);
  }
  if (options.cursor) {
    where.push('rowid < ?');
    params.push(decodeAuditCursor(options.cursor).seq);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT ${AUDIT_COLS} FROM od_audit_events ${whereSql}
       ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  const events = rows.map(normalizeAuditRow);
  const lastSeq = rows[rows.length - 1]?.seq;
  const nextCursor =
    rows.length === limit && typeof lastSeq === 'number'
      ? Buffer.from(JSON.stringify({ seq: lastSeq })).toString('base64url')
      : null;
  return { events, nextCursor };
}
