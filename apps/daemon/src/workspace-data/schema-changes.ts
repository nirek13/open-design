// Changing a schema that already holds data.
//
// Until now the schema was append-only: you could add a field, never rename,
// retype, or remove one. That is safe, and it is also why nobody could shape
// this system to their own business — a field named by mistake was named that
// way forever, and a column you stopped using stayed on every screen.
//
// These operations are destructive in a way `add-field` is not, so each one is
// built around the same three rules:
//
//   1. **Say what it will cost first.** `blastRadius` reports how many rows are
//      affected, how many values cannot survive a type change, and everything
//      that references the field by name — formulas, views, app scopes. A
//      person decides with that in front of them.
//   2. **Never silently discard.** A rename carries values across. A retype
//      that cannot convert a value refuses by default and only drops data when
//      the caller has explicitly accepted the loss the preview described.
//   3. **Removal is reversible.** Deleting a field marks it removed and leaves
//      the values in the record documents, so restoring it brings the data
//      back. Nothing about "nothing truly deletes" changes here.
//
// Field values live in `od_records.data_json` keyed by field name, and unique
// constraints are expression indexes over `json_extract(data_json, '$.name')`.
// So a rename is a real data migration: rewrite every document key, rebuild
// the index, then update the field row — all inside one transaction, because a
// half-renamed table is unreadable.

import {
  WORKSPACE_FIELD_TYPES,
  WORKSPACE_NAME_PATTERN,
  type FieldChangeImpact,
  type JsonValue,
  type WorkspaceField,
  type WorkspaceFieldType,
  type WorkspaceTable,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { loadTable, resolveTable } from './schema.js';
import { appendAuditEvent } from './audit.js';
import type { WorkspaceActor } from './types.js';
import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;

const RESERVED_FIELD_NAMES = new Set(['id', 'revision', 'created_at', 'updated_at', 'deleted_at']);

/** The label `createTable` would have generated for a machine name — used to
 * tell an auto-derived label from one a person chose. */
function titleCaseName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function uniqueIndexName(fieldId: string): string {
  return `odx_u_${fieldId}`;
}

function requireField(table: WorkspaceTable, fieldName: string): WorkspaceField {
  const field = table.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new WorkspaceDataError(
      'WORKSPACE_VALIDATION_FAILED',
      404,
      `table '${table.name}' has no field called '${fieldName}'`,
    );
  }
  return field;
}

// --- Type coercion --------------------------------------------------------

/** Can this value survive as `target`? Returns the converted value, or
 * `undefined` when it cannot be carried across.
 *
 * Deliberately conservative: "12 apples" does not become the number 12. A
 * conversion that guesses is how a retype quietly corrupts a column. */
export function coerceToType(value: JsonValue, target: WorkspaceFieldType): JsonValue | undefined {
  if (value === null || value === undefined) return null;

  switch (target) {
    case 'text':
      if (typeof value === 'object') return undefined;
      return String(value);
    case 'number':
    case 'money':
    case 'integer': {
      if (typeof value === 'boolean') return undefined;
      const raw = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(raw)) return undefined;
      // Money and integers must be whole; a fractional value would either be
      // rounded (silent loss) or stored illegally.
      if (target === 'integer' || target === 'money') {
        return Number.isInteger(raw) ? raw : undefined;
      }
      return raw;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(text)) return true;
      if (['false', 'no', 'n', '0'].includes(text)) return false;
      return undefined;
    }
    case 'date': {
      const text = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
    }
    case 'datetime': {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      const parsed = Date.parse(String(value));
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    case 'select':
      return typeof value === 'object' ? undefined : String(value);
    case 'link':
      // A link is a record id. Nothing else can become one, because inventing
      // a reference is worse than refusing.
      return typeof value === 'string' && value.startsWith('rec-') ? value : undefined;
    case 'json':
      return value;
    default:
      return undefined;
  }
}

// --- Blast radius ---------------------------------------------------------

interface RecordRow {
  id: string;
  data_json: string;
}

function readRecords(db: SqliteDb, tableId: string): Array<{ id: string; data: Record<string, JsonValue> }> {
  const rows = db
    .prepare('SELECT id, data_json FROM od_records WHERE table_id = ? AND deleted_at IS NULL')
    .all(tableId) as RecordRow[];
  return rows.map((row) => ({ id: row.id, data: JSON.parse(row.data_json) as Record<string, JsonValue> }));
}

/** Everything that names this field, and what a change would cost.
 *
 * The references matter as much as the row count: a field renamed without
 * updating the formula that reads it leaves a column silently computing from
 * nothing, which is worse than an error. */
