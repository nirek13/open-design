// Projects: hours booked, value earned, and whether the budget still holds.
//
// Billable value is summed per time entry at that entry's own rate, never from
// an average. Two people on the same project bill at different rates, so an
// average is a number that looks precise and is wrong.

import type {
  ErpProjectSummaryRow,
  ErpProjectsSummary,
  WorkspaceField,
  WorkspaceRecord,
} from '@open-design/contracts';
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

function num(record: WorkspaceRecord, field: WorkspaceField | null): number {
  if (!field) return 0;
  const value = record.data[field.name];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bool(record: WorkspaceRecord, field: WorkspaceField | null): boolean {
  if (!field) return false;
  return record.data[field.name] === true;
}

interface Totals {
  hours: number;
  billableHours: number;
  billableValue: number;
}

export function loadProjects(recordsDb: RecordsDb, currency = 'USD'): ErpProjectsSummary {
  const projects = loadTableByName(recordsDb, 'projects');

  const nameField = projects.fields.find((field) => field.type === 'text');
  const codeField = fieldWithRole(projects, 'document-number');
  const statusField = fieldWithRole(projects, 'status');
  const budgetField = fieldWithRole(projects, 'total');
  const customerField = fieldWithRole(projects, 'customer-link');

  const customerNames = new Map<string, string>();
  try {
    const customers = loadTableByName(recordsDb, 'customers');
    const customerName = customers.fields.find((field) => field.type === 'text');
    if (customerName) {
      for (const record of queryRecords(recordsDb, customers, { limit: 2000 }).records) {
        const value = record.data[customerName.name];
        if (typeof value === 'string') customerNames.set(record.id, value);
      }
    }
  } catch {
    // Projects can exist without the sales pack; the column just reads blank.
  }

  const totals = new Map<string, Totals>();
  try {
    const entries = loadTableByName(recordsDb, 'time_entries');
    const projectField = fieldWithRole(entries, 'project-link');
    const hoursField = fieldWithRole(entries, 'hours');
    const billableField = fieldWithRole(entries, 'billable');
    const rateField = fieldWithRole(entries, 'unit-price');

    if (projectField && hoursField) {
      for (const record of queryRecords(recordsDb, entries, { limit: 5000 }).records) {
        const projectId = text(record, projectField);
        if (!projectId) continue;
        const hours = num(record, hoursField);
        const billable = bool(record, billableField);
        const current = totals.get(projectId) ?? { hours: 0, billableHours: 0, billableValue: 0 };
        current.hours += hours;
        if (billable) {
          current.billableHours += hours;
          // Rate is money in minor units per hour; rounding once here keeps
          // the total an integer, as every amount in this system must be.
          current.billableValue += Math.round(hours * num(record, rateField));
        }
        totals.set(projectId, current);
      }
    }
  } catch {
    // No time booked yet.
  }

  const taskCounts = new Map<string, { total: number; open: number }>();
  try {
    const tasks = loadTableByName(recordsDb, 'project_tasks');
    const projectField = fieldWithRole(tasks, 'project-link');
    const doneField = fieldWithRole(tasks, 'completed');
    const taskStatus = fieldWithRole(tasks, 'status');

    if (projectField) {
      for (const record of queryRecords(recordsDb, tasks, { limit: 5000 }).records) {
        const projectId = text(record, projectField);
        if (!projectId) continue;
        const current = taskCounts.get(projectId) ?? { total: 0, open: 0 };
        current.total += 1;
        // Either signal counts as finished: some teams tick the box, others
        // move the status, and both mean the same thing.
        const finished = bool(record, doneField) || text(record, taskStatus) === 'done';
        if (!finished) current.open += 1;
        taskCounts.set(projectId, current);
      }
    }
  } catch {
    // No tasks yet.
  }

  const rows: ErpProjectSummaryRow[] = [];
  let totalHours = 0;
  let totalBillableValue = 0;

  for (const record of queryRecords(recordsDb, projects, { limit: 1000 }).records) {
    const booked = totals.get(record.id) ?? { hours: 0, billableHours: 0, billableValue: 0 };
    const tasks = taskCounts.get(record.id) ?? { total: 0, open: 0 };
    const budget = num(record, budgetField);

    totalHours += booked.hours;
    totalBillableValue += booked.billableValue;

    rows.push({
      projectId: record.id,
      name: text(record, nameField ?? null),
      code: text(record, codeField) || null,
      status: text(record, statusField),
      customerName: customerNames.get(text(record, customerField)) ?? null,
      budget,
      hours: booked.hours,
      billableHours: booked.billableHours,
      billableValue: booked.billableValue,
      taskCount: tasks.total,
      openTaskCount: tasks.open,
      budgetRemaining: budget - booked.billableValue,
    });
  }

  // Over-budget projects first — the ones someone needs to look at today.
  rows.sort((a, b) => a.budgetRemaining - b.budgetRemaining);

  return { currency, projects: rows, totalHours, totalBillableValue };
}
