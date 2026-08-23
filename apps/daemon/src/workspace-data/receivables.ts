// What customers owe us, and how late it is.
//
// Sell-side mirror of payables.ts: outstanding is derived from invoice
// payments rather than stored on the invoice, so the report cannot drift from
// the payment rows.

import type { ReceivablesSummary, WorkspaceField, WorkspaceRecord } from '@open-design/contracts';
import { fieldWithRole } from './hub.js';
import { loadTableByName } from './schema.js';
import { queryRecords } from './query.js';
import { daysBetween } from './payables.js';
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

export function loadReceivables(
  recordsDb: RecordsDb,
  options: { asOf?: string; currency?: string } = {},
): ReceivablesSummary {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const currency = options.currency ?? 'USD';
  const invoices = loadTableByName(recordsDb, 'invoices');

  const numberField = fieldWithRole(invoices, 'document-number');
  const customerField = fieldWithRole(invoices, 'customer-link');
  const issueField = fieldWithRole(invoices, 'issue-date');
  const dueField = fieldWithRole(invoices, 'due-date');
  const totalField = fieldWithRole(invoices, 'total');
  const statusField = fieldWithRole(invoices, 'status');

  const customerNames = new Map<string, string>();
  try {
    const customers = loadTableByName(recordsDb, 'customers');
    const nameField = customers.fields.find((field) => field.type === 'text');
    if (nameField) {
      for (const record of queryRecords(recordsDb, customers, { limit: 1000 }).records) {
        const value = record.data[nameField.name];
        if (typeof value === 'string') customerNames.set(record.id, value);
      }
    }
  } catch {
    // Hub without customers still reports invoices; names degrade to null.
  }

  const paidByInvoice = new Map<string, number>();
  try {
    const payments = loadTableByName(recordsDb, 'payments');
    const invoiceField = fieldWithRole(payments, 'invoice-link');
    const amountField = fieldWithRole(payments, 'amount');
    if (invoiceField && amountField) {
      for (const record of queryRecords(recordsDb, payments, { limit: 2000 }).records) {
        const invoiceId = record.data[invoiceField.name];
        if (typeof invoiceId !== 'string') continue;
        paidByInvoice.set(
          invoiceId,
          (paidByInvoice.get(invoiceId) ?? 0) + money(record, amountField),
        );
      }
    }
  } catch {
    // No payments table → everything outstanding equals total.
  }

  const rows = [];
  for (const record of queryRecords(recordsDb, invoices, { limit: 2000 }).records) {
    const status = text(record, statusField).toLowerCase();
    if (status === 'void' || status === 'draft') continue;
    const total = money(record, totalField);
    const paid = paidByInvoice.get(record.id) ?? 0;
    const outstanding = Math.max(0, total - paid);
    if (outstanding <= 0) continue;
    const dueDate = text(record, dueField) || null;
    const issueDate = text(record, issueField) || asOf;
    const customerId = customerField ? record.data[customerField.name] : null;
    rows.push({
      recordId: record.id,
      billNumber: text(record, numberField) || record.id.slice(0, 8),
      vendorName:
        typeof customerId === 'string' ? (customerNames.get(customerId) ?? null) : null,
      issueDate,
      dueDate,
      total,
      paid,
      outstanding,
      status: text(record, statusField) || 'open',
      daysOverdue: dueDate ? daysBetween(dueDate, asOf) : 0,
    });
  }

  rows.sort((a, b) => b.daysOverdue - a.daysOverdue || a.billNumber.localeCompare(b.billNumber));

  return {
    currency,
    rows,
    totalOutstanding: rows.reduce((sum, row) => sum + row.outstanding, 0),
    totalOverdue: rows
      .filter((row) => row.daysOverdue > 0)
      .reduce((sum, row) => sum + row.outstanding, 0),
  };
}