export function blastRadius(
  db: SqliteDb,
  tableRef: string,
  fieldName: string,
  change: { kind: 'rename'; to: string } | { kind: 'retype'; to: WorkspaceFieldType } | { kind: 'delete' },
): FieldChangeImpact {
  const table = resolveTable(db, tableRef);
  const field = requireField(table, fieldName);
  const records = readRecords(db, table.id);

  const populated = records.filter(
    (record) => record.data[fieldName] !== null && record.data[fieldName] !== undefined && record.data[fieldName] !== '',
  );

  const losses: Array<{ recordId: string; value: string }> = [];
  if (change.kind === 'retype') {
    for (const record of populated) {
      if (coerceToType(record.data[fieldName]!, change.to) === undefined) {
        // Capped: the point is to show what kind of thing breaks, not to
        // return the whole table.
        if (losses.length < 20) {
          losses.push({ recordId: record.id, value: String(record.data[fieldName]) });
        }
      }
    }
  }

  // Anything else that refers to this field by name.
  const formulas: string[] = [];
  for (const candidate of table.fields) {
    const formula = (candidate.config as { formula?: string } | null)?.formula;
    if (typeof formula === 'string' && formula.includes(`{${fieldName}}`)) {
      formulas.push(candidate.name);
    }
  }

  const views: string[] = [];
  try {
    const viewRows = db
      .prepare('SELECT name, filters_json, sorts_json, group_by FROM od_views WHERE table_id = ?')
      .all(table.id) as Array<{ name: string; filters_json: string; sorts_json: string; group_by: string | null }>;
    for (const row of viewRows) {
      const mentions =
        row.group_by === fieldName ||
        row.filters_json.includes(`"${fieldName}"`) ||
        row.sorts_json.includes(`"${fieldName}"`);
      if (mentions) views.push(row.name);
    }
  } catch {
    // Views are a later migration; their absence is not an error here.
  }

  const uniqueValues =
    field.unique && change.kind === 'retype'
      ? new Set(populated.map((record) => String(coerceToType(record.data[fieldName]!, change.to)))).size
      : null;

  return {
    tableName: table.name,
    fieldName,
    currentType: field.type,
    recordCount: records.length,
    populatedCount: populated.length,
    valuesAtRisk: losses.length,
    sampleLosses: losses,
    referencedByFormulas: formulas,
    referencedByViews: views,
    // A unique field whose values collapse after conversion cannot be rebuilt.
    breaksUniqueness:
      uniqueValues !== null && uniqueValues < populated.length ? true : false,
    reversible: change.kind !== 'retype',
  };
}

// --- Rename ---------------------------------------------------------------

/** Rename a field, carrying every value across.
 *
 * The whole thing is one transaction. A table whose documents use the new key
 * while its field row still says the old name is unreadable by every query in
 * the system, so there is no acceptable partial state. */
