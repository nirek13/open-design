// Packs an organization wrote itself.
//
// The built-in packs are code. These are the same shape, stored per
// organization, so a customer — or the assistant on their behalf — can define
// "Fleet", "Clinics", or "Case files" and install it through exactly the same
// installer. No code change, no deploy, no waiting for us.
//
// Which makes validation the whole job. A built-in pack was written by someone
// who knew the rules; a custom one arrives over HTTP, possibly composed by a
// model, and gets turned into real tables. So everything is checked here,
// before storage, and the error says what to fix rather than what broke:
//
//   - names must be legal and not collide with a table that already exists
//   - types must be real, select fields must carry options
//   - links must resolve, within the pack or to a table already installed
//   - a pack cannot be empty, and a table cannot be fieldless
//
// Storing an invalid pack would move the failure to install time, which is
// after someone pressed a button expecting it to work.

import { randomUUID } from 'node:crypto';
import {
  WORKSPACE_FIELD_TYPES,
  WORKSPACE_NAME_PATTERN,
  type ApiValidationIssue,
  type CustomTemplatePack,
  type CustomTemplatePackSpec,
  type ErpTemplate,
  type TemplateTableSpec,
  type WorkspaceFieldType,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { listTables } from './schema.js';
import type { SqlExecutor } from '../storage/sql.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

const PACK_COLS = `
  id, workspace_id AS "orgId", slug, display_name AS "displayName", description,
  spec_json AS "specJson", origin, created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

/** Reserved because the record engine owns them. */
const RESERVED_FIELD_NAMES = new Set(['id', 'revision', 'created_at', 'updated_at', 'deleted_at']);

const MAX_TABLES_PER_PACK = 24;
const MAX_FIELDS_PER_TABLE = 60;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Validate a pack against the schema rules and the organization's existing
 * tables. Returns the cleaned spec; throws with every problem at once, because
 * fixing one error at a time through an API is miserable. */
export function validatePackSpec(
  recordsDb: RecordsDb,
  spec: CustomTemplatePackSpec,
  options: {
    /** Table names that are this pack's own creations, so editing an installed
     * pack does not collide with itself. */
    ownTables?: ReadonlySet<string>;
  } = {},
): CustomTemplatePackSpec {
  const issues: ApiValidationIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  const displayName = typeof spec?.displayName === 'string' ? spec.displayName.trim() : '';
  if (!displayName) push('displayName', 'a pack needs a name');

  const tables = Array.isArray(spec?.tables) ? spec.tables : [];
  if (tables.length === 0) push('tables', 'a pack needs at least one table');
  if (tables.length > MAX_TABLES_PER_PACK) {
    push('tables', `a pack may define at most ${MAX_TABLES_PER_PACK} tables`);
  }

  const own_ = options.ownTables ?? new Set<string>();
  const existing = new Set(
    listTables(recordsDb)
      .map((table) => table.name)
      .filter((name) => !own_.has(name)),
  );
  const own = new Set<string>();
  const cleaned: TemplateTableSpec[] = [];

  for (const [index, table] of tables.entries()) {
    const at = `tables[${index}]`;
    const name = typeof table?.name === 'string' ? table.name.trim() : '';

    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      push(`${at}.name`, `'${name}' is not a usable table name — use lowercase letters, digits, and underscores`);
      continue;
    }
    if (own.has(name)) {
      push(`${at}.name`, `this pack defines '${name}' twice`);
      continue;
    }
    // Installing never overwrites, so a collision would silently do nothing —
    // better to say so while the pack is being written.
    if (existing.has(name)) {
      push(`${at}.name`, `'${name}' already exists in this organization; pick another name`);
      continue;
    }
    own.add(name);

    const fields = Array.isArray(table.fields) ? table.fields : [];
    if (fields.length === 0) {
      push(`${at}.fields`, `table '${name}' has no fields`);
      continue;
    }
    if (fields.length > MAX_FIELDS_PER_TABLE) {
      push(`${at}.fields`, `table '${name}' defines more than ${MAX_FIELDS_PER_TABLE} fields`);
      continue;
    }

    const fieldNames = new Set<string>();
    for (const [fieldIndex, field] of fields.entries()) {
      const fieldAt = `${at}.fields[${fieldIndex}]`;
      const fieldName = typeof field?.name === 'string' ? field.name.trim() : '';

      if (!WORKSPACE_NAME_PATTERN.test(fieldName)) {
        push(`${fieldAt}.name`, `'${fieldName}' is not a usable field name`);
        continue;
      }
      if (RESERVED_FIELD_NAMES.has(fieldName)) {
        push(`${fieldAt}.name`, `'${fieldName}' is reserved by the record engine`);
        continue;
      }
      if (fieldNames.has(fieldName)) {
        push(`${fieldAt}.name`, `table '${name}' defines '${fieldName}' twice`);
        continue;
      }
      fieldNames.add(fieldName);

      if (!WORKSPACE_FIELD_TYPES.includes(field.type as WorkspaceFieldType)) {
        push(`${fieldAt}.type`, `'${field.type}' is not a field type`);
        continue;
      }
      // A select with no options is a text box that rejects everything typed
      // into it — a trap rather than a constraint.
      if (field.type === 'select' && (!Array.isArray(field.options) || field.options.length === 0)) {
        push(`${fieldAt}.options`, `select field '${fieldName}' needs at least one option`);
      }
      if (field.type === 'link' && !field.linkTo) {
        push(`${fieldAt}.linkTo`, `link field '${fieldName}' must say which table it points at`);
      }
    }

    cleaned.push({
      name,
      displayName: typeof table.displayName === 'string' && table.displayName.trim()
        ? table.displayName.trim()
        : name,
      description: typeof table.description === 'string' ? table.description : '',
      fields: fields as TemplateTableSpec['fields'],
    });
  }

  // Link targets are checked last, once every table this pack defines is
  // known — a pack's tables may legitimately point at each other.
  for (const [index, table] of cleaned.entries()) {
    for (const [fieldIndex, field] of table.fields.entries()) {
      if (field.type !== 'link' || !field.linkTo) continue;
      if (own.has(field.linkTo) || existing.has(field.linkTo)) continue;
      push(
        `tables[${index}].fields[${fieldIndex}].linkTo`,
        `'${field.linkTo}' is not a table this pack defines or that already exists`,
      );
    }
  }

  if (issues.length > 0) throw workspaceValidationError(issues);

  return {
    displayName,
    description: typeof spec.description === 'string' ? spec.description.trim() : '',
    tables: cleaned,
    ...(spec.accounts ? { accounts: spec.accounts } : {}),
  };
}

/** Machine name for a pack, derived from its display name when not given. */
export function packSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function toPack(row: Record<string, any>): CustomTemplatePack {
  const spec = JSON.parse(row.specJson) as CustomTemplatePackSpec;
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description ?? '',
    spec,
    origin: row.origin,
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

export async function listCustomPacks(
  db: SqlExecutor,
  orgId: string,
): Promise<CustomTemplatePack[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT ${PACK_COLS} FROM od_template_packs WHERE workspace_id = ? ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map(toPack);
}

export async function getCustomPack(
  db: SqlExecutor,
  orgId: string,
  ref: string,
): Promise<CustomTemplatePack> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${PACK_COLS} FROM od_template_packs WHERE workspace_id = ? AND (id = ? OR slug = ?)`,
    [orgId, ref, ref],
  );
  if (!row) throw new WorkspaceDataError('TEMPLATE_NOT_FOUND', 404, `no pack '${ref}'`);
  return toPack(row);
}

