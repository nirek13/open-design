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
// embedded newlines, doubled quotes, a UTF-8 BOM on open-data dumps — are
// exactly the ones a naive split gets wrong and a library would hide.

import type {
  ImportPlan,
  ImportPlanColumn,
  JsonValue,
  WorkspaceFieldInput,
  WorkspaceRecord,
  WorkspaceTable,
} from '@open-design/contracts';
import { WORKSPACE_NAME_PATTERN } from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import { queryRecords } from './query.js';
import { createRecord, softDeleteRecord, updateRecord } from './records.js';
import { createTable, listTables, resolveTable } from './schema.js';
import type { WorkspaceActor } from './types.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

const MAX_ROWS = 5000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const MONEY_PATTERN = /^-?[$£€]?\s?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^-?[$£€]?\s?\d+(\.\d{1,2})?$/;
const INT_PATTERN = /^-?\d+$/;
const NUMBER_PATTERN = /^-?\d*\.?\d+$/;
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', 'y', 'n']);
const LANG_TAG = /^(eng|fra|en|fr)$/i;
const IDENTITY_HEADER =
  /(^|[^a-z])(uuid|guid|sku)([^a-z]|$)|reference\s*number|referencenumber|numero.?reference|(?:^|_)(id|code)(?:_|$)/i;