export function renameField(
  db: SqliteDb,
  actor: WorkspaceActor,
  tableRef: string,
  from: string,
  to: string,
): WorkspaceTable {
  const table = resolveTable(db, tableRef);
  const field = requireField(table, from);

  const next = to.trim();
  if (!WORKSPACE_NAME_PATTERN.test(next)) {
    throw workspaceValidationError([
      { path: 'to', message: `'${next}' is not a usable field name` },
    ]);
  }
  if (RESERVED_FIELD_NAMES.has(next)) {
    throw workspaceValidationError([{ path: 'to', message: `'${next}' is reserved` }]);
  }
  if (table.fields.some((candidate) => candidate.name === next)) {
    throw new WorkspaceDataError('CONFLICT', 409, `'${next}' already exists on ${table.name}`);
  }
  if (next === from) return table;

  const apply = db.transaction(() => {
    // 1. Move the value in every document, preserving key order so a record
    //    does not visibly reshuffle in the UI after a rename.
    const records = db
      .prepare('SELECT id, data_json FROM od_records WHERE table_id = ?')
      .all(table.id) as RecordRow[];
    const update = db.prepare('UPDATE od_records SET data_json = ? WHERE id = ?');
    for (const row of records) {
      const data = JSON.parse(row.data_json) as Record<string, JsonValue>;
      if (!Object.hasOwn(data, from)) continue;
      const rebuilt: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key === from) rebuilt[next] = value;
        else rebuilt[key] = value;
      }
      update.run(JSON.stringify(rebuilt), row.id);
    }

    // 2. The unique index is an expression over the old key, so it has to be
    //    rebuilt rather than renamed.
    if (field.unique) {
      db.exec(`DROP INDEX IF EXISTS "${uniqueIndexName(field.id)}"`);
      db.exec(
        `CREATE UNIQUE INDEX "${uniqueIndexName(field.id)}"
           ON od_records(json_extract(data_json, '$.${next}'))
           WHERE table_id = '${table.id}' AND deleted_at IS NULL`,
      );
    }

    // 3. Formulas that read the old name follow it, so a rename never leaves a
    //    column computing from a field that no longer exists.
    for (const candidate of table.fields) {
      const config = candidate.config as { formula?: string } | null;
      if (typeof config?.formula !== 'string' || !config.formula.includes(`{${from}}`)) continue;
      const rewritten = config.formula.split(`{${from}}`).join(`{${next}}`);
      db.prepare('UPDATE od_fields SET config_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify({ ...config, formula: rewritten }),
        Date.now(),
        candidate.id,
      );
    }

    // 4. Views filtering, sorting, or grouping on the old name follow too.
    try {
      const viewRows = db
        .prepare('SELECT id, filters_json, sorts_json, group_by FROM od_views WHERE table_id = ?')
        .all(table.id) as Array<{ id: string; filters_json: string; sorts_json: string; group_by: string | null }>;
      for (const row of viewRows) {
        db.prepare(
          'UPDATE od_views SET filters_json = ?, sorts_json = ?, group_by = ?, updated_at = ? WHERE id = ?',
        ).run(
          row.filters_json.split(`"${from}"`).join(`"${next}"`),
          row.sorts_json.split(`"${from}"`).join(`"${next}"`),
          row.group_by === from ? next : row.group_by,
          Date.now(),
          row.id,
        );
      }
    } catch {
      // No views table yet.
    }

    // 5. Finally the field itself. A label that was auto-derived from the old
    //    machine name follows the rename, or it would sit there stale saying
    //    "Registration" over a column now called `plate`. A label someone
    //    actually chose is left alone — that is a decision, not a default.
    const autoLabel = titleCaseName(from);
    const nextLabel = field.displayName === autoLabel ? titleCaseName(next) : field.displayName;
    db.prepare('UPDATE od_fields SET name = ?, display_name = ?, updated_at = ? WHERE id = ?').run(
      next,
      nextLabel,
      Date.now(),
      field.id,
    );
    db.prepare('UPDATE od_tables SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?').run(
      Date.now(),
      table.id,
    );
  });
  apply();

  appendAuditEvent(db, {
    actor,
    op: 'field.rename',
    subjectKind: 'table',
    subjectId: table.id,
    tableId: table.id,
    summary: `renamed '${from}' to '${next}' on ${table.name}`,
  });
  return loadTable(db, table.id);
}

// --- Retype ---------------------------------------------------------------

export interface RetypeOptions {
  /** Required when the preview showed values that cannot convert. Without it
   * the change is refused, so data is never dropped by a caller who did not
   * look at what they were dropping. */
  acceptDataLoss?: boolean;
}

export function retypeField(
  db: SqliteDb,
  actor: WorkspaceActor,
  tableRef: string,
  fieldName: string,
  target: WorkspaceFieldType,
  options: RetypeOptions = {},
): WorkspaceTable {
  const table = resolveTable(db, tableRef);
  const field = requireField(table, fieldName);

  if (!WORKSPACE_FIELD_TYPES.includes(target)) {
    throw workspaceValidationError([{ path: 'type', message: `'${target}' is not a field type` }]);
  }
  if (field.type === target) return table;

  const impact = blastRadius(db, tableRef, fieldName, { kind: 'retype', to: target });
  if (impact.valuesAtRisk > 0 && !options.acceptDataLoss) {
    throw new WorkspaceDataError(
      'WORKSPACE_VALIDATION_FAILED',
      409,
      `${impact.valuesAtRisk} value(s) cannot become ${target}; re-run accepting the loss if that is what you want`,
      { impact: impact as unknown as JsonValue },
    );
  }
  if (impact.breaksUniqueness) {
    // Converting would make two rows equal under a unique constraint. The
    // index rebuild would fail anyway; refusing here explains why.
    throw new WorkspaceDataError(
      'WORKSPACE_UNIQUE_VIOLATION',
      409,
      `converting '${fieldName}' to ${target} would make previously distinct values equal`,
      { impact: impact as unknown as JsonValue },
    );
  }

  const apply = db.transaction(() => {
    const records = db
      .prepare('SELECT id, data_json FROM od_records WHERE table_id = ?')
      .all(table.id) as RecordRow[];
    const update = db.prepare('UPDATE od_records SET data_json = ? WHERE id = ?');
    for (const row of records) {
      const data = JSON.parse(row.data_json) as Record<string, JsonValue>;
      if (!Object.hasOwn(data, fieldName)) continue;
      const converted = coerceToType(data[fieldName]!, target);
      // A value that cannot convert becomes blank rather than staying in the
      // wrong type — the caller accepted this, and a mixed-type column would
      // break every reader.
      data[fieldName] = converted === undefined ? null : converted;
      update.run(JSON.stringify(data), row.id);
    }

    if (field.unique) {
      db.exec(`DROP INDEX IF EXISTS "${uniqueIndexName(field.id)}"`);
      db.exec(
        `CREATE UNIQUE INDEX "${uniqueIndexName(field.id)}"
           ON od_records(json_extract(data_json, '$.${fieldName}'))
           WHERE table_id = '${table.id}' AND deleted_at IS NULL`,
      );
    }

    db.prepare('UPDATE od_fields SET type = ?, updated_at = ? WHERE id = ?').run(
      target,
      Date.now(),
      field.id,
    );
    db.prepare('UPDATE od_tables SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?').run(
      Date.now(),
      table.id,
    );
  });
  apply();

  appendAuditEvent(db, {
    actor,
    op: 'field.retype',
    subjectKind: 'table',
    subjectId: table.id,
    tableId: table.id,
    summary: `changed '${fieldName}' on ${table.name} from ${field.type} to ${target}`,
  });
  return loadTable(db, table.id);
}

