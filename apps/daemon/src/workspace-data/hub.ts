// Setting up the business hub, and turning documents into accounting.
//
// The hub tables are ordinary workspace tables. That is deliberate: "add a PO
// number to orders" has to be answerable in seconds, which is only possible
// if orders are rows in a table whose schema can grow. What the platform
// pins down is the handful of fields automatic accounting reads — the total,
// the customer, the status — so posting keeps working after someone adds
// three columns of their own.
//
// Posting is driven by status. A draft invoice is a piece of paper; sending
// it is the accounting event. Nothing posts twice: each document's entries
// are found by source reference before anything new is written.

import {
  DEFAULT_CHART_OF_ACCOUNTS,
  HUB_SCHEMA,
  type CreateJournalEntryRequest,
  type HubFieldRole,
  type HubSetupResult,
  type HubStatus,
  type HubTableName,
  type JournalEntry,
  type WorkspaceField,
  type WorkspaceRecord,
  type WorkspaceTable,
} from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import { listTables, loadTableByName } from './schema.js';
import { queryRecords } from './query.js';
import { getRecord, updateRecord } from './records.js';
import { listJournalEntries, postJournalEntry, reverseJournalEntry, seedChartOfAccounts } from './ledger.js';
import { installTemplate } from './templates.js';
import type { WorkspaceActor } from './types.js';
import type { SqlExecutor } from '../storage/sql.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

/** Where a hub field's role is recorded. Roles live in the field's config so
 * they survive renames of the display name and are visible to anyone
 * inspecting the schema — no hidden side table to drift out of sync. */
function roleOf(field: WorkspaceField): HubFieldRole | null {
  const role = (field.config as { role?: string } | null)?.role;
  return typeof role === 'string' ? (role as HubFieldRole) : null;
}

export function fieldWithRole(table: WorkspaceTable, role: HubFieldRole): WorkspaceField | null {
  return table.fields.find((field) => roleOf(field) === role) ?? null;
}

function requireRole(table: WorkspaceTable, role: HubFieldRole): WorkspaceField {
  const field = fieldWithRole(table, role);
  if (!field) {
    throw new WorkspaceDataError(
      'WORKSPACE_VALIDATION_FAILED',
      422,
      `table '${table.name}' has no field marked as '${role}'; automatic accounting needs it`,
    );
  }
  return field;
}

// --- Setup ----------------------------------------------------------------

/** Create the hub tables and chart of accounts. Never overwrites: a table
 * that already exists is left exactly as the organization has customized it. */
export async function setUpBusinessHub(
  recordsDb: RecordsDb,
  ledgerDb: SqlExecutor,
  orgId: string,
  actor: WorkspaceActor,
): Promise<HubSetupResult> {
  // The hub is the `sales` template. Installing it goes through the same
  // installer every other pack uses, so there is one definition of how a spec
  // becomes tables and one meaning for "already there".
  const result = await installTemplate(recordsDb, ledgerDb, orgId, 'sales', actor);
  // The default chart is the whole business's starting point, not the sales
  // pack's — purchasing and manual entries need it too, so it is seeded here
  // rather than hung off one template.
  const accountsCreated = await seedChartOfAccounts(ledgerDb, orgId, DEFAULT_CHART_OF_ACCOUNTS);
  return {
    created: result.created as HubTableName[],
    skipped: result.skipped as HubTableName[],
    accountsCreated,
  };
}

export async function businessHubStatus(
  recordsDb: RecordsDb,
  ledgerDb: SqlExecutor,
  orgId: string,
): Promise<HubStatus> {
  const byName = new Map(listTables(recordsDb).map((table) => [table.name, table]));
  const tables = HUB_SCHEMA.map((spec) => {
    const table = byName.get(spec.name);
    return {
      name: spec.name,
      present: Boolean(table),
      tableId: table?.id ?? null,
      recordCount: table ? queryRecords(recordsDb, table, { limit: 200 }).records.length : 0,
    };
  });
  const accounts = await ledgerDb.get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM od_ledger_accounts WHERE workspace_id = ? AND archived_at IS NULL',
    [orgId],
  );
  return {
    ready: tables.every((table) => table.present),
    tables,
    accountCount: Number(accounts?.n ?? 0),
  };
}

