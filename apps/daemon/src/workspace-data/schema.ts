// Table/field schema management and record-data validation for the Workspace
// Database. The schema is real database discipline (required fields, types,
// uniqueness, link integrity) enforced at the daemon chokepoint — never
// exposed as SQL to callers.
//
// Uniqueness is enforced by the engine, not by read-then-write checks: each
// unique field gets a partial UNIQUE expression index over
// json_extract(data_json, '$.<name>') scoped to the table and to non-deleted
// rows. Field/table machine names match WORKSPACE_NAME_PATTERN (snake_case),
// which is what makes the '$.<name>' interpolation safe.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  WORKSPACE_FIELD_TYPES,
  WORKSPACE_NAME_PATTERN,
  WORKSPACE_RECORD_BOUNDED_JSON_CONSTRAINTS,
  type ApiValidationIssue,
  type BoundedJsonConstraints,
  type CreateWorkspaceTableRequest,
  type JsonValue,
  type WorkspaceField,
  type WorkspaceFieldConfig,
  type WorkspaceFieldInput,
  type WorkspaceFieldType,
  type WorkspaceTable,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { appendAuditEvent } from './audit.js';
import { parseFormula } from './formula.js';
import type { WorkspaceActor } from './types.js';

type SqliteDb = Database.Database;

/** Daemon-owned record attributes; never valid as user field names. */
const RESERVED_FIELD_NAMES = new Set([
  'id',
  'revision',
  'created_at',
  'updated_at',
  'deleted_at',
]);

/** Types where a UNIQUE constraint is meaningful. */
const UNIQUEABLE_TYPES = new Set<WorkspaceFieldType>([
  'text',
  'number',
  'integer',
  'date',
  'datetime',
  'select',
  'money',
  'link',
]);

const FIELD_TYPE_SET = new Set<string>(WORKSPACE_FIELD_TYPES);

const TABLE_COLS = `
  id, name, display_name AS displayName, description, status,
  schema_version AS schemaVersion, protection, created_by AS createdBy,
  created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt,
  public_write AS publicWrite
`;

const FIELD_COLS = `
  id, table_id AS tableId, name, display_name AS displayName, type,
  required, unique_constraint AS uniqueConstraint, config_json AS configJson,
  position, status, created_at AS createdAt, updated_at AS updatedAt
`;

function normalizeFieldRow(row: Record<string, any>): WorkspaceField {
  const { uniqueConstraint, configJson, ...rest } = row;
  let config: WorkspaceFieldConfig | null = null;
  if (typeof configJson === 'string') {
    try {
      config = JSON.parse(configJson);
    } catch {
      config = null;
    }
  }
  return {
    ...(rest as Omit<WorkspaceField, 'required' | 'unique' | 'config'>),
    required: row.required === 1 || row.required === true,
    unique: uniqueConstraint === 1 || uniqueConstraint === true,
    config,
  };
}

function normalizeTableRow(row: Record<string, any>, fields: WorkspaceField[]): WorkspaceTable {
  const { publicWrite, ...rest } = row;
  return {
    ...(rest as Omit<WorkspaceTable, 'fields' | 'publicWrite'>),
    publicWrite: publicWrite === 1 || publicWrite === true,
    fields,
  };
}

export function uniqueIndexNameForField(fieldId: string): string {
  return `odx_u_${fieldId}`;
}

function createUniqueIndexForField(db: SqliteDb, tableId: string, field: { id: string; name: string }): void {
  // tableId/fieldId are daemon-generated uuid slugs and field.name matched
  // WORKSPACE_NAME_PATTERN, so interpolation here cannot escape the literal.
  db.exec(
    `CREATE UNIQUE INDEX "${uniqueIndexNameForField(field.id)}"
       ON od_records(json_extract(data_json, '$.${field.name}'))
       WHERE table_id = '${tableId}' AND deleted_at IS NULL`,
  );
}

/** Map a SQLite UNIQUE-violation message back to the offending field. */
export function fieldForUniqueViolation(table: WorkspaceTable, message: string): WorkspaceField | null {
  for (const field of table.fields) {
    if (message.includes(uniqueIndexNameForField(field.id))) return field;
  }
  return null;
}