// --- Remove and restore ---------------------------------------------------

/** Take a field off the table without destroying what it held.
 *
 * The field row is marked removed and the values stay in the record documents.
 * That is what makes this undoable, and it matches the promise the rest of the
 * data plane makes: nothing truly deletes. */
export function removeField(
  db: SqliteDb,
  actor: WorkspaceActor,
  tableRef: string,
  fieldName: string,
): WorkspaceTable {
  const table = resolveTable(db, tableRef);
  const field = requireField(table, fieldName);

  const apply = db.transaction(() => {
    // The unique index has to go: a removed field must not keep rejecting
    // writes to a column nobody can see.
    if (field.unique) db.exec(`DROP INDEX IF EXISTS "${uniqueIndexName(field.id)}"`);
    db.prepare("UPDATE od_fields SET status = 'removed', updated_at = ? WHERE id = ?").run(
      Date.now(),
      field.id,
    );
    db.prepare('UPDATE od_tables SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?').run(
      Date.now(),
      table.id,
    );
  });
  apply();

  appendAuditEvent(db, {
    actor,
    op: 'field.remove',
    subjectKind: 'table',
    subjectId: table.id,
    tableId: table.id,
    summary: `removed '${fieldName}' from ${table.name}; its values are kept`,
  });
  return loadTable(db, table.id);
}