/** Parse delimited text into rows. Handles quoted fields containing the
 * delimiter, embedded newlines, doubled quotes as an escaped quote, and a
 * leading UTF-8 BOM from government / Excel exports. */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < src.length; index += 1) {
    const char = src[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (src[index + 1] === '"') {
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
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'));
  const counts = [',', '\t', ';', '|'].map((candidate) => ({
    candidate,
    count: firstLine.split(candidate).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0]!.count > 0 ? counts[0]!.candidate : ',';
}

/** CanadaBuys-style bilingual headers: EnglishCamel-FrenchCamel[-eng|fra].
 * Plain hyphenated names like `customers-export` stay intact. */
export function preferEnglishSegment(header: string): string {
  const trimmed = header.replace(/^\uFEFF/, '').trim();
  const rawParts = trimmed.split('-');
  const hadLang = LANG_TAG.test(rawParts[rawParts.length - 1] ?? '');
  const parts = rawParts.filter((part) => !LANG_TAG.test(part));
  const identifier = (part: string) => /^[A-Za-z][A-Za-z0-9]*$/.test(part);
  const camel = (part: string) => /[a-z][A-Z]/.test(part) || /[A-Z][a-z]+[A-Z]/.test(part);
  if (parts.length >= 2 && identifier(parts[0]!) && identifier(parts[1]!)) {
    if (hadLang || camel(parts[0]!) || camel(parts[1]!)) return parts[0]!;
  }
  return parts.join('-') || trimmed;
}

export function displayHeader(header: string, fallbackIndex = 0): string {
  const trimmed = header.replace(/^\uFEFF/, '').trim();
  const rawParts = trimmed.split('-');
  const lang = LANG_TAG.test(rawParts[rawParts.length - 1] ?? '')
    ? rawParts[rawParts.length - 1]!.toLowerCase()
    : '';
  const parts = rawParts.filter((part) => !LANG_TAG.test(part));
  let source = preferEnglishSegment(header);
  if ((lang === 'fra' || lang === 'fr') && parts[1] && /^[A-Za-z][A-Za-z0-9]*$/.test(parts[1])) {
    source = parts[1];
  }
  const spaced = source.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  const pretty = spaced.replace(/\s+/g, ' ').trim();
  if (!pretty) return `Column ${fallbackIndex + 1}`;
  const label = pretty.charAt(0).toUpperCase() + pretty.slice(1);
  if (lang === 'eng' || lang === 'en') return `${label} (English)`;
  if (lang === 'fra' || lang === 'fr') return `${label} (French)`;
  return label;
}

function languageSuffix(header: string): 'eng' | 'fra' | '' {
  const last = header.replace(/^\uFEFF/, '').trim().split('-').pop() ?? '';
  if (!LANG_TAG.test(last)) return '';
  const lower = last.toLowerCase();
  return lower === 'en' || lower === 'eng' ? 'eng' : 'fra';
}

export function toFieldName(header: string, taken: Set<string>): string {
  const english = preferEnglishSegment(header);
  const lang = languageSuffix(header);
  let base = english
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (lang && !base.endsWith(`_${lang}`)) base = `${base}_${lang}`.slice(0, 60);
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

function tableNameFromFile(fileName: string | undefined, explicit: string | undefined): string {
  if (explicit?.trim()) return toFieldName(explicit.trim(), new Set());
  const base = (fileName ?? 'imported_data').replace(/\.[^.]+$/, '');
  return toFieldName(preferEnglishSegment(base) || base, new Set());
}

function tableDisplayName(fileName: string | undefined, tableName: string): string {
  const base = (fileName ?? '').replace(/\.[^.]+$/, '');
  if (!base) return tableName;
  return displayHeader(base);
}

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

  const dateLike = filled.filter((value) => DATE_PATTERN.test(value) || DATETIME_PATTERN.test(value));
  if (dateLike.length === filled.length) {
    if (filled.some((value) => DATETIME_PATTERN.test(value))) {
      return { type: 'datetime', reason: 'every value is an ISO date or datetime' };
    }
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

function looksLikeIdentity(header: string, fieldName: string): boolean {
  return IDENTITY_HEADER.test(`${header} ${fieldName}`);
}

function uniqueValues(values: string[]): boolean {
  const filled = values.map((value) => value.trim()).filter((value) => value !== '');
  if (filled.length < 2) return false;
  return new Set(filled).size === filled.length;
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
    case 'datetime': {
      const iso = DATE_PATTERN.test(value) ? `${value}T00:00:00Z` : value;
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? null : parsed;
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
  /** Public URL this content was fetched from. */
  sourceUrl?: string;
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
    const fieldName = toFieldName(header || `column_${index + 1}`, taken);
    return {
      header: displayHeader(header, index),
      fieldName,
      type: guess.type,
      reason: guess.reason,
      sample: values.filter((value) => value.trim() !== '').slice(0, 3),
    };
  });

  const uniqueIndex = columns.findIndex((column, index) => {
    if (column.type === 'json' || column.type === 'boolean') return false;
    if (!looksLikeIdentity(headerRow[index] ?? column.header, column.fieldName)) return false;
    const values = dataRows.map((row) => row[index] ?? '');
    return uniqueValues(values);
  });
  if (uniqueIndex >= 0) {
    const column = columns[uniqueIndex]!;
    column.unique = true;
    column.reason = `${column.reason}; unique key for refreshes`;
  }

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

  const derived = tableNameFromFile(input.fileName, input.tableName);
  const existing = listTables(recordsDb).some((table) => table.name === derived);

  return {
    tableName: derived,
    displayName: tableDisplayName(input.fileName, derived),
    appendingToExisting: existing,
    columns,
    rowCount: Math.min(usable.length, MAX_ROWS),
    skipped,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl.trim() } : {}),
  };
}

export interface CommitImportResult {
  tableId: string;
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
}

function rowData(plan: ImportPlan, row: string[]): Record<string, JsonValue> {
  const data: Record<string, JsonValue> = {};
  plan.columns.forEach((column, index) => {
    const value = coerceCell(row[index] ?? '', column.type);
    if (value !== null && value !== undefined) data[column.fieldName] = value as JsonValue;
  });
  return data;
}

function loadLiveRecords(recordsDb: RecordsDb, table: WorkspaceTable): WorkspaceRecord[] {
  const all: WorkspaceRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = queryRecords(recordsDb, table, {
      limit: 200,
      sort: { field: 'id', direction: 'asc' },
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.records);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

function uniqueFieldName(table: WorkspaceTable, plan: ImportPlan): string | null {
  const fromTable = table.fields.find((field) => field.status === 'active' && field.unique);
  if (fromTable) return fromTable.name;
  const fromPlan = plan.columns.find((column) => column.unique);
  return fromPlan?.fieldName ?? null;
}

function dataUnchanged(existing: Record<string, JsonValue>, next: Record<string, JsonValue>): boolean {
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const key of keys) {
    if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(next[key] ?? null)) return false;
  }
  return true;
}

/** Create the table (if new) and write the rows. Rows that fail validation
 * are counted and skipped rather than aborting the whole import — one bad
 * line in a thousand should not cost the other nine hundred and ninety-nine.
 *
 * A public-link refresh with a unique key updates matching rows and removes
 * rows that disappeared from the feed. A snapshot without a unique key
 * replaces the live set. A file drop onto an existing table still appends. */
export function commitImport(
  recordsDb: RecordsDb,
  actor: WorkspaceActor,
  plan: ImportPlan,
  content: string,
): CommitImportResult {
  const delimiter = detectDelimiter(content);
  const rows = parseDelimited(content, delimiter);
  const [, ...dataRows] = rows as [string[], ...string[][]];

  let table;
  if (plan.appendingToExisting) {
    table = resolveTable(recordsDb, plan.tableName);
  } else {
    const fields: WorkspaceFieldInput[] = plan.columns.map((column) => ({
      name: column.fieldName,
      displayName: column.header,
      type: column.type === 'money' ? 'money' : column.type,
      ...(column.unique ? { unique: true } : {}),
      ...(column.type === 'money' ? { config: { currency: 'USD' } } : {}),
    }));
    table = createTable(
      recordsDb,
      {
        name: plan.tableName,
        displayName: plan.displayName,
        ...(plan.sourceUrl ? { description: `Imported from ${plan.sourceUrl}` } : {}),
        fields,
      },
      actor,
    );
  }

  const incoming = dataRows.slice(0, MAX_ROWS).map((row) => rowData(plan, row)).filter((data) => Object.keys(data).length > 0);
  const uniqueField = uniqueFieldName(table, plan);
  const refresh = Boolean(plan.sourceUrl) && plan.appendingToExisting;

  let imported = 0;
  let updated = 0;
  let removed = 0;
  let skipped = Math.max(0, dataRows.length - MAX_ROWS);
  skipped += dataRows.slice(0, MAX_ROWS).length - incoming.length;

  if (refresh && uniqueField) {
    const live = loadLiveRecords(recordsDb, table);
    const byKey = new Map<string, WorkspaceRecord>();
    for (const record of live) {
      const key = record.data[uniqueField];
      if (key == null) continue;
      byKey.set(String(key), record);
    }
    const seen = new Set<string>();
    for (const data of incoming) {
      const rawKey = data[uniqueField];
      if (rawKey == null) {
        skipped += 1;
        continue;
      }
      const key = String(rawKey);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const existing = byKey.get(key);
      if (!existing) {
        try {
          createRecord(recordsDb, table, actor, data);
          imported += 1;
        } catch {
          skipped += 1;
        }
        continue;
      }
      if (dataUnchanged(existing.data, data)) continue;
      try {
        updateRecord(recordsDb, table, actor, existing.id, data);
        updated += 1;
      } catch {
        skipped += 1;
      }
    }
    for (const [key, record] of byKey) {
      if (seen.has(key)) continue;
      try {
        softDeleteRecord(recordsDb, table, actor, record.id);
        removed += 1;
      } catch {
        skipped += 1;
      }
    }
    return { tableId: table.id, imported, updated, removed, skipped };
  }

  if (refresh && !uniqueField) {
    for (const record of loadLiveRecords(recordsDb, table)) {
      try {
        softDeleteRecord(recordsDb, table, actor, record.id);
        removed += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  for (const data of incoming) {
    try {
      createRecord(recordsDb, table, actor, data);
      imported += 1;
    } catch {
      skipped += 1;
    }
  }

  return { tableId: table.id, imported, updated, removed, skipped };
}