function checkBoundedJson(
  value: JsonValue,
  constraints: BoundedJsonConstraints,
  path: string,
  issues: ApiValidationIssue[],
  depth: number,
): void {
  if (depth > constraints.maxDepth) {
    issues.push({ path, message: `exceeds max nesting depth ${constraints.maxDepth}` });
    return;
  }
  if (typeof value === 'string') {
    if (value.length > constraints.maxStringLength) {
      issues.push({ path, message: `string exceeds ${constraints.maxStringLength} characters` });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > constraints.maxArrayLength) {
      issues.push({ path, message: `array exceeds ${constraints.maxArrayLength} items` });
      return;
    }
    value.forEach((item, index) => {
      checkBoundedJson(item, constraints, `${path}[${index}]`, issues, depth + 1);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > constraints.maxObjectKeys) {
      issues.push({ path, message: `object exceeds ${constraints.maxObjectKeys} keys` });
      return;
    }
    for (const key of keys) {
      const child = value[key];
      if (child !== undefined) {
        checkBoundedJson(child, constraints, `${path}.${key}`, issues, depth + 1);
      }
    }
  }
}

function validateFieldConfig(
  input: WorkspaceFieldInput,
  path: string,
  issues: ApiValidationIssue[],
  db: SqliteDb,
): WorkspaceFieldConfig | null {
  const validated = validateTypeConfig(input, path, issues, db);
  const carried: Record<string, unknown> = {};

  // `role` is type-independent and must survive validation: automatic
  // accounting finds the total, the customer, and the status by role, so
  // dropping it here would silently disconnect the books from the documents.
  const role = input.config?.role;
  if (typeof role === 'string' && role) carried.role = role;

  // `formula` likewise. It is checked here rather than trusted: a formula is
  // user input, and one that cannot parse should be refused when the field is
  // created, not silently stored and blanked on every read.
  const formula = (input.config as { formula?: unknown } | undefined)?.formula;
  if (typeof formula === 'string' && formula.trim()) {
    try {
      parseFormula(formula);
      carried.formula = formula;
    } catch (err) {
      issues.push({
        path: `${path}.config.formula`,
        message: err instanceof Error ? err.message : 'formula could not be read',
      });
      return null;
    }
  }

  return Object.keys(carried).length > 0 ? { ...(validated ?? {}), ...carried } : validated;
}

function validateTypeConfig(
  input: WorkspaceFieldInput,
  path: string,
  issues: ApiValidationIssue[],
  db: SqliteDb,
): WorkspaceFieldConfig | null {
  const config = input.config ?? {};
  switch (input.type) {
    case 'select': {
      const options = config.options;
      if (!Array.isArray(options) || options.length === 0 || options.some((o) => typeof o !== 'string' || !o.trim())) {
        issues.push({ path: `${path}.config.options`, message: 'select fields require a non-empty list of string options' });
        return null;
      }
      return { options: options.map((o) => o.trim()) };
    }
    case 'link': {
      const targetTableId = config.targetTableId;
      if (typeof targetTableId !== 'string' || !targetTableId) {
        issues.push({ path: `${path}.config.targetTableId`, message: 'link fields require config.targetTableId' });
        return null;
      }
      const target = db
        .prepare("SELECT id FROM od_tables WHERE id = ? AND status = 'active'")
        .get(targetTableId) as { id: string } | undefined;
      if (!target) {
        issues.push({ path: `${path}.config.targetTableId`, message: `target table ${targetTableId} not found` });
        return null;
      }
      const onDelete = config.onDelete ?? 'restrict';
      if (onDelete !== 'restrict' && onDelete !== 'clear') {
        issues.push({ path: `${path}.config.onDelete`, message: "onDelete must be 'restrict' or 'clear'" });
        return null;
      }
      return { targetTableId, onDelete };
    }
    case 'money': {
      const currency = config.currency ?? 'USD';
      if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
        issues.push({ path: `${path}.config.currency`, message: 'currency must be an ISO 4217 code' });
        return null;
      }
      return { currency };
    }
    case 'number':
    case 'integer': {
      const out: WorkspaceFieldConfig = {};
      if (config.min !== undefined) {
        if (typeof config.min !== 'number' || !Number.isFinite(config.min)) {
          issues.push({ path: `${path}.config.min`, message: 'min must be a finite number' });
          return null;
        }
        out.min = config.min;
      }
      if (config.max !== undefined) {
        if (typeof config.max !== 'number' || !Number.isFinite(config.max)) {
          issues.push({ path: `${path}.config.max`, message: 'max must be a finite number' });
          return null;
        }
        out.max = config.max;
      }
      return Object.keys(out).length ? out : null;
    }
    default:
      return null;
  }
}