export async function createCustomPack(
  db: SqlExecutor,
  recordsDb: RecordsDb,
  orgId: string,
  createdBy: string,
  input: { spec: CustomTemplatePackSpec; slug?: string; origin?: 'user' | 'agent' },
): Promise<CustomTemplatePack> {
  const spec = validatePackSpec(recordsDb, input.spec);
  const slug = packSlug(input.slug?.trim() || spec.displayName);
  if (!slug) {
    throw workspaceValidationError([{ path: 'slug', message: 'a pack needs a usable name' }]);
  }

  const clash = await db.get('SELECT id FROM od_template_packs WHERE workspace_id = ? AND slug = ?', [
    orgId,
    slug,
  ]);
  if (clash) {
    throw new WorkspaceDataError('CONFLICT', 409, `a pack called '${slug}' already exists`);
  }

  const now = Date.now();
  const id = `pack-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_template_packs
       (id, workspace_id, slug, display_name, description, spec_json, origin,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      slug,
      spec.displayName,
      spec.description,
      JSON.stringify(spec),
      input.origin ?? 'user',
      createdBy,
      now,
      now,
    ],
  );
  return getCustomPack(db, orgId, id);
}

export async function updateCustomPack(
  db: SqlExecutor,
  recordsDb: RecordsDb,
  orgId: string,
  ref: string,
  spec: CustomTemplatePackSpec,
): Promise<CustomTemplatePack> {
  const current = await getCustomPack(db, orgId, ref);
  // Tables this pack already created are not collisions with itself, so they
  // are excluded from the existing-name check — otherwise a pack could never
  // be edited after being installed.
  const installed = new Set(current.spec.tables.map((table) => table.name));
  const filtered = validatePackSpec(recordsDb, spec, { ownTables: installed });

  await db.run(
    `UPDATE od_template_packs
        SET display_name = ?, description = ?, spec_json = ?, updated_at = ?
      WHERE id = ?`,
    [filtered.displayName, filtered.description, JSON.stringify(filtered), Date.now(), current.id],
  );
  return getCustomPack(db, orgId, current.id);
}

export async function deleteCustomPack(db: SqlExecutor, orgId: string, ref: string): Promise<void> {
  const pack = await getCustomPack(db, orgId, ref);
  // Deleting the definition never touches the tables it created. A pack is a
  // recipe; throwing away the recipe does not throw away the meal.
  await db.run('DELETE FROM od_template_packs WHERE id = ?', [pack.id]);
}

/** Present a stored pack as an `ErpTemplate`, so the shared installer, the
 * status list, and the UI treat built-in and custom packs identically. */
export function packAsTemplate(pack: CustomTemplatePack): ErpTemplate {
  return {
    // Custom packs are addressed by slug; the id type is a closed union of
    // built-ins, so this is the one place the two namespaces meet.
    id: pack.slug as ErpTemplate['id'],
    displayName: pack.displayName,
    description: pack.description,
    tables: pack.spec.tables,
    ...(pack.spec.accounts ? { accounts: pack.spec.accounts } : {}),
  };
}
