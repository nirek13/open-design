// Workspace Database data plane: typed tables, validated records, soft
// deletes, full row history, and an append-only audit trail. This is the
// permanent core that disposable generated tools are views over.
//
// Records are bounded JSON documents validated against the table's field
// schema at a single daemon service chokepoint — the schema is real database
// discipline (required fields, types, uniqueness, link integrity) but is
// never exposed as SQL. Nothing truly deletes: records soft-delete, tables
// archive, and every write appends a revision plus an audit event.

import type { BoundedJsonConstraints, JsonValue } from '../common.js';
import type { OrgActorKind } from './organizations.js';

export const WORKSPACE_FIELD_TYPES = [
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'select',
  'money',
  'link',
  'json',
] as const;

export type WorkspaceFieldType = (typeof WORKSPACE_FIELD_TYPES)[number];

/** Machine names for tables and fields: snake_case identifiers, so generated
 * tools and calculation rules can reference them without quoting concerns. */
export const WORKSPACE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Bounds applied to every record payload at the write chokepoint. */
export const WORKSPACE_RECORD_BOUNDED_JSON_CONSTRAINTS = {
  maxDepth: 6,
  maxObjectKeys: 100,
  maxArrayLength: 200,
  maxStringLength: 16 * 1024,
  maxSerializedBytes: 128 * 1024,
} as const satisfies BoundedJsonConstraints;

/** Per-type field configuration. Only the keys relevant to the field's type
 * are honored; the schema validator rejects mismatched configs. */
export interface WorkspaceFieldConfig {
  /** select: the closed set of allowed values. */
  options?: string[];
  /** link: the table this field references. */
  targetTableId?: string;
  /** link: what soft-deleting a referenced record does to referrers.
   * `restrict` (default) blocks the delete while active references exist;
   * `clear` nulls the referring field. */
  onDelete?: 'restrict' | 'clear';
  /** money: ISO 4217 currency code. Money values are always INTEGER minor
   * units (cents); floats are rejected at the chokepoint. */
  currency?: string;
  /** number/integer: inclusive bounds. */
  min?: number;
  max?: number;
  /** The part this field plays in automatic accounting and cross-document
   * links (see api/business-hub.ts `HubFieldRole`). Preserved across schema
   * edits so posting keeps working after someone adds their own columns; a
   * field with no role is free-form. */
  role?: string;
  /** A computed field's expression, e.g. `{total} - {tax}`. Evaluated at read
   * time and never stored, so it cannot go stale against the values it derives
   * from. Parsed when the field is created, so a formula that cannot be read
   * is refused rather than silently blanking a column on every read. See
   * `workspace-data/formula.ts` for the grammar. */
  formula?: string;
}

/** `removed` is a field taken off a table by a schema edit. Its values stay in
 * the record documents, which is what makes restoring it bring the data back. */
export type WorkspaceFieldStatus = 'active' | 'archived' | 'removed';

export interface WorkspaceField {
  id: string;
  tableId: string;
  name: string;
  displayName: string;
  type: WorkspaceFieldType;
  required: boolean;
  unique: boolean;
  config: WorkspaceFieldConfig | null;
  position: number;
  status: WorkspaceFieldStatus;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceTableStatus = 'active' | 'archived';

/** `open` tables accept applied schema changes normally; `system` tables are
 * bound by a promoted system tool and require approval for schema changes
 * (hardening-ladder phase). */
export type WorkspaceTableProtection = 'open' | 'system';

export interface WorkspaceTable {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  status: WorkspaceTableStatus;
  schemaVersion: number;
  protection: WorkspaceTableProtection;
  /** Member id of the creator. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  fields: WorkspaceField[];
}

export interface WorkspaceFieldInput {
  name: string;
  displayName?: string;
  type: WorkspaceFieldType;
  required?: boolean;
  unique?: boolean;
  config?: WorkspaceFieldConfig;
}

export interface CreateWorkspaceTableRequest {
  name: string;
  displayName?: string;
  description?: string;
  fields: WorkspaceFieldInput[];
}

export interface WorkspaceRecord {
  id: string;
  tableId: string;
  data: Record<string, JsonValue>;
  revision: number;
  createdByKind: OrgActorKind;
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type WorkspaceRecordOp = 'create' | 'update' | 'soft-delete' | 'restore';

export interface WorkspaceRecordRevision {
  id: string;
  recordId: string;
  tableId: string;
  revision: number;
  op: WorkspaceRecordOp;
  /** Full post-write snapshot of the record's data at this revision. */
  data: Record<string, JsonValue>;
  auditEventId: string;
  createdAt: number;
}

export type WorkspaceAuditSubjectKind = 'record' | 'table' | 'workspace';

export interface WorkspaceAuditEvent {
  id: string;
  actorKind: OrgActorKind;
  /** Member id when actorKind is `user`; null for agent/public-form/system. */
  actorMemberId: string | null;
  /** Registered tool id when the write came through a generated tool. */
  toolId: string | null;
  /** Agent run id when actorKind is `agent`. */
  runId: string | null;
  projectId: string | null;
  op: string;
  subjectKind: WorkspaceAuditSubjectKind;
  subjectId: string;
  tableId: string | null;
  summary: string | null;
  /** Bounded before/after patch for record ops: `{ before, after }`. */
  patch: JsonValue | null;
  createdAt: number;
}

export type WorkspaceFilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'in'
  | 'is-null'
  | 'not-null';

export interface WorkspaceRecordFilter {
  field: string;
  op: WorkspaceFilterOp;
  value?: JsonValue;
}

export interface WorkspaceRecordSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface QueryWorkspaceRecordsRequest {
  filters?: WorkspaceRecordFilter[];
  sort?: WorkspaceRecordSort;
  limit?: number;
  /** Opaque cursor from a previous response's nextCursor. */
  cursor?: string;
  includeDeleted?: boolean;
}

export interface CreateWorkspaceRecordRequest {
  data: Record<string, JsonValue>;
}

export interface UpdateWorkspaceRecordRequest {
  /** Partial data patch; only the provided keys change. */
  data: Record<string, JsonValue>;
  /** Optimistic concurrency: reject with WORKSPACE_REVISION_CONFLICT when the
   * stored revision no longer matches. */
  expectedRevision?: number;
}

export interface WorkspaceTableResponse {
  table: WorkspaceTable;
}

export interface WorkspaceTablesResponse {
  tables: WorkspaceTable[];
}

export interface WorkspaceRecordResponse {
  record: WorkspaceRecord;
}

export interface WorkspaceRecordsPageResponse {
  records: WorkspaceRecord[];
  nextCursor: string | null;
}

export interface WorkspaceRecordRevisionsResponse {
  revisions: WorkspaceRecordRevision[];
}

export interface WorkspaceAuditEventsResponse {
  events: WorkspaceAuditEvent[];
  nextCursor: string | null;
}

/** SSE payload on GET /api/data/events whenever records in a table change. */
export interface WorkspaceDataChangedSsePayload {
  workspaceId: string;
  tableId: string;
  recordId: string;
  op: WorkspaceRecordOp;
}
