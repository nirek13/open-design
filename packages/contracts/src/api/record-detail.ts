// One record, fully assembled.
//
// The ERP record page — what NetSuite calls a record with subtabs. A row on
// its own is rarely what someone opened; they came for the row *and* what
// hangs off it: this customer's invoices, what they owe, what has changed.
//
// Assembled in one response on purpose. A client stitching this together from
// four endpoints renders four loading states, and still has to re-implement
// "which invoices belong to this customer" — which is a schema walk, not a
// query, because links are only stored on the pointing side.

import type { JsonValue } from '../common.js';
import type { WorkspaceRecord, WorkspaceTable } from './workspace-data.js';

/** A link this record carries, resolved to something readable. */
export interface RecordLink {
  field: string;
  fieldLabel: string;
  tableName: string;
  recordId: string;
  /** Document number, name, or first text value — how a person reads the row. */
  label: string;
  /** The target is soft-deleted or missing. Shown marked rather than hidden:
   * a dangling reference is information, not noise. */
  deleted: boolean;
}

/** A number summarising a related list — "invoiced: 42,500.00". */
export interface RecordRollup {
  field: string;
  label: string;
  fn: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Money stays in integer minor units, like everywhere else. */
  value: number;
}

/** Rows on another table that point at this record. */
export interface RecordRelatedList {
  tableId: string;
  tableName: string;
  tableDisplayName: string;
  /** The link field on the other table pointing back here. The UI prefills it
   * when creating a related row, so "New invoice" from a customer arrives with
   * the customer already filled in. */
  viaField: string;
  viaFieldLabel: string;
  total: number;
  /** More rows exist than are carried here. */
  truncated: boolean;
  rollups: RecordRollup[];
  records: Array<{
    recordId: string;
    label: string;
    data: Record<string, JsonValue>;
    updatedAt: number;
  }>;
}

export interface RecordDetail {
  record: WorkspaceRecord;
  table: WorkspaceTable;
  /** What to put in the header. */
  title: string;
  links: RecordLink[];
  related: RecordRelatedList[];
  /** Document actions valid on this record right now — `post`,
   * `convert:<table>`, `status`. Computed server-side so the UI does not
   * re-derive the hub's rules and drift from them. */
  actions: string[];
}

export interface RecordDetailResponse {
  detail: RecordDetail;
}
