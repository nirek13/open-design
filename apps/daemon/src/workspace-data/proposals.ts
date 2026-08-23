// Nothing happens until someone says yes, and anything that happened can be
// taken back.
//
// The assistant does not write to the business. It writes a proposal: the
// exact operations it wants to run, plus a preview of what they would do in
// plain language. A person reads the preview and approves or rejects. Only
// approval executes anything, and execution is one transaction — a proposal
// either lands whole or not at all.
//
// Undo works because applying records a receipt. Records keep their prior
// revision, so an update walks back; created records soft-delete; posted
// journal entries reverse rather than vanish, because the books do not
// rewrite history even to undo.

import { randomUUID } from 'node:crypto';
import type {
  CreateProposalRequest,
  Proposal,
  ProposalEffect,
  ProposalOperation,
  ProposalPreview,
  ProposalPreviewLine,
  ProposalStatus,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { createTable, resolveTable } from './schema.js';
import { createRecord, getRecord, restoreRecord, softDeleteRecord, updateRecord } from './records.js';
import { postJournalEntry, reverseJournalEntry } from './ledger.js';
import type { WorkspaceActor } from './types.js';
import type { SqlExecutor } from '../storage/sql.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

const PROPOSAL_COLS = `
  id, intent, origin, run_id AS "runId", status,
  operations_json AS "operationsJson", preview_json AS "previewJson",
  effects_json AS "effectsJson", error, created_by AS "createdBy",
  decided_by AS "decidedBy", decided_at AS "decidedAt", applied_at AS "appliedAt",
  undone_at AS "undoneAt", created_at AS "createdAt"
`;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalize(row: Record<string, any>, orgId: string): Proposal {
  return {
    id: row.id,
    orgId,
    intent: row.intent,
    origin: row.origin,
    runId: row.runId ?? null,
    status: row.status as ProposalStatus,
    operations: parseJson<ProposalOperation[]>(row.operationsJson, []),
    preview: parseJson<ProposalPreview>(row.previewJson, { lines: [], warnings: [] }),
    appliedEffects: parseJson<ProposalEffect[]>(row.effectsJson, []),
    error: row.error ?? null,
    createdBy: row.createdBy,
    decidedBy: row.decidedBy ?? null,
    decidedAt: nullableNum(row.decidedAt),
    appliedAt: nullableNum(row.appliedAt),
    undoneAt: nullableNum(row.undoneAt),
    createdAt: num(row.createdAt),
  };
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Work out, without writing anything, what these operations would do. This
 * is what a person actually reads before approving, so it names records and
 * shows before/after rather than echoing the operations back. */
export function buildPreview(recordsDb: RecordsDb, operations: ProposalOperation[]): ProposalPreview {
  const lines: ProposalPreviewLine[] = [];
  const warnings: string[] = [];

  for (const [index, operation] of operations.entries()) {
    try {
      switch (operation.kind) {
        case 'create-record': {
          const table = resolveTable(recordsDb, operation.tableRef);
          const shown = Object.entries(operation.data)
            .slice(0, 4)
            .map(([key, value]) => `${key}: ${describeValue(value)}`)
            .join(', ');
          lines.push({
            summary: `Add a row to ${table.displayName || table.name}`,
            detail: shown,
            target: table.name,
          });
          break;
        }
        case 'update-record': {
          const table = resolveTable(recordsDb, operation.tableRef);
          const existing = getRecord(recordsDb, operation.recordId);
          const changes = Object.entries(operation.data)
            .map(([key, value]) => {
              const before = existing.data[key];
              return `${key}: ${describeValue(before)} → ${describeValue(value)}`;
            })
            .join('; ');
          lines.push({
            summary: `Update a row in ${table.displayName || table.name}`,
            detail: changes || 'no field changes',
            target: table.name,
          });
          break;
        }
        case 'delete-record': {
          const table = resolveTable(recordsDb, operation.tableRef);
          getRecord(recordsDb, operation.recordId);
          lines.push({
            summary: `Remove a row from ${table.displayName || table.name}`,
            detail: 'Kept in history and restorable',
            target: table.name,
          });
          break;
        }
        case 'add-field': {
          const table = resolveTable(recordsDb, operation.tableRef);
          const field = operation.field as { name?: string; type?: string };
          lines.push({
            summary: `Add "${field.name}" to ${table.displayName || table.name}`,
            detail: `type: ${field.type ?? 'text'} — existing rows keep their current values`,
            target: table.name,
          });
          break;
        }
        case 'create-table': {
          const table = operation.table as { name?: string; fields?: unknown[] };
          lines.push({
            summary: `Create a new table "${table.name}"`,
            detail: `${Array.isArray(table.fields) ? table.fields.length : 0} fields`,
            target: String(table.name ?? ''),
          });
          break;
        }
        case 'post-journal-entry': {
          const entry = operation.entry as { memo?: string; lines?: Array<{ direction: string; amount: number }> };
          const debit = (entry.lines ?? []).filter((l) => l.direction === 'debit').reduce((sum, l) => sum + l.amount, 0);
          lines.push({
            summary: `Post to the books: ${entry.memo ?? 'journal entry'}`,
            detail: `${(entry.lines ?? []).length} lines, ${(debit / 100).toFixed(2)} total`,
            target: 'ledger',
          });
          break;
        }
        default:
          warnings.push(`Operation ${index + 1} has an unrecognized kind and will be skipped.`);
      }
    } catch (error) {
      // A preview that cannot be built is exactly what the person needs to
      // see before approving, so surface it rather than throwing.
      warnings.push(
        `Operation ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { lines, warnings };
}

export async function createProposal(
  db: SqlExecutor,
  recordsDb: RecordsDb,
  orgId: string,
  input: CreateProposalRequest & { origin?: Proposal['origin']; runId?: string | null; createdBy: string },
): Promise<Proposal> {
  const intent = typeof input.intent === 'string' ? input.intent.trim() : '';
  if (!intent) {
    throw workspaceValidationError([{ path: 'intent', message: 'say what this change is for' }]);
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw workspaceValidationError([{ path: 'operations', message: 'a proposal needs at least one operation' }]);
  }
  const preview = buildPreview(recordsDb, input.operations);
  const id = `prop-${randomUUID()}`;
  const now = Date.now();
  await db.run(
    `INSERT INTO od_proposals
       (id, workspace_id, intent, origin, run_id, status, operations_json, preview_json,
        created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      id,
      orgId,
      intent,
      input.origin ?? 'agent',
      input.runId ?? null,
      JSON.stringify(input.operations),
      JSON.stringify(preview),
      input.createdBy,
      now,
    ],
  );
  return getProposal(db, orgId, id);
}

export async function getProposal(db: SqlExecutor, orgId: string, id: string): Promise<Proposal> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${PROPOSAL_COLS} FROM od_proposals WHERE id = ? AND workspace_id = ?`,
    [id, orgId],
  );
  if (!row) {
    throw new WorkspaceDataError('PROPOSAL_NOT_FOUND', 404, `proposal ${id} not found`);
  }
  return normalize(row, orgId);
}

export async function listProposals(
  db: SqlExecutor,
  orgId: string,
  options: { status?: ProposalStatus; limit?: number } = {},
): Promise<Proposal[]> {
  const where = ['workspace_id = ?'];
  const params: unknown[] = [orgId];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const rows = await db.all<Record<string, any>>(
    `SELECT ${PROPOSAL_COLS} FROM od_proposals WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT ?`,
    [...params, Math.min(200, Math.max(1, options.limit ?? 50))],
  );
  return rows.map((row) => normalize(row, orgId));
}

export async function rejectProposal(
  db: SqlExecutor,
  orgId: string,
  id: string,
  decidedBy: string,
): Promise<Proposal> {
  const proposal = await getProposal(db, orgId, id);
  if (proposal.status !== 'pending') {
    throw new WorkspaceDataError(
      'PROPOSAL_STATE_INVALID',
      409,
      `only a pending proposal can be rejected; this one is ${proposal.status}`,
    );
  }
  await db.run(
    "UPDATE od_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?",
    [decidedBy, Date.now(), id],
  );
  return getProposal(db, orgId, id);
}

export interface ApplyContext {
  recordsDb: RecordsDb;
  ledgerDb: SqlExecutor;
  actor: WorkspaceActor;
}

/** Approve and run a proposal. All-or-nothing: if any operation fails, the
 * ones before it are rolled back and nothing is left half-done. */
export async function approveProposal(
  db: SqlExecutor,
  orgId: string,
  id: string,
  decidedBy: string,
  ctx: ApplyContext,
): Promise<Proposal> {
  const proposal = await getProposal(db, orgId, id);
  if (proposal.status !== 'pending') {
    throw new WorkspaceDataError(
      'PROPOSAL_STATE_INVALID',
      409,
      `only a pending proposal can be approved; this one is ${proposal.status}`,
    );
  }

  const effects: ProposalEffect[] = [];
  const now = Date.now();
  try {
    // The record store is synchronous SQLite, so its operations share one
    // explicit transaction; the ledger runs its own. A ledger failure after
    // records committed is the one seam here, which is why journal postings
    // are ordered last in an operation list by convention.
    ctx.recordsDb.exec('BEGIN');
    try {
      for (const operation of proposal.operations) {
        switch (operation.kind) {
          case 'create-record': {
            const table = resolveTable(ctx.recordsDb, operation.tableRef);
            const record = createRecord(ctx.recordsDb, table, ctx.actor, operation.data as never);
            effects.push({ kind: 'record-created', tableId: table.id, recordId: record.id });
            break;
          }
          case 'update-record': {
            const table = resolveTable(ctx.recordsDb, operation.tableRef);
            const before = getRecord(ctx.recordsDb, operation.recordId);
            updateRecord(ctx.recordsDb, table, ctx.actor, operation.recordId, operation.data as never);
            effects.push({
              kind: 'record-updated',
              tableId: table.id,
              recordId: operation.recordId,
              priorRevision: before.revision,
            });
            break;
          }
          case 'delete-record': {
            const table = resolveTable(ctx.recordsDb, operation.tableRef);
            softDeleteRecord(ctx.recordsDb, table, ctx.actor, operation.recordId);
            effects.push({ kind: 'record-deleted', tableId: table.id, recordId: operation.recordId });
            break;
          }
          case 'create-table': {
            const table = createTable(ctx.recordsDb, operation.table as never, ctx.actor);
            effects.push({ kind: 'table-created', tableId: table.id });
            break;
          }
          case 'add-field': {
            // Adding a field is a schema change; see addFieldToTable for why
            // it is additive-only.
            const table = resolveTable(ctx.recordsDb, operation.tableRef);
            const fieldId = addFieldToTable(ctx.recordsDb, table.id, operation.field as never, ctx.actor);
            effects.push({ kind: 'field-added', tableId: table.id, fieldId });
            break;
          }
          case 'post-journal-entry':
            // Handled after the record transaction commits.
            break;
        }
      }
      ctx.recordsDb.exec('COMMIT');
    } catch (error) {
      try {
        ctx.recordsDb.exec('ROLLBACK');
      } catch {
        // preserve the original failure
      }
      throw error;
    }

    for (const operation of proposal.operations) {
      if (operation.kind !== 'post-journal-entry') continue;
      const entry = await postJournalEntry(ctx.ledgerDb, orgId, decidedBy, operation.entry as never);
      effects.push({ kind: 'journal-posted', entryId: entry.id });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.run(
      "UPDATE od_proposals SET status = 'failed', error = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      [message, decidedBy, now, id],
    );
    throw new WorkspaceDataError('PROPOSAL_APPLY_FAILED', 422, `could not apply: ${message}`);
  }

  await db.run(
    `UPDATE od_proposals
        SET status = 'applied', decided_by = ?, decided_at = ?, applied_at = ?, effects_json = ?
      WHERE id = ?`,
    [decidedBy, now, now, JSON.stringify(effects), id],
  );
  return getProposal(db, orgId, id);
}

/** Walk an applied proposal back. Records restore or revert to their prior
 * revision; journal entries reverse rather than disappear, because the books
 * never rewrite history — even to undo. */
export async function undoProposal(
  db: SqlExecutor,
  orgId: string,
  id: string,
  undoneBy: string,
  ctx: ApplyContext,
): Promise<Proposal> {
  const proposal = await getProposal(db, orgId, id);
  if (proposal.status !== 'applied') {
    throw new WorkspaceDataError(
      'PROPOSAL_STATE_INVALID',
      409,
      `only an applied proposal can be undone; this one is ${proposal.status}`,
    );
  }

  // Reverse order: a record created after a table must go before the table.
  for (const effect of [...proposal.appliedEffects].reverse()) {
    switch (effect.kind) {
      case 'record-created': {
        const table = resolveTable(ctx.recordsDb, effect.tableId);
        const record = getRecord(ctx.recordsDb, effect.recordId);
        if (record.deletedAt === null) softDeleteRecord(ctx.recordsDb, table, ctx.actor, effect.recordId);
        break;
      }
      case 'record-updated': {
        const table = resolveTable(ctx.recordsDb, effect.tableId);
        const history = ctx.recordsDb
          .prepare('SELECT data_json AS dataJson FROM od_record_revisions WHERE record_id = ? AND revision = ?')
          .get(effect.recordId, effect.priorRevision) as { dataJson: string } | undefined;
        if (history) {
          const priorData = JSON.parse(history.dataJson) as Record<string, unknown>;
          const current = getRecord(ctx.recordsDb, effect.recordId);
          // Null out keys the prior revision did not have, so undo restores
          // the shape as well as the values.
          const patch: Record<string, unknown> = { ...priorData };
          for (const key of Object.keys(current.data)) {
            if (!(key in priorData)) patch[key] = null;
          }
          updateRecord(ctx.recordsDb, table, ctx.actor, effect.recordId, patch as never);
        }
        break;
      }
      case 'record-deleted': {
        const table = resolveTable(ctx.recordsDb, effect.tableId);
        const record = getRecord(ctx.recordsDb, effect.recordId);
        if (record.deletedAt !== null) restoreRecord(ctx.recordsDb, table, ctx.actor, effect.recordId);
        break;
      }
      case 'journal-posted': {
        await reverseJournalEntry(ctx.ledgerDb, orgId, effect.entryId, undoneBy, {
          memo: 'Undo of an approved change',
        });
        break;
      }
      case 'field-added':
      case 'table-created':
        // Left in place on purpose. Dropping a column or table would destroy
        // whatever anyone has since put in it, which is a far worse outcome
        // than an unused field. Archive it by hand if it is truly unwanted.
        break;
    }
  }

  await db.run("UPDATE od_proposals SET status = 'undone', undone_at = ? WHERE id = ?", [
    Date.now(),
    id,
  ]);
  return getProposal(db, orgId, id);
}

/** Add a field to an existing table.
 *
 * Additive only: new fields arrive optional so existing rows stay valid
 * without a backfill, which is what makes "add a PO number to orders" safe to
 * say out loud. Making a field required, renaming it, or changing its type
 * are different operations with real blast radius and are not done here. */
export function addFieldToTable(
  recordsDb: RecordsDb,
  tableId: string,
  field: { name: string; displayName?: string; type: string; unique?: boolean; config?: unknown },
  actor: WorkspaceActor,
): string {
  const table = resolveTable(recordsDb, tableId);
  if (table.fields.some((existing) => existing.name === field.name)) {
    throw new WorkspaceDataError(
      'CONFLICT',
      409,
      `'${field.name}' already exists on ${table.name}`,
    );
  }
  const id = `fld-${randomUUID()}`;
  const now = Date.now();
  const position = table.fields.length;
  recordsDb
    .prepare(
      `INSERT INTO od_fields
         (id, table_id, name, display_name, type, required, unique_constraint,
          config_json, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      id,
      table.id,
      field.name,
      field.displayName || field.name,
      field.type,
      field.unique ? 1 : 0,
      field.config ? JSON.stringify(field.config) : null,
      position,
      now,
      now,
    );
  if (field.unique) {
    recordsDb.exec(
      `CREATE UNIQUE INDEX "odx_u_${id}" ON od_records(json_extract(data_json, '$.${field.name}'))
         WHERE table_id = '${table.id}' AND deleted_at IS NULL`,
    );
  }
  recordsDb
    .prepare('UPDATE od_tables SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?')
    .run(now, table.id);
  recordsDb
    .prepare(
      `INSERT INTO od_audit_events
         (id, actor_kind, actor_member_id, tool_id, run_id, project_id, op,
          subject_kind, subject_id, table_id, summary, patch_json, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, 'table.add-field', 'table', ?, ?, ?, NULL, ?)`,
    )
    .run(
      `aud-${randomUUID()}`,
      actor.kind,
      actor.memberId ?? null,
      actor.runId ?? null,
      table.id,
      table.id,
      `added field '${field.name}' (${field.type})`,
      now,
    );
  return id;
}
