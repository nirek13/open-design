// Human-in-the-loop: nothing the assistant decides to do happens until a
// person says yes, and anything that did happen can be taken back.
//
// A proposal is a change that has been fully worked out but not applied. It
// carries the exact operations to run and a preview of what they would do, so
// approving is a decision about a described outcome rather than a leap of
// faith. Rejecting costs nothing; the proposal is simply never executed.
//
// Undo is the other half. Because every record write keeps its prior revision
// and every ledger posting can be reversed, "apply" is not a one-way door —
// an applied proposal records enough to walk itself back.

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'undone';

/** What a proposal wants to do. Each operation names its own inverse, which
 * is what makes undo mechanical rather than best-effort. */
export type ProposalOperation =
  | {
      kind: 'create-record';
      tableRef: string;
      data: Record<string, unknown>;
    }
  | {
      kind: 'update-record';
      tableRef: string;
      recordId: string;
      data: Record<string, unknown>;
    }
  | {
      kind: 'delete-record';
      tableRef: string;
      recordId: string;
    }
  | {
      kind: 'add-field';
      tableRef: string;
      field: Record<string, unknown>;
    }
  | {
      kind: 'create-table';
      table: Record<string, unknown>;
    }
  | {
      kind: 'post-journal-entry';
      entry: Record<string, unknown>;
    };

/** One human-readable line of "here is what will change". The UI renders
 * these; it never has to understand the operations themselves. */
export interface ProposalPreviewLine {
  /** Short label, e.g. "Create invoice INV-1042". */
  summary: string;
  /** Optional before/after for a field-level diff. */
  detail?: string;
  /** Which table or ledger this touches, for grouping. */
  target?: string;
}

export interface ProposalPreview {
  lines: ProposalPreviewLine[];
  /** Set when building the preview found a problem — the proposal can still
   * be shown, but approving it will fail. Better to say so before asking. */
  warnings: string[];
}

export interface Proposal {
  id: string;
  orgId: string;
  /** What the person asked for, in their words. */
  intent: string;
  /** Who or what proposed this. */
  origin: 'agent' | 'user' | 'import' | 'system';
  runId: string | null;
  status: ProposalStatus;
  operations: ProposalOperation[];
  preview: ProposalPreview;
  /** Records/entries created by applying, so undo knows what to walk back. */
  appliedEffects: ProposalEffect[];
  error: string | null;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: number | null;
  appliedAt: number | null;
  undoneAt: number | null;
  createdAt: number;
}

/** What actually happened when a proposal was applied — the receipt undo
 * reads from. */
export type ProposalEffect =
  | { kind: 'record-created'; tableId: string; recordId: string }
  | { kind: 'record-updated'; tableId: string; recordId: string; priorRevision: number }
  | { kind: 'record-deleted'; tableId: string; recordId: string }
  | { kind: 'field-added'; tableId: string; fieldId: string }
  | { kind: 'table-created'; tableId: string }
  | { kind: 'journal-posted'; entryId: string };

export interface CreateProposalRequest {
  intent: string;
  operations: ProposalOperation[];
}

export interface ProposalResponse {
  proposal: Proposal;
}

export interface ProposalsResponse {
  proposals: Proposal[];
}

// --- Saved questions and home-screen widgets -------------------------------

/** A question someone asked about their data, saved so the answer stays
 * current. Pinning one puts the live answer on the home screen. */
export type WidgetKind = 'metric' | 'table' | 'list';

export interface SavedQuestion {
  id: string;
  orgId: string;
  /** The question as asked, e.g. "how much is overdue?" */
  question: string;
  /** The query it resolved to. Stored structurally so it re-runs exactly. */
  tableRef: string;
  filters: unknown[];
  /** For a metric: which field to aggregate and how. */
  aggregate: { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string } | null;
  kind: WidgetKind;
  /** Null until pinned; lower numbers sort first on the home screen. */
  pinnedPosition: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface SavedQuestionAnswer {
  question: SavedQuestion;
  /** Metric value, or null when the widget is a list/table. */
  value: number | null;
  /** Rows for list/table widgets. */
  rows: Array<Record<string, unknown>>;
  /** Total matching rows, before any display limit. */
  count: number;
  answeredAt: number;
}

export interface CreateSavedQuestionRequest {
  question: string;
  tableRef: string;
  filters?: unknown[];
  aggregate?: { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string } | null;
  kind?: WidgetKind;
  pin?: boolean;
}

export interface SavedQuestionsResponse {
  questions: SavedQuestion[];
}

export interface SavedQuestionAnswerResponse {
  answer: SavedQuestionAnswer;
}

export interface HomeWidgetsResponse {
  widgets: SavedQuestionAnswer[];
}

// --- Spreadsheet import ---------------------------------------------------

/** What the importer inferred from a spreadsheet, shown for confirmation
 * before anything is written. Import is a proposal like any other change. */
export interface ImportPlanColumn {
  header: string;
  fieldName: string;
  type: 'text' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'money' | 'json';
  /** Why this type was chosen, so a wrong guess is easy to spot. */
  reason: string;
  sample: string[];
  /** True when this column uniquely identifies a row (used to refresh without duplicates). */
  unique?: boolean;
}

export interface ImportPlan {
  tableName: string;
  displayName: string;
  /** True when a table of this name already exists and rows will be appended. */
  appendingToExisting: boolean;
  columns: ImportPlanColumn[];
  rowCount: number;
  /** Rows that could not be parsed, with the reason. Import proceeds without
   * them rather than failing wholesale on one bad line. */
  skipped: Array<{ row: number; reason: string }>;
  /** Public URL this table was read from, when the import came from a link. */
  sourceUrl?: string;
}

export interface ImportPlanResponse {
  plan: ImportPlan;
}

export interface ImportCommitResponse {
  tableId: string;
  imported: number;
  /** Rows matched by unique key and rewritten on a refresh. */
  updated?: number;
  /** Live rows removed because they disappeared from a snapshot feed. */
  removed?: number;
  skipped: number;
}

export type ImportSourceKind = 'csv' | 'json' | 'html-table' | 'google-sheets' | 'ai';

export interface ImportFromUrlRequest {
  url: string;
  tableName?: string;
  /** When true, plan and write in one call. UI always plans first. */
  commit?: boolean;
}

export interface ImportFromUrlResponse {
  source: {
    url: string;
    finalUrl: string;
    kind: ImportSourceKind;
    fileName: string;
  };
  plan: ImportPlan;
  /** Normalized CSV so the caller can commit without re-fetching. Omitted after commit. */
  content?: string;
  tableId?: string;
  imported?: number;
  skipped?: number;
}
