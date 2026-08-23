// Saved views: the same table, looked at differently.
//
// A view is a stored lens over one table — which rows (filters), in what order
// (sorts), grouped how, showing which fields, drawn as what. It owns no data.
// Delete every view and the records are untouched; that is the property that
// makes views safe to create freely, which is the whole point of them.
//
// This is deliberately the Notion model rather than the spreadsheet model. A
// spreadsheet's arrangement *is* its data, so rearranging is destructive and
// two people cannot disagree. Here, "my overdue invoices, by customer" and
// "everything this quarter, on a calendar" are two saved lenses over one set
// of rows, and neither can damage the other.

import type { JsonValue } from '../common.js';
import type { WorkspaceRecordFilter, WorkspaceRecordSort } from './workspace-data.js';

/** How a view draws its rows.
 *
 * `board` and `calendar` are not decorations — each needs a specific field to
 * exist (something to group columns by; something with a date), and the view
 * says which. A board with no `groupBy` is meaningless, so the API refuses it
 * rather than silently rendering one column called "everything". */
export const VIEW_KINDS = ['table', 'board', 'gallery', 'calendar', 'list'] as const;

export type ViewKind = (typeof VIEW_KINDS)[number];

export interface WorkspaceView {
  id: string;
  orgId: string;
  tableId: string;
  name: string;
  kind: ViewKind;
  filters: WorkspaceRecordFilter[];
  sorts: WorkspaceRecordSort[];
  /** Field name to group by. Required for `board`, optional elsewhere. */
  groupBy: string | null;
  /** Field name carrying the date a `calendar` view lays out. */
  dateField: string | null;
  /** Field names to show, in order. Null means "every field", which is what a
   * new view starts as — an explicit list would go stale the moment someone
   * adds a column. */
  visibleFields: string[] | null;
  /** Ordering in the view switcher. */
  position: number;
  /** The view a table opens with. Exactly one per table, enforced on write. */
  isDefault: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkspaceViewRequest {
  name: string;
  kind?: ViewKind;
  filters?: WorkspaceRecordFilter[];
  sorts?: WorkspaceRecordSort[];
  groupBy?: string | null;
  dateField?: string | null;
  visibleFields?: string[] | null;
  isDefault?: boolean;
}

export interface UpdateWorkspaceViewRequest {
  name?: string;
  kind?: ViewKind;
  filters?: WorkspaceRecordFilter[];
  sorts?: WorkspaceRecordSort[];
  groupBy?: string | null;
  dateField?: string | null;
  visibleFields?: string[] | null;
  position?: number;
  isDefault?: boolean;
}

/** One group of rows in a grouped view — a board column, or a section header
 * in a grouped table. */
export interface ViewGroup {
  /** The shared value, as a string for display. Null is its own group: "no
   * status" is a real answer people need to see, not rows to hide. */
  key: string | null;
  label: string;
  recordIds: string[];
  count: number;
}

export interface ViewResultResponse {
  view: WorkspaceView;
  /** Rows after the view's filters and sorts, already paged. */
  records: Array<{ id: string; data: Record<string, JsonValue>; revision: number; updatedAt: number }>;
  /** Present only when the view groups. */
  groups: ViewGroup[] | null;
  nextCursor: string | null;
}

export interface ViewListResponse {
  views: WorkspaceView[];
}

export interface ViewResponse {
  view: WorkspaceView;
}