// --- Document → ledger ----------------------------------------------------

function money(record: WorkspaceRecord, field: WorkspaceField | null): number {
  if (!field) return 0;
  const value = record.data[field.name];
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

function text(record: WorkspaceRecord, field: WorkspaceField | null): string {
  if (!field) return '';
  const value = record.data[field.name];
  return typeof value === 'string' ? value : '';
}

/** Has this document already been posted? Entries carry a source reference,
 * so the answer is a lookup rather than a flag someone could forget to set. */
export async function existingEntriesForDocument(
  ledgerDb: SqlExecutor,
  orgId: string,
  recordId: string,
): Promise<JournalEntry[]> {
  const entries = await listJournalEntries(ledgerDb, orgId, { sourceRecordId: recordId });
  return entries.filter((entry) => entry.source.recordId === recordId && entry.status === 'posted');
}

/** The accounting for sending an invoice: the customer now owes us, and we
 * have earned revenue. Tax, when present, is a liability rather than income —
 * it was never ours. */
export function invoiceEntryPlan(
  invoiceTable: WorkspaceTable,
  invoice: WorkspaceRecord,
): CreateJournalEntryRequest {
  const total = money(invoice, fieldWithRole(invoiceTable, 'total'));
  const tax = money(invoice, fieldWithRole(invoiceTable, 'tax'));
  const number = text(invoice, requireRole(invoiceTable, 'document-number'));
  const date = text(invoice, requireRole(invoiceTable, 'issue-date'));
  const revenue = total - tax;

  const lines: CreateJournalEntryRequest['lines'] = [
    { accountCode: '1100', direction: 'debit', amount: total, memo: `Invoice ${number}` },
    { accountCode: '4000', direction: 'credit', amount: revenue, memo: `Invoice ${number}` },
  ];
  if (tax > 0) {
    lines.push({ accountCode: '2100', direction: 'credit', amount: tax, memo: `Tax on ${number}` });
  }
  return {
    date,
    memo: `Invoice ${number}`,
    lines,
    source: { kind: 'invoice', tableId: invoiceTable.id, recordId: invoice.id, label: `Invoice ${number}` },
  };
}

/** The accounting for receiving money: cash goes up, what the customer owes
 * goes down. Revenue is untouched — it was recognised when we invoiced. */
export function paymentEntryPlan(
  paymentTable: WorkspaceTable,
  payment: WorkspaceRecord,
): CreateJournalEntryRequest {
  const amount = money(payment, requireRole(paymentTable, 'amount'));
  const reference = text(payment, requireRole(paymentTable, 'document-number'));
  const date = text(payment, requireRole(paymentTable, 'issue-date'));
  return {
    date,
    memo: `Payment ${reference}`,
    lines: [
      { accountCode: '1000', direction: 'debit', amount, memo: `Payment ${reference}` },
      { accountCode: '1100', direction: 'credit', amount, memo: `Payment ${reference}` },
    ],
    source: { kind: 'payment', tableId: paymentTable.id, recordId: payment.id, label: `Payment ${reference}` },
  };
}

/** The accounting for approving a bill: we now owe the vendor, and the cost is
 * ours. The mirror image of sending an invoice. Recoverable input tax is an
 * asset rather than a cost — we get it back — which is why it splits out of
 * the expense line instead of inflating it. */
export function billEntryPlan(billTable: WorkspaceTable, bill: WorkspaceRecord): CreateJournalEntryRequest {
  const total = money(bill, fieldWithRole(billTable, 'total'));
  const tax = money(bill, fieldWithRole(billTable, 'tax'));
  const number = text(bill, requireRole(billTable, 'document-number'));
  const date = text(bill, requireRole(billTable, 'issue-date'));
  // Whoever coded the bill picks where the cost lands; operating expenses is
  // the safe default because it is the account that is always meaningful.
  const expenseCode = text(bill, fieldWithRole(billTable, 'expense-account')).trim() || '6000';
  const cost = total - tax;

  const lines: CreateJournalEntryRequest['lines'] = [
    { accountCode: expenseCode, direction: 'debit', amount: cost, memo: `Bill ${number}` },
    { accountCode: '2000', direction: 'credit', amount: total, memo: `Bill ${number}` },
  ];
  if (tax > 0) {
    lines.splice(1, 0, {
      accountCode: '2110',
      direction: 'debit',
      amount: tax,
      memo: `Tax on ${number}`,
    });
  }
  return {
    date,
    memo: `Bill ${number}`,
    lines,
    source: { kind: 'bill', tableId: billTable.id, recordId: bill.id, label: `Bill ${number}` },
  };
}

/** The accounting for paying a vendor: cash goes down, what we owe goes down.
 * The cost is untouched — it was recognised when the bill was approved. */
export function billPaymentEntryPlan(
  paymentTable: WorkspaceTable,
  payment: WorkspaceRecord,
): CreateJournalEntryRequest {
  const amount = money(payment, requireRole(paymentTable, 'amount'));
  const reference = text(payment, requireRole(paymentTable, 'document-number'));
  const date = text(payment, requireRole(paymentTable, 'issue-date'));
  return {
    date,
    memo: `Bill payment ${reference}`,
    lines: [
      { accountCode: '2000', direction: 'debit', amount, memo: `Payment ${reference}` },
      { accountCode: '1000', direction: 'credit', amount, memo: `Payment ${reference}` },
    ],
    source: {
      kind: 'bill-payment',
      tableId: paymentTable.id,
      recordId: payment.id,
      label: `Bill payment ${reference}`,
    },
  };
}

/** Tables whose records post to the books, and the plan each one produces.
 * Adding a postable document type is an entry here plus its plan function —
 * the posting endpoint, the CLI, and the record editor all read this map
 * rather than carrying their own list of what is postable. */
/** The accounting for approving an expense claim: the company now owes the
 * person who paid, and the cost is ours. The same shape as a bill, except the
 * creditor is an employee rather than a vendor — which is why it credits its
 * own liability account instead of accounts payable. */
export function expenseClaimEntryPlan(
  claimTable: WorkspaceTable,
  claim: WorkspaceRecord,
): CreateJournalEntryRequest {
  const total = money(claim, fieldWithRole(claimTable, 'total'));
  const tax = money(claim, fieldWithRole(claimTable, 'tax'));
  const reference = text(claim, requireRole(claimTable, 'document-number'));
  const date = text(claim, requireRole(claimTable, 'issue-date'));
  const expenseCode = text(claim, fieldWithRole(claimTable, 'expense-account')).trim() || '6000';
  const cost = total - tax;

  const lines: CreateJournalEntryRequest['lines'] = [
    { accountCode: expenseCode, direction: 'debit', amount: cost, memo: `Expense ${reference}` },
    { accountCode: '2200', direction: 'credit', amount: total, memo: `Owed to claimant` },
  ];
  if (tax > 0) {
    lines.splice(1, 0, {
      accountCode: '2110',
      direction: 'debit',
      amount: tax,
      memo: `Tax on ${reference}`,
    });
  }
  return {
    date,
    memo: `Expense claim ${reference}`,
    lines,
    source: {
      kind: 'expense-claim',
      tableId: claimTable.id,
      recordId: claim.id,
      label: `Expense ${reference}`,
    },
  };
}

/** The accounting for stock leaving without a sale: the asset is gone and the
 * loss is a cost. Only write-offs post — a receipt is paid for through a bill
 * and a shipment is accounted for by the invoice, so posting those here would
 * double-count them. */
export function stockWriteOffEntryPlan(
  movementTable: WorkspaceTable,
  movement: WorkspaceRecord,
): CreateJournalEntryRequest {
  const quantityField = requireRole(movementTable, 'quantity');
  const rawQuantity = movement.data[quantityField.name];
  const quantity = typeof rawQuantity === 'number' ? Math.abs(rawQuantity) : 0;
  const unitCost = money(movement, fieldWithRole(movementTable, 'unit-cost'));
  const reference = text(movement, requireRole(movementTable, 'document-number'));
  const date = text(movement, requireRole(movementTable, 'issue-date'));
  const value = quantity * unitCost;

  return {
    date,
    memo: `Write-off ${reference}`,
    lines: [
      { accountCode: '5000', direction: 'debit', amount: value, memo: `Write-off ${reference}` },
      { accountCode: '1300', direction: 'credit', amount: value, memo: `Stock removed` },
    ],
    source: {
      kind: 'stock-write-off',
      tableId: movementTable.id,
      recordId: movement.id,
      label: `Write-off ${reference}`,
    },
  };
}

export const POSTABLE_TABLES = {
  invoices: invoiceEntryPlan,
  payments: paymentEntryPlan,
  bills: billEntryPlan,
  bill_payments: billPaymentEntryPlan,
  expense_claims: expenseClaimEntryPlan,
  stock_movements: stockWriteOffEntryPlan,
} as const;

export type PostableTableName = keyof typeof POSTABLE_TABLES;

export function isPostableTable(name: string): name is PostableTableName {
  return Object.hasOwn(POSTABLE_TABLES, name);
}

export interface PostDocumentResult {
  entry: JournalEntry | null;
  /** Set when nothing was posted, explaining why — already posted, still a
   * draft, or zero value. Not an error; most calls land here. */
  skipped: string | null;
}

/** Post a document to the books if its state calls for it. Safe to call on
 * every save: it is a no-op unless the document just became postable. */
export async function postDocumentIfReady(
  recordsDb: RecordsDb,
  ledgerDb: SqlExecutor,
  orgId: string,
  postedBy: string,
  tableName: PostableTableName,
  recordId: string,
): Promise<PostDocumentResult> {
  const table = loadTableByName(recordsDb, tableName);
  const record = getRecord(recordsDb, recordId);
  if (record.deletedAt !== null) return { entry: null, skipped: 'record is deleted' };

  const already = await existingEntriesForDocument(ledgerDb, orgId, recordId);
  if (already.length > 0) return { entry: null, skipped: 'already posted' };

  const blocked = statusBlockingPosting(table, record, tableName);
  if (blocked) return { entry: null, skipped: blocked };

  const plan = POSTABLE_TABLES[tableName](table, record);
  if (plan.lines.every((line) => line.amount === 0)) {
    return { entry: null, skipped: `${DOCUMENT_LABELS[tableName]} amount is zero` };
  }
  return { entry: await postJournalEntry(ledgerDb, orgId, postedBy, plan), skipped: null };
}

const DOCUMENT_LABELS: Record<PostableTableName, string> = {
  invoices: 'invoice',
  payments: 'payment',
  bills: 'bill',
  bill_payments: 'bill payment',
  expense_claims: 'expense claim',
  stock_movements: 'stock movement',
};

/** Statuses that mean the document is not an accounting event yet, or never
 * was. A draft has not happened; a void one never did. Money movements
 * (payments) carry no such gate — recording one is the event. */
const NON_POSTING_STATUSES: Partial<Record<PostableTableName, readonly string[]>> = {
  invoices: ['draft', 'void'],
  bills: ['draft', 'void'],
  // A claim is only owed once someone has approved it; `reimbursed` already
  // posted when it was approved.
  expense_claims: ['draft', 'submitted', 'rejected'],
};

/** Stock movements are gated on kind rather than status: only a write-off is
 * an accounting event. A receipt is paid for through its bill and a shipment is
 * accounted for by its invoice, so posting those here would count them twice. */
const POSTING_MOVEMENT_KINDS: readonly string[] = ['write-off'];

function statusBlockingPosting(
  table: WorkspaceTable,
  record: WorkspaceRecord,
  tableName: PostableTableName,
): string | null {
  if (tableName === 'stock_movements') {
    const kindField = fieldWithRole(table, 'movement-kind');
    const kind = kindField ? text(record, kindField) : '';
    return POSTING_MOVEMENT_KINDS.includes(kind)
      ? null
      : `a ${kind || 'stock'} movement does not post to the books`;
  }
  const gate = NON_POSTING_STATUSES[tableName];
  if (!gate) return null;
  const statusField = fieldWithRole(table, 'status');
  if (!statusField) return null;
  const status = text(record, statusField);
  return gate.includes(status) ? `${DOCUMENT_LABELS[tableName]} is ${status}` : null;
}

/** Undo a document's accounting by reversing what it posted. Used when a
 * sent invoice is voided — the original entries stay in the books, and the
 * reversal explains itself. */
export async function unpostDocument(
  ledgerDb: SqlExecutor,
  orgId: string,
  postedBy: string,
  recordId: string,
): Promise<JournalEntry[]> {
  const posted = await existingEntriesForDocument(ledgerDb, orgId, recordId);
  const reversals: JournalEntry[] = [];
  for (const entry of posted) {
    const { reversal } = await reverseJournalEntry(ledgerDb, orgId, entry.id, postedBy, {
      memo: `Reversal of ${entry.source.label ?? entry.id}`,
    });
    reversals.push(reversal);
  }
  return reversals;
}

/** Convert an accepted quote into an order, then an invoice — the everyday
 * path through the hub. Copies the fields that carry a role and leaves
 * everything custom alone, because we cannot know what it means. */
export function convertDocument(
  recordsDb: RecordsDb,
  actor: WorkspaceActor,
  from: string,
  to: string,
  sourceRecordId: string,
  numbering: { number: string; date: string },
): { data: Record<string, unknown>; targetTable: WorkspaceTable } {
  const sourceTable = loadTableByName(recordsDb, from);
  const targetTable = loadTableByName(recordsDb, to);
  const source = getRecord(recordsDb, sourceRecordId);

  const data: Record<string, unknown> = {};
  // Roles carried across every conversion the system supports: quote → order →
  // invoice on the sell side, purchase order → bill on the buy side. Fields
  // without a role are left alone, because we cannot know what they mean.
  const carry: HubFieldRole[] = [
    'customer-link',
    'vendor-link',
    'subtotal',
    'tax',
    'total',
    'notes',
    'expense-account',
  ];
  for (const role of carry) {
    const sourceField = fieldWithRole(sourceTable, role);
    const targetField = fieldWithRole(targetTable, role);
    if (!sourceField || !targetField) continue;
    const value = source.data[sourceField.name];
    if (value !== undefined && value !== null) data[targetField.name] = value;
  }
  data[requireRole(targetTable, 'document-number').name] = numbering.number;
  data[requireRole(targetTable, 'issue-date').name] = numbering.date;
  const statusField = fieldWithRole(targetTable, 'status');
  if (statusField) data[statusField.name] = 'draft';

  // Point the new document back at the one it came from, when the target has
  // somewhere to put it. This is what makes "which PO is this bill against?"
  // answerable later without reading the notes field.
  const backLink = BACK_LINK_ROLES[sourceTable.name];
  if (backLink) {
    const linkField = fieldWithRole(targetTable, backLink);
    if (linkField) data[linkField.name] = source.id;
  }
  void actor;
  return { data, targetTable };
}

/** Which role on a converted document points back at its source table. */
const BACK_LINK_ROLES: Record<string, HubFieldRole | undefined> = {
  purchase_orders: 'purchase-order-link',
  invoices: 'invoice-link',
  bills: 'bill-link',
  deals: 'deal-link',
};

/** Next document number for a table, e.g. INV-1042. Reads the highest
 * existing number rather than keeping a counter, so importing historical
 * documents does not create collisions later. */
export function nextDocumentNumber(
  recordsDb: RecordsDb,
  tableName: string,
  prefix: string,
): string {
  const table = loadTableByName(recordsDb, tableName);
  const field = fieldWithRole(table, 'document-number');
  if (!field) return `${prefix}-1001`;
  const { records } = queryRecords(recordsDb, table, { limit: 200, includeDeleted: true });
  let highest = 1000;
  for (const record of records) {
    const value = record.data[field.name];
    if (typeof value !== 'string') continue;
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(value);
    if (match) highest = Math.max(highest, Number.parseInt(match[1]!, 10));
  }
  return `${prefix}-${highest + 1}`;
}

export { updateRecord };