export function createTable(
  db: SqliteDb,
  input: CreateWorkspaceTableRequest,
  actor: WorkspaceActor,
): WorkspaceTable {
  const issues: ApiValidationIssue[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    issues.push({ path: 'name', message: 'table name must be a snake_case identifier (max 64 chars)' });
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    issues.push({ path: 'fields', message: 'at least one field is required' });
  }
  const fieldInputs = Array.isArray(input.fields) ? input.fields : [];
  const seenNames = new Set<string>();
  const preparedFields: Array<{
    input: WorkspaceFieldInput;
    config: WorkspaceFieldConfig | null;
  }> = [];
  fieldInputs.forEach((field, index) => {
    const path = `fields[${index}]`;
    const fieldName = typeof field?.name === 'string' ? field.name.trim() : '';
    if (!WORKSPACE_NAME_PATTERN.test(fieldName)) {
      issues.push({ path: `${path}.name`, message: 'field name must be a snake_case identifier (max 64 chars)' });
      return;
    }
    if (RESERVED_FIELD_NAMES.has(fieldName)) {
      issues.push({ path: `${path}.name`, message: `'${fieldName}' is a reserved field name` });
      return;
    }
    if (seenNames.has(fieldName)) {
      issues.push({ path: `${path}.name`, message: `duplicate field name '${fieldName}'` });
      return;
    }
    seenNames.add(fieldName);
    if (!FIELD_TYPE_SET.has(field.type)) {
      issues.push({ path: `${path}.type`, message: `type must be one of: ${WORKSPACE_FIELD_TYPES.join(', ')}` });
      return;
    }
    if (field.unique && !UNIQUEABLE_TYPES.has(field.type)) {
      issues.push({ path: `${path}.unique`, message: `unique is not supported for ${field.type} fields` });
      return;
    }
    const config = validateFieldConfig(field, path, issues, db);
    preparedFields.push({ input: { ...field, name: fieldName }, config });
  });
  if (issues.length) throw workspaceValidationError(issues);

  const existing = db
    .prepare("SELECT id FROM od_tables WHERE name = ? AND status = 'active'")
    .get(name) as { id: string } | undefined;
  if (existing) {
    throw new WorkspaceDataError('WORKSPACE_TABLE_EXISTS', 409, `table '${name}' already exists`);
  }

  const now = Date.now();
  const tableId = `tbl-${randomUUID()}`;
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO od_tables
         (id, name, display_name, description, status, schema_version, protection,
          created_by, created_at, updated_at, public_write)
       VALUES (?, ?, ?, ?, 'active', 1, 'open', ?, ?, ?, 0)`,
    ).run(
      tableId,
      name,
      input.displayName?.trim() || name,
      input.description?.trim() || null,
      actor.memberId ?? actor.kind,
      now,
      now,
    );
    preparedFields.forEach(({ input: field, config }, position) => {
      const fieldId = `fld-${randomUUID()}`;
      db.prepare(
        `INSERT INTO od_fields
           (id, table_id, name, display_name, type, required, unique_constraint,
            config_json, position, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        fieldId,
        tableId,
        field.name,
        field.displayName?.trim() || field.name,
        field.type,
        field.required ? 1 : 0,
        field.unique ? 1 : 0,
        config ? JSON.stringify(config) : null,
        position,
        now,
        now,
      );
      if (field.unique) {
        createUniqueIndexForField(db, tableId, { id: fieldId, name: field.name });
      }
    });
    appendAuditEvent(db, {
      actor,
      op: 'table.create',
      subjectKind: 'table',
      subjectId: tableId,
      tableId,
      summary: `created table '${name}' with ${preparedFields.length} fields`,
    });
  });
  insert();
  return loadTable(db, tableId);
}

export function loadTable(db: SqliteDb, tableId: string): WorkspaceTable {
  const row = db.prepare(`SELECT ${TABLE_COLS} FROM od_tables WHERE id = ?`).get(tableId) as
    | Record<string, any>
    | undefined;
  if (!row) {
    throw new WorkspaceDataError('WORKSPACE_TABLE_NOT_FOUND', 404, `table ${tableId} not found`);
  }
  const fields = (
    db
      .prepare(`SELECT ${FIELD_COLS} FROM od_fields WHERE table_id = ? AND status = 'active' ORDER BY position ASC`)
      .all(tableId) as Array<Record<string, any>>
  ).map(normalizeFieldRow);
  return normalizeTableRow(row, fields);
}

export function loadTableByName(db: SqliteDb, name: string): WorkspaceTable {
  const row = db
    .prepare(`SELECT ${TABLE_COLS} FROM od_tables WHERE name = ? AND status = 'active'`)
    .get(name) as Record<string, any> | undefined;
  if (!row) {
    throw new WorkspaceDataError('WORKSPACE_TABLE_NOT_FOUND', 404, `table '${name}' not found`);
  }
  return loadTable(db, row.id);
}

