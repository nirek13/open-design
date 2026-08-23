// Changing the workspace by saying what you want.
//
// "add a phone column to customers", "new customer called Northwind",
// "show me overdue invoices" — typed into one box, turned into the same
// `ProposalOperation[]` the assistant already emits, previewed, and applied
// only when a person says yes.
//
// Two decisions worth stating plainly, because they are what makes this
// trustworthy rather than a magic box:
//
//   1. **Interpreting never writes.** `interpret` is pure: text in, a plan and
//      a confidence out. Nothing reaches the database until a separate call
//      applies it. So a misread sentence costs a glance, not a recovery.
//
//   2. **It admits when it does not know.** A parser that guesses is worse
//      than one that declines, because a confident wrong answer gets approved.
//      Every result carries `confidence` and the `unmatched` remainder of the
//      sentence, and the UI is expected to show both. Below `MIN_APPLY_CONFIDENCE`
//      the daemon refuses to apply at all and offers the assistant instead.
//
// The deterministic parser handles the phrasings people actually repeat —
// adding fields, adding rows, filtering, creating tables. Anything outside its
// grammar returns `kind: 'unsupported'` with a suggestion to ask the
// assistant, which routes through the same proposal flow with a real model
// behind it. Local first because it is instant, free, offline, and testable;
// the model as the fallback rather than the front door.

import type { ProposalOperation, ProposalPreview } from './proposals.js';
import type { WorkspaceRecordFilter, WorkspaceRecordSort } from './workspace-data.js';

/** What the sentence turned out to be asking for. */
export type IntentKind =
  /** Structural change: add a field, create a table. */
  | 'schema'
  /** Data change: add, edit, or remove rows. */
  | 'data'
  /** A question or a filter — reads only, applies nothing. */
  | 'query'
  /** Create or change a saved view. */
  | 'view'
  /** Understood as English, but outside what the local parser can do. */
  | 'unsupported';

/** Below this, the daemon will not apply a plan even if asked. A parse this
 * uncertain is more likely to be a sentence about something else that happened
 * to contain a table name. */
export const MIN_APPLY_CONFIDENCE = 0.5;

export interface InterpretIntentRequest {
  /** What the person typed, verbatim. */
  text: string;
  /** The table they were looking at. Resolves "add a phone column" without
   * making them name the table they are already staring at. */
  tableRef?: string;
}

/** A read the sentence asked for, when `kind` is `query`. Handed straight to
 * the existing record query endpoint. */
export interface IntentQueryPlan {
  tableRef: string;
  filters: WorkspaceRecordFilter[];
  sort: WorkspaceRecordSort | null;
  /** Free-text left over, searched across the table's text fields. */
  search: string | null;
}

/** A schema change a sentence asked for. Separate from `operations` because
 * these migrate existing rows, which the proposal engine's
 * one-inverse-per-operation model does not cover — so they are applied through
 * their own endpoints, with the impact report shown first. */
export interface SchemaChangePlan {
  kind: 'rename' | 'remove' | 'retype';
  table: string;
  field: string;
  /** New name for a rename, new type for a retype. */
  to?: string;
}

export interface InterpretIntentResponse {
  kind: IntentKind;
  /** Restatement of what will happen, in plain words, for the confirm step.
   * Always present — including for `unsupported`, where it explains why. */
  summary: string;
  /** 0–1. See MIN_APPLY_CONFIDENCE. */
  confidence: number;
  /** The change, ready to preview and apply. Empty for `query`/`unsupported`. */
  operations: ProposalOperation[];
  /** What applying would do, computed without applying it. */
  preview: ProposalPreview | null;
  /** Set when `kind` is `query`. */
  query: IntentQueryPlan | null;
  /** Set when the sentence asked to reshape a table rather than change data. */
  schemaChange: SchemaChangePlan | null;
  /** The part of the sentence the parser could not account for. Shown to the
   * person so a half-understood instruction is visibly half-understood. */
  unmatched: string | null;
  /** Phrasings that would work, offered when confidence is low or the intent
   * is unsupported. Concrete examples beat a grammar reference. */
  suggestions: string[];
}

export interface ApplyIntentRequest {
  /** The original text, kept so the proposal records what was asked in the
   * person's own words rather than a machine restatement. */
  text: string;
  operations: ProposalOperation[];
  /** Skip the approval queue and apply immediately. The UI sets this when the
   * person has already seen the preview and pressed a confirming button —
   * a second approval step for a change they just described and reviewed is
   * ceremony, not safety. Structural changes ignore it below full confidence. */
  applyNow?: boolean;
}

/** Every phrasing the local parser understands, with an example. Exported so
 * the help panel, the CLI help text, and the tests all read from one list
 * rather than three that drift. */
export const INTENT_EXAMPLES: ReadonlyArray<{ pattern: string; example: string; kind: IntentKind }> = [
  { pattern: 'add a <type> column called <name> to <table>', example: 'add a phone column to customers', kind: 'schema' },
  { pattern: 'add a row to <table> with <field> <value>', example: 'add a customer called Northwind', kind: 'data' },
  { pattern: 'create a table called <name> with <fields>', example: 'create a table called suppliers with name, email, phone', kind: 'schema' },
  { pattern: 'show <table> where <field> is <value>', example: 'show invoices where status is sent', kind: 'query' },
  { pattern: 'show overdue <table>', example: 'show overdue invoices', kind: 'query' },
  { pattern: 'sort <table> by <field>', example: 'sort invoices by total descending', kind: 'query' },
  { pattern: 'group <table> by <field>', example: 'group deals by stage', kind: 'view' },
  { pattern: 'rename <field> to <name>', example: 'rename phone to mobile', kind: 'schema' },
  { pattern: 'delete the <field> column', example: 'delete the fax column', kind: 'schema' },
];