export function restoreField(
  db: SqliteDb,
  actor: WorkspaceActor,
  tableRef: string,
  fieldName: string,
): WorkspaceTable {
  const table = resolveTable(db, tableRef);
  const row = db
    .prepare(
      "SELECT id, unique_constraint AS uniq FROM od_fields WHERE table_id = ? AND name = ? AND status = 'removed'",
    )
    .get(table.id, fieldName) as { id: string; uniq: number } | undefined;
  if (!row) {
    throw new WorkspaceDataError(
      'WORKSPACE_VALIDATION_FAILED',
      404,
      `'${fieldName}' is not a removed field on ${table.name}`,
    );
  }
  if (table.fields.some((candidate) => candidate.name === fieldName)) {
    throw new WorkspaceDataError(
      'CONFLICT',
      409,
      `'${fieldName}' exists again on ${table.name}; rename it before restoring the old one`,
    );
  }

  const apply = db.transaction(() => {
    db.prepare("UPDATE od_fields SET status = 'active', updated_at = ? WHERE id = ?").run(
      Date.now(),
      row.id,
    );
    if (row.uniq === 1) {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${uniqueIndexName(row.id)}"
           ON od_records(json_extract(data_json, '$.${fieldName}'))
           WHERE table_id = '${table.id}' AND deleted_at IS NULL`,
      );
    }
    db.prepare('UPDATE od_tables SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?').run(
      Date.now(),
      table.id,
    );
  });
  apply();

  appendAuditEvent(db, {
    actor,
    op: 'field.restore',
    subjectKind: 'table',
    subjectId: table.id,
    tableId: table.id,
    summary: `restored '${fieldName}' on ${table.name} with its values`,
  });
  return loadTable(db, table.id);
}

// --- Config -----------------------------------------------------------------

/** Change a field's presentation and constraints: label, select options,
 * required, and formula. Type and name have their own operations because they
 * move data; these do not. */
export function updateFieldConfig(
  db: SqliteDb,
  actor: WorkspaceActor,
  tableRef: string,
  fieldName: string,
  patch: { displayName?: string; required?: boolean; options?: string[]; formula?: string | null },
): WorkspaceTable {
  const table = resolveTable(db, tableRef);
  const field = requireField(table, fieldName);
  const config = { ...((field.config as Record<string, unknown> | null) ?? {}) };

  if (patch.options !== undefined) {
    if (field.type !== 'select') {
      throw workspaceValidationError([
        { path: 'options', message: `'${fieldName}' is not a select field` },
      ]);
    }
    const options = patch.options.map((option) => String(option).trim()).filter(Boolean);
    if (options.length === 0) {
      throw workspaceValidationError([
        { path: 'options', message: 'a select field needs at least one option' },
      ]);
    }
    // Removing an option that rows still use would make those rows invalid on
    // their next save, which is a failure they did not cause.
    const inUse = new Set(
      readRecords(db, table.id)
        .map((record) => record.data[fieldName])
        .filter((value): value is string => typeof value === 'string' && value !== ''),
    );
    const orphaned = [...inUse].filter((value) => !options.includes(value));
    if (orphaned.length > 0) {
      throw new WorkspaceDataError(
        'WORKSPACE_VALIDATION_FAILED',
        409,
        `${orphaned.join(', ')} ${orphaned.length === 1 ? 'is' : 'are'} still in use; change those rows first`,
        { orphaned },
      );
    }
    config.options = options;
  }

  if (patch.formula !== undefined) {
    if (patch.formula === null) delete config.formula;
    else config.formula = patch.formula;
  }

  const sets: string[] = ['config_json = ?', 'updated_at = ?'];
  const params: unknown[] = [JSON.stringify(config), Date.now()];

  if (patch.displayName !== undefined) {
    const label = patch.displayName.trim();
    if (!label) throw workspaceValidationError([{ path: 'displayName', message: 'a label is required' }]);
    sets.unshift('display_name = ?');
    params.unshift(label);
  }
  if (patch.required !== undefined) {
    if (patch.required) {
      // Making a field required while rows are missing it would make every one
      // of those rows unsaveable.
      const blanks = readRecords(db, table.id).filter(
        (record) => record.data[fieldName] === null || record.data[fieldName] === undefined || record.data[fieldName] === '',
      );
      if (blanks.length > 0) {
        throw new WorkspaceDataError(
          'WORKSPACE_VALIDATION_FAILED',
          409,
          `${blanks.length} row(s) have no '${fieldName}'; fill them in before making it required`,
          { blankCount: blanks.length },
        );
      }
    }
    sets.push('required = ?');
    params.push(patch.required ? 1 : 0);
  }

  params.push(field.id);
  db.prepare(`UPDATE od_fields SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]));

  appendAuditEvent(db, {
    actor,
    op: 'field.update',
    subjectKind: 'table',
    subjectId: table.id,
    tableId: table.id,
    summary: `updated '${fieldName}' on ${table.name}`,
  });
  return loadTable(db, table.id);
}

/** Put fields in a chosen order. Purely presentational — position drives the
 * column order everywhere, so this is how someone makes a table read the way
 * they think. */
export function reorderFields(
  db: SqliteDb,
  actor: WorkspaceActor,
  tableRef: string,
  order: string[],
): WorkspaceTable {
  const table = resolveTable(db, tableRef);
  const known = new Set(table.fields.map((field) => field.name));
  for (const name of order) {
    if (!known.has(name)) {
      throw workspaceValidationError([
        { path: 'order', message: `'${name}' is not a field on ${table.name}` },
      ]);
    }
  }

  const apply = db.transaction(() => {
    const update = db.prepare('UPDATE od_fields SET position = ?, updated_at = ? WHERE id = ?');
    // Named fields first in the order given; anything not mentioned keeps its
    // relative place after them, so a partial order is still valid.
    const remaining = table.fields.filter((field) => !order.includes(field.name));
    const sequence = [
      ...order.map((name) => table.fields.find((field) => field.name === name)!),
      ...remaining,
    ];
    sequence.forEach((field, index) => update.run(index, Date.now(), field.id));
  });
  apply();

  appendAuditEvent(db, {
    actor,
    op: 'field.reorder',
    subjectKind: 'table',
    subjectId: table.id,
    tableId: table.id,
    summary: `reordered fields on ${table.name}`,
  });
  return loadTable(db, table.id);
}
