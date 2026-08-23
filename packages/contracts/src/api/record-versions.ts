// Record history.
//
// Every write already stores a full snapshot, and the revisions table is
// append-only below the application layer. These types expose that history and
// the one operation missing from it: going back.
//
// Restoring writes a *new* revision containing the old values. It never
// rewinds, deletes, or edits the log. An undo that erases the fact it happened
// is how people lose the thing they were trying to recover, and a history that
// can be rewritten by whoever holds the restore button is not an audit trail.

import type { JsonValue } from '../common.js';
import type { WorkspaceFieldType, WorkspaceRecordOp } from './workspace-data.js';

/** One field that moved between two revisions. */
export interface RecordVersionDiff {
  field: string;
  label: string;
  type: WorkspaceFieldType;
  from: JsonValue;
  to: JsonValue;
}

export interface RecordVersionEntry {
  revision: number;
  op: WorkspaceRecordOp;
  createdAt: number;
  /** Links this change to the audit event naming who made it. */
  auditEventId: string;
  /** What moved at this point. Empty for the creating revision, where
   * everything is new rather than changed. */
  changes: RecordVersionDiff[];
  isCurrent: boolean;
}

export interface RecordHistoryResponse {
  history: RecordVersionEntry[];
}

export interface RestoreRecordVersionRequest {
  revision: number;
}
