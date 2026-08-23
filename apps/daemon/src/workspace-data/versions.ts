// Going back.
//
// Every write already stores a full snapshot of the record's data in
// `od_record_revisions`, and SQLite triggers make that table append-only below
// the application layer. So the history is already complete and already
// trustworthy — what was missing was a way to read it and a way to return to a
// point in it.
//
// Restoring writes a NEW revision holding the old values. It never rewinds the
// log, never deletes a revision, and never edits one. That matters more than
// it sounds: an undo that erases the fact it happened is how people lose the
// thing they were trying to recover, and an auditor cannot accept a history
// that can be rewritten by anyone with the restore button.
//
// So the timeline only ever grows. Restoring to revision 3 gives you revision
// 7 whose contents equal revision 3's, and both are still there afterwards.

import type {
  JsonValue,
  RecordVersionDiff,
  RecordVersionEntry,
  WorkspaceField,
  WorkspaceRecord,
  WorkspaceRecordRevision,
  WorkspaceTable,
} from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import { getRecord, listRecordRevisions, updateRecord } from './records.js';
import type { WorkspaceActor } from './types.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Both blank in any of its spellings is not a change worth showing.
  const blank = (value: unknown) => value === null || value === undefined || value === '';
  if (blank(a) && blank(b)) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return false;
}

/** What changed between two snapshots, in field order, ignoring fields that
 * did not move. Comparing whole snapshots rather than storing deltas means the
 * diff is always derivable — even for a revision written before a field
 * existed. */
export function diffSnapshots(
  table: WorkspaceTable,
  before: Record<string, JsonValue> | null,
  after: Record<string, JsonValue>,
): RecordVersionDiff[] {
  const diffs: RecordVersionDiff[] = [];
  const seen = new Set<string>();

  const push = (field: WorkspaceField | null, name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const from = before ? (before[name] ?? null) : null;
    const to = after[name] ?? null;
    if (sameValue(from, to)) return;
    diffs.push({
      field: name,
      label: field?.displayName ?? name,
      type: field?.type ?? 'text',
      from: from as JsonValue,
      to: to as JsonValue,
    });
  };

  for (const field of table.fields) push(field, field.name);
  // Values from a field that has since been removed still show, under their
  // machine name. Hiding them would make a diff of an old revision lie.
  for (const name of Object.keys(after)) push(null, name);
  if (before) for (const name of Object.keys(before)) push(null, name);

  return diffs;
}

/** The record's history, newest first, each entry carrying what changed at
 * that point. */
export function recordHistory(
  recordsDb: RecordsDb,
  table: WorkspaceTable,
  recordId: string,
): RecordVersionEntry[] {
  const revisions = listRecordRevisions(recordsDb, recordId);
  const entries: RecordVersionEntry[] = [];

  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index]!;
    const previous = index > 0 ? revisions[index - 1]! : null;
    entries.push({
      revision: revision.revision,
      op: revision.op,
      createdAt: revision.createdAt,
      auditEventId: revision.auditEventId,
      changes: diffSnapshots(table, previous?.data ?? null, revision.data),
      isCurrent: index === revisions.length - 1,
    });
  }

  // Newest first: a history is read from the top.
  return entries.reverse();
}

export function getRevisionSnapshot(
  recordsDb: RecordsDb,
  recordId: string,
  revision: number,
): WorkspaceRecordRevision {
  const found = listRecordRevisions(recordsDb, recordId).find(
    (candidate) => candidate.revision === revision,
  );
  if (!found) {
    throw new WorkspaceDataError(
      'WORKSPACE_RECORD_NOT_FOUND',
      404,
      `record ${recordId} has no revision ${revision}`,
    );
  }
  return found;
}

/** Return a record to how it looked at a revision.
 *
 * Applied as an ordinary update, which is what keeps every guarantee intact:
 * the values are validated again (a restore cannot reintroduce something the
 * schema now forbids), a new revision is written, and the audit trail records
 * who did it and when. The old revisions stay exactly where they were. */
export function restoreRecordVersion(
  recordsDb: RecordsDb,
  table: WorkspaceTable,
  actor: WorkspaceActor,
  recordId: string,
  revision: number,
): WorkspaceRecord {
  const current = getRecord(recordsDb, recordId);
  if (current.deletedAt !== null) {
    throw new WorkspaceDataError(
      'WORKSPACE_RECORD_DELETED',
      409,
      'restore the record itself before restoring one of its versions',
    );
  }
  const snapshot = getRevisionSnapshot(recordsDb, recordId, revision);
  if (snapshot.revision === current.revision) {
    // Already there. Writing a no-op revision would add noise to the history
    // for no gain.
    return current;
  }

  // Every field the record currently has is included, so a field that was set
  // after the target revision is cleared rather than left behind — "back to
  // how it was" has to mean all of it.
  const patch: Record<string, JsonValue> = {};
  for (const key of Object.keys(current.data)) patch[key] = null;
  for (const [key, value] of Object.entries(snapshot.data)) patch[key] = value;

  return updateRecord(recordsDb, table, actor, recordId, patch, current.revision);
}
