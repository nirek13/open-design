// What we owe vendors, and how late it is.
//
// Outstanding is derived from bill payments rather than stored on the bill.
// A stored balance is a second source of truth that drifts the first time
// someone records a payment through a path that forgets to update it — and
// there is always such a path eventually.

import type { PayablesRow, PayablesSummary, WorkspaceField, WorkspaceRecord } from '@open-design/contracts';
import { fieldWithRole } from './hub.js';
import { loadTableByName } from './schema.js';
import { queryRecords } from './query.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

function text(record: WorkspaceRecord, field: WorkspaceField | null): string {
  if (!field) return '';
  const value = record.data[field.name];
  return typeof value === 'string' ? value : '';
}

function money(record: WorkspaceRecord, field: WorkspaceField | null): number {
  if (!field) return 0;
  const value = record.data[field.name];
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

/** Whole days from `date` to `today`, positive when overdue. Both are
 * YYYY-MM-DD, so this is calendar arithmetic in UTC — no timezone can make a
 * bill look a day later than the date printed on it. */
export function daysBetween(date: string, today: string): number {
  const from = Date.parse(`${date}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

export function loadPayables(
  recordsDb: RecordsDb,
  options: { asOf?: string; currency?: string } = {},
): PayablesSummary {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const currency = options.currency ?? 'USD';
  const bills = loadTableByName(recordsDb, 'bills');

  const numberField = fieldWithRole(bills, 'document-number');
  const vendorField = fieldWithRole(bills, 'vendor-link');
  const issueField = fieldWithRole(bills, 'issue-date');
  const dueField = fieldWithRole(bills, 'due-date');
  const totalField = fieldWithRole(bills, 'total');
  const statusField = fieldWithRole(bills, 'status');

  const vendorNames = new Map<string, string>();
  try {
    const vendors = loadTableByName(recordsDb, 'vendors');
    const nameField = vendors.fields.find((field) => field.type === 'text');
    if (nameField) {
      for (const record of queryRecords(recordsDb, vendors, { limit: 1000 }).records) {
        const value = record.data[nameField.name];
        if (typeof value === 'string') vendorNames.set(record.id, value);
      }
    }
  } catch {
    // Purchasing installed without vendors is not a state we create, but a
    // missing name should degrade to null rather than fail the whole report.
  }

  // Sum payments per bill in one pass, so the report is two table reads
  // regardless of how many bills there are.
  const paidByBill = new Map<string, number>();
  try {
    const payments = loadTableByName(recordsDb, 'bill_payments');
    const billField = fieldWithRole(payments, 'bill-link');
    const amountField = fieldWithRole(payments, 'amount');
    if (billField && amountField) {
      for (const record of queryRecords(recordsDb, payments, { limit: 2000 }).records) {
        const billId = record.data[billField.name];
        if (typeof billId !== 'string') continue;
        paidByBill.set(billId, (paidByBill.get(billId) ?? 0) + money(record, amountField));
      }
    }
  } catch {
    // No payments table yet means nothing has been paid.
  }

  const rows: PayablesRow[] = [];
  let totalOutstanding = 0;
  let totalOverdue = 0;

  for (const record of queryRecords(recordsDb, bills, { limit: 1000 }).records) {
    const status = text(record, statusField);
    // A draft is not owed yet and a void one never was.
    if (status === 'draft' || status === 'void') continue;

    const total = money(record, totalField);
    const paid = paidByBill.get(record.id) ?? 0;
    const outstanding = total - paid;
    if (outstanding <= 0) continue;

    const dueDate = text(record, dueField) || null;
    const daysOverdue = dueDate ? daysBetween(dueDate, asOf) : 0;
    totalOutstanding += outstanding;
    if (daysOverdue > 0) totalOverdue += outstanding;

    rows.push({
      recordId: record.id,
      billNumber: text(record, numberField),
      vendorName: vendorNames.get(text(record, vendorField)) ?? null,
      issueDate: text(record, issueField),
      dueDate,
      total,
      paid,
      outstanding,
      status,
      daysOverdue,
    });
  }

  // Most overdue first: the report exists to answer "what should I pay now".
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue || b.outstanding - a.outstanding);

  return { currency, rows, totalOutstanding, totalOverdue };
}
