// Getting an existing business into the system by dropping in a spreadsheet.
//
// Two steps on purpose. First we read the file and say what we think it is —
// these columns, these types, this many rows, and here is why we guessed each
// type. Then, only if that reading looks right, we import. A wrong guess about
// a column caught at the preview costs nothing; caught after import it has
// already shaped a table other things now depend on.
//
// CSV is parsed here rather than pulled in as a dependency because the format
// is small and the edge cases that matter — quoted fields containing commas,
// embedded newlines, doubled quotes — are exactly the ones a naive split gets
// wrong and a library would hide.

import type { ImportPlan, ImportPlanColumn, WorkspaceFieldInput } from '@open-design/contracts';
import { WORKSPACE_NAME_PATTERN } from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import { createTable, listTables, resolveTable } from './schema.js';
import { createRecord } from './records.js';
import type { WorkspaceActor } from './types.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

const MAX_ROWS = 5000;

/** Parse delimited text into rows. Handles quoted fields containing the
 * delimiter, embedded newlines, and doubled quotes as an escaped quote. */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ''));
}

/** Guess the delimiter from the header line. Tabs and semicolons are common
 * in exports from non-English locales. */
function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = [',', '\t', ';', '|'].map((candidate) => ({
    candidate,
    count: firstLine.split(candidate).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0]!.count > 0 ? counts[0]!.candidate : ',';
}

export function toFieldName(header: string, taken: Set<string>): string {
  let base = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!base || !/^[a-z]/.test(base)) base = `col_${base}`.slice(0, 60);
  if (!WORKSPACE_NAME_PATTERN.test(base)) base = 'column';
  let name = base;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${base}_${suffix}`.slice(0, 64);
    suffix += 1;
  }
  taken.add(name);
  return name;
}

const MONEY_PATTERN = /^-?[$£€]?\s?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^-?[$£€]?\s?\d+(\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INT_PATTERN = /^-?\d+$/;
const NUMBER_PATTERN = /^-?\d*\.?\d+$/;
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', 'y', 'n']);

interface TypeGuess {
  type: ImportPlanColumn['type'];
  reason: string;
}

/** Guess a column's type from its values, and say why. The reason matters:
 * it is what lets someone spot that a column of ZIP codes was read as numbers
 * before that becomes a permanent schema decision. */
export function guessColumnType(header: string, values: string[]): TypeGuess {
  const filled = values.map((value) => value.trim()).filter((value) => value !== '');
  if (filled.length === 0) return { type: 'text', reason: 'no values to judge from' };

  const headerHint = header.toLowerCase();
  const looksMonetary = /(amount|total|price|cost|subtotal|tax|balance|paid|fee|salary|rate)/.test(headerHint);

  if (filled.every((value) => DATE_PATTERN.test(value))) {
    return { type: 'date', reason: 'every value is a YYYY-MM-DD date' };
  }
  if (filled.every((value) => BOOL_VALUES.has(value.toLowerCase()))) {
    return { type: 'boolean', reason: 'every value is yes/no or true/false' };
  }
  if (looksMonetary && filled.every((value) => MONEY_PATTERN.test(value))) {
    return { type: 'money', reason: 'header names an amount and every value looks like currency' };
  }
  if (filled.every((value) => INT_PATTERN.test(value))) {
    // A long run of digits is almost never a number you want to do maths on —
    // phone numbers, ZIPs, and account codes all lose leading zeros.
    if (filled.some((value) => value.length > 11 || /^0\d/.test(value))) {
      return { type: 'text', reason: 'digits, but long or zero-padded — kept as text to preserve them' };
    }
    return { type: 'integer', reason: 'every value is a whole number' };
  }
  if (filled.every((value) => NUMBER_PATTERN.test(value))) {
    return { type: 'number', reason: 'every value is numeric' };
  }
  return { type: 'text', reason: 'mixed or free-form values' };
}

/** Convert a cell to the value the schema expects. Money becomes integer
 * minor units here, once, so no float ever reaches the database. */
export function coerceCell(raw: string, type: ImportPlanColumn['type']): unknown {
  const value = raw.trim();
  if (value === '') return null;
  switch (type) {
    case 'money': {
      const cleaned = value.replace(/[$£€,\s]/g, '');
      const parsed = Number.parseFloat(cleaned);
      if (!Number.isFinite(parsed)) return null;
      return Math.round(parsed * 100);
    }
    case 'integer': {
      const parsed = Number.parseInt(value.replace(/[,\s]/g, ''), 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'number': {
      const parsed = Number.parseFloat(value.replace(/[,\s]/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'boolean': {
      const lower = value.toLowerCase();
      return lower === 'true' || lower === 'yes' || lower === 'y';
    }
    case 'json':
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

export interface BuildPlanInput {
  content: string;
  /** Desired table name; defaults to a name derived from the file. */
  tableName?: string;
  fileName?: string;
}

export function buildImportPlan(recordsDb: RecordsDb, input: BuildPlanInput): ImportPlan {
  const delimiter = detectDelimiter(input.content);
  const rows = parseDelimited(input.content, delimiter);
  if (rows.length < 2) {
    throw new WorkspaceDataError(
      'IMPORT_UNREADABLE',
      422,
      'this file needs a header row and at least one row of data',
    );
  }
  const [headerRow, ...dataRows] = rows as [string[], ...string[][]];
  const taken = new Set<string>();
  const skipped: ImportPlan['skipped'] = [];

  const columns: ImportPlanColumn[] = headerRow.map((header, index) => {
    const values = dataRows.slice(0, 200).map((row) => row[index] ?? '');
    const guess = guessColumnType(header, values);
    return {
      header: header.trim() || `Column ${index + 1}`,
      fieldName: toFieldName(header || `column_${index + 1}`, taken),
      type: guess.type,
      reason: guess.reason,
      sample: values.filter((value) => value.trim() !== '').slice(0, 3),
    };
  });

  const usable = dataRows.filter((row, index) => {
    if (row.length > headerRow.length) {
      skipped.push({ row: index + 2, reason: `has ${row.length} values but the header has ${headerRow.length}` });
      return false;
    }
    return true;
  });
  if (usable.length > MAX_ROWS) {
    skipped.push({
      row: MAX_ROWS + 2,
      reason: `only the first ${MAX_ROWS} rows are imported in one go`,
    });
  }

  const derived =
    input.tableName?.trim() ||
    toFieldName(input.fileName?.replace(/\.[^.]+$/, '') || 'imported_data', new Set());
  const existing = listTables(recordsDb).some((table) => table.name === derived);

  return {
    tableName: derived,
    displayName: (input.fileName ?? derived).replace(/\.[^.]+$/, ''),
    appendingToExisting: existing,
    columns,
    rowCount: Math.min(usable.length, MAX_ROWS),
    skipped,
  };
}

export interface CommitImportResult {
  tableId: string;
  imported: number;
  skipped: number;
}

/** Create the table (if new) and write the rows. Rows that fail validation
 * are counted and skipped rather than aborting the whole import — one bad
 * line in a thousand should not cost the other nine hundred and ninety-nine. */
export function commitImport(
  recordsDb: RecordsDb,
  actor: WorkspaceActor,
  plan: ImportPlan,
  content: string,
): CommitImportResult {
  const delimiter = detectDelimiter(content);
  const rows = parseDelimited(content, delimiter);
  const [headerRow, ...dataRows] = rows as [string[], ...string[][]];
  void headerRow;

  let table;
  if (plan.appendingToExisting) {
    table = resolveTable(recordsDb, plan.tableName);
  } else {
    const fields: WorkspaceFieldInput[] = plan.columns.map((column) => ({
      name: column.fieldName,
      displayName: column.header,
      type: column.type === 'money' ? 'money' : column.type,
      ...(column.type === 'money' ? { config: { currency: 'USD' } } : {}),
    }));
    table = createTable(
      recordsDb,
      { name: plan.tableName, displayName: plan.displayName, fields },
      actor,
    );
  }

  let imported = 0;
  let skipped = 0;
  for (const row of dataRows.slice(0, MAX_ROWS)) {
    const data: Record<string, unknown> = {};
    plan.columns.forEach((column, index) => {
      const value = coerceCell(row[index] ?? '', column.type);
      if (value !== null) data[column.fieldName] = value;
    });
    if (Object.keys(data).length === 0) {
      skipped += 1;
      continue;
    }
    try {
      createRecord(recordsDb, table, actor, data as never);
      imported += 1;
    } catch {
      skipped += 1;
    }
  }

  return { tableId: table.id, imported, skipped };
}
