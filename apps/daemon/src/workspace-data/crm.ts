// The deal pipeline.
//
// Deals are ordinary records in the `deals` table — this module does not own
// storage, it reads the table through its roles and shapes the answer people
// actually ask for: what is in play, at what stage, worth how much.
//
// Weighted value is computed here rather than stored, because a stored forecast
// is a number that silently goes stale the moment someone edits a probability.

import {
  CLOSED_DEAL_STAGES,
  DEAL_STAGES,
  type DealStage,
  type DealPipelineStage,
  type PipelineSummary,
  type WorkspaceField,
  type WorkspaceRecord,
  type WorkspaceTable,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { fieldWithRole } from './hub.js';
import { loadTableByName } from './schema.js';
import { queryRecords } from './query.js';
import { getRecord, updateRecord } from './records.js';
import type { WorkspaceActor } from './types.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

function textValue(record: WorkspaceRecord, field: WorkspaceField | null): string | null {
  if (!field) return null;
  const value = record.data[field.name];
  return typeof value === 'string' && value.trim() ? value : null;
}

function intValue(record: WorkspaceRecord, field: WorkspaceField | null): number | null {
  if (!field) return null;
  const value = record.data[field.name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Resolve link fields to something readable. One lookup pass over the target
 * table beats one query per deal — a pipeline with 200 deals should not cost
 * 200 round trips to render a column of company names. */
function labelIndex(recordsDb: RecordsDb, tableName: string): Map<string, string> {
  const index = new Map<string, string>();
  let table: WorkspaceTable;
  try {
    table = loadTableByName(recordsDb, tableName);
  } catch {
    return index;
  }
  // The first text field is the name column in every pack we ship, and the
  // sensible guess for one we do not.
  const nameField = table.fields.find((field) => field.type === 'text');
  if (!nameField) return index;
  const { records } = queryRecords(recordsDb, table, { limit: 1000 });
  for (const record of records) {
    const value = record.data[nameField.name];
    if (typeof value === 'string') index.set(record.id, value);
  }
  return index;
}

export function loadPipeline(recordsDb: RecordsDb, currency = 'USD'): PipelineSummary {
  const table = loadTableByName(recordsDb, 'deals');
  const stageField = fieldWithRole(table, 'deal-stage');
  const valueField = fieldWithRole(table, 'deal-value');
  const probabilityField = fieldWithRole(table, 'deal-probability');
  const customerField = fieldWithRole(table, 'customer-link');
  const closeField = fieldWithRole(table, 'due-date');
  const ownerField = fieldWithRole(table, 'owner');
  const titleField = table.fields.find((field) => field.type === 'text') ?? null;

  const customers = customerField ? labelIndex(recordsDb, 'customers') : new Map<string, string>();
  const { records } = queryRecords(recordsDb, table, { limit: 1000 });

  const byStage = new Map<DealStage, DealPipelineStage>(
    DEAL_STAGES.map((stage) => [
      stage,
      { stage, dealCount: 0, totalValue: 0, weightedValue: 0, deals: [] },
    ]),
  );

  for (const record of records) {
    const rawStage = textValue(record, stageField);
    // A deal with an unrecognised stage still exists and still has value;
    // parking it in `new` keeps it on screen instead of quietly dropping it.
    const stage: DealStage = DEAL_STAGES.includes(rawStage as DealStage) ? (rawStage as DealStage) : 'new';
    const column = byStage.get(stage)!;
    const value = intValue(record, valueField) ?? 0;
    const probability = intValue(record, probabilityField);
    const customerId = textValue(record, customerField);

    column.dealCount += 1;
    column.totalValue += value;
    // Probability is a whole percent; an unset one means "no better estimate
    // than the stage itself", so it contributes at face value.
    column.weightedValue += probability === null ? value : Math.round((value * probability) / 100);
    column.deals.push({
      recordId: record.id,
      title: textValue(record, titleField) ?? '(untitled deal)',
      customerName: customerId ? (customers.get(customerId) ?? null) : null,
      value,
      probability,
      expectedClose: textValue(record, closeField),
      owner: textValue(record, ownerField),
    });
  }

  const stages = DEAL_STAGES.map((stage) => byStage.get(stage)!);
  const isOpen = (stage: DealStage) => !CLOSED_DEAL_STAGES.includes(stage);

  return {
    currency,
    stages,
    openValue: stages.filter((s) => isOpen(s.stage)).reduce((sum, s) => sum + s.totalValue, 0),
    weightedValue: stages.filter((s) => isOpen(s.stage)).reduce((sum, s) => sum + s.weightedValue, 0),
    wonValue: byStage.get('won')!.totalValue,
    lostValue: byStage.get('lost')!.totalValue,
  };
}

/** Move a deal to another stage. A one-field update, but it goes through here
 * so the stage is validated against the pipeline rather than whatever string
 * the caller sent. */
export function moveDealStage(
  recordsDb: RecordsDb,
  actor: WorkspaceActor,
  recordId: string,
  stage: string,
): WorkspaceRecord {
  if (!DEAL_STAGES.includes(stage as DealStage)) {
    throw workspaceValidationError([
      { path: 'stage', message: `stage must be one of: ${DEAL_STAGES.join(', ')}` },
    ]);
  }
  const table = loadTableByName(recordsDb, 'deals');
  const stageField = fieldWithRole(table, 'deal-stage');
  if (!stageField) {
    throw new WorkspaceDataError(
      'WORKSPACE_VALIDATION_FAILED',
      422,
      "the 'deals' table has no field marked as 'deal-stage'",
    );
  }
  const record = getRecord(recordsDb, recordId);
  // The record's own revision is passed as the expected one: this is a
  // single-field move from a board, so the caller is not editing the rest of
  // the deal and should not lose to a concurrent edit of an unrelated field.
  return updateRecord(
    recordsDb,
    table,
    actor,
    recordId,
    { [stageField.name]: stage },
    record.revision,
  );
}

/** Turn a won deal into a quote. Like the hub's document conversion, this
 * returns the prepared row instead of writing it — the person sees what they
 * are about to create, and edits it first if the number is stale. */
export function dealToQuote(
  recordsDb: RecordsDb,
  recordId: string,
  numbering: { number: string; date: string },
): { table: string; data: Record<string, unknown> } {
  const deals = loadTableByName(recordsDb, 'deals');
  const quotes = loadTableByName(recordsDb, 'quotes');
  const deal = getRecord(recordsDb, recordId);

  const data: Record<string, unknown> = {};
  const customerSource = fieldWithRole(deals, 'customer-link');
  const customerTarget = fieldWithRole(quotes, 'customer-link');
  if (customerSource && customerTarget) {
    const value = deal.data[customerSource.name];
    if (value) data[customerTarget.name] = value;
  }
  const valueSource = fieldWithRole(deals, 'deal-value');
  const totalTarget = fieldWithRole(quotes, 'total');
  if (valueSource && totalTarget) {
    const value = deal.data[valueSource.name];
    if (typeof value === 'number') data[totalTarget.name] = value;
  }
  const notesSource = fieldWithRole(deals, 'notes');
  const notesTarget = fieldWithRole(quotes, 'notes');
  if (notesSource && notesTarget) {
    const value = deal.data[notesSource.name];
    if (typeof value === 'string' && value) data[notesTarget.name] = value;
  }

  const numberField = fieldWithRole(quotes, 'document-number');
  if (numberField) data[numberField.name] = numbering.number;
  const dateField = fieldWithRole(quotes, 'issue-date');
  if (dateField) data[dateField.name] = numbering.date;
  const statusField = fieldWithRole(quotes, 'status');
  if (statusField) data[statusField.name] = 'draft';

  return { table: quotes.name, data };
}