export function listTables(db: SqliteDb, options: { includeArchived?: boolean } = {}): WorkspaceTable[] {
  const whereSql = options.includeArchived ? '' : "WHERE status = 'active'";
  const rows = db
    .prepare(`SELECT ${TABLE_COLS} FROM od_tables ${whereSql} ORDER BY created_at ASC`)
    .all() as Array<Record<string, any>>;
  return rows.map((row) => loadTable(db, row.id));
}

/** Resolve a table by id or machine name — the CLI and agent tools accept
 * either, so humans can say `employees` and tools can pin `tbl-<uuid>`. */
export function resolveTable(db: SqliteDb, ref: string): WorkspaceTable {
  // Callers include agent-authored payloads, so a missing or non-string ref is
  // an expected input — answer it as a validation failure rather than letting
  // a TypeError surface as an internal error.
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw workspaceValidationError([
      { path: 'tableRef', message: 'a table name or id is required' },
    ]);
  }
  if (ref.startsWith('tbl-')) return loadTable(db, ref);
  return loadTableByName(db, ref);
}

/** Open or close a table to anonymous appends. Existing rows stay private. */
export function setTablePublicWrite(
  db: SqliteDb,
  table: WorkspaceTable,
  actor: WorkspaceActor,
  publicWrite: boolean,
): WorkspaceTable {
  if (table.status !== 'active') {
    throw new WorkspaceDataError('WORKSPACE_TABLE_NOT_FOUND', 404, `table ${table.id} is archived`);
  }
  const now = Date.now();
  db.prepare(`UPDATE od_tables SET public_write = ?, updated_at = ? WHERE id = ?`).run(
    publicWrite ? 1 : 0,
    now,
    table.id,
  );
  appendAuditEvent(db, {
    actor,
    op: publicWrite ? 'table.public_write.enable' : 'table.public_write.disable',
    subjectKind: 'table',
    subjectId: table.id,
    tableId: table.id,
    summary: publicWrite
      ? `opened table '${table.name}' to public submissions`
      : `closed table '${table.name}' to public submissions`,
  });
  return loadTable(db, table.id);
}

function typeIssueFor(
  field: WorkspaceField,
  value: JsonValue,
  path: string,
): ApiValidationIssue | null {
  const config = field.config ?? {};
  switch (field.type) {
    case 'text':
      return typeof value === 'string' ? null : { path, message: 'expected a string' };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { path, message: 'expected a finite number' };
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return { path, message: 'expected an integer' };
      break;
    case 'boolean':
      return typeof value === 'boolean' ? null : { path, message: 'expected a boolean' };
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        return { path, message: 'expected a YYYY-MM-DD date string' };
      }
      return null;
    case 'datetime':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return { path, message: 'expected a Unix epoch-milliseconds integer' };
      }
      return null;
    case 'select':
      if (typeof value !== 'string' || !(config.options ?? []).includes(value)) {
        return { path, message: `expected one of: ${(config.options ?? []).join(', ')}` };
      }
      return null;
    case 'money':
      // Money is always integer minor units; floats are rejected so no write
      // path can introduce fractional-cent drift.
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { path, message: 'expected integer minor units (e.g. cents)' };
      }
      break;
    case 'link':
      return typeof value === 'string' && value.length > 0 ? null : { path, message: 'expected a record id' };
    case 'json':
      return null;
  }
  if (typeof value === 'number') {
    if (config.min !== undefined && value < config.min) return { path, message: `must be >= ${config.min}` };
    if (config.max !== undefined && value > config.max) return { path, message: `must be <= ${config.max}` };
  }
  return null;
}

/** Validate a full record payload against the table schema. `data` must be
 * the complete post-merge document (updates merge before validating), so
 * required-ness is always checked against the final shape. */
export function validateRecordData(
  table: WorkspaceTable,
  data: Record<string, JsonValue>,
): void {
  const issues: ApiValidationIssue[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw workspaceValidationError([{ path: 'data', message: 'data must be an object' }]);
  }
  checkBoundedJson(data, WORKSPACE_RECORD_BOUNDED_JSON_CONSTRAINTS, 'data', issues, 1);
  const fieldsByName = new Map(table.fields.map((field) => [field.name, field]));
  for (const key of Object.keys(data)) {
    if (!fieldsByName.has(key)) {
      issues.push({ path: `data.${key}`, message: `unknown field '${key}'` });
    }
  }
  for (const field of table.fields) {
    const value = data[field.name];
    if (value === undefined || value === null) {
      if (field.required) {
        issues.push({ path: `data.${field.name}`, message: 'required field is missing' });
      }
      continue;
    }
    const issue = typeIssueFor(field, value, `data.${field.name}`);
    if (issue) issues.push(issue);
  }
  if (issues.length) throw workspaceValidationError(issues);
}
