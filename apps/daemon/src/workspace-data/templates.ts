// Installing ERP template packs.
//
// This is the generalization of `setUpBusinessHub`: same guarantees, driven by
// a registry rather than one hardcoded schema. The hub's setup now delegates
// here, so there is exactly one piece of code that turns a table spec into
// tables and one definition of what "already installed" means.
//
// Two properties everything below is built to preserve:
//
//   - Installing never overwrites. A table that exists is reported as skipped
//     and left exactly as the organization has customized it. This is what
//     makes installing `purchasing` a year after `sales` safe, and what makes
//     re-running an install a way to pick up tables a pack has since gained.
//   - Links resolve before they are used. A field that points at a table
//     creates that table first, whether it comes from this pack or a required
//     one, because a link field cannot be created against a table id that does
//     not exist yet.

import {
  findErpTemplate,
  resolveTemplateOrder,
  type ErpTemplate,
  type ErpTemplateId,
  type TemplateInstallResult,
  type TemplateStatus,
  type TemplateTableSpec,
} from '@open-design/contracts';
import { seedChartOfAccounts } from './ledger.js';
import { WorkspaceDataError } from './errors.js';
import { createTable, listTables, loadTableByName } from './schema.js';
import { addFieldToTable } from './proposals.js';
import { queryRecords } from './query.js';
import type { WorkspaceActor } from './types.js';
import type { SqlExecutor } from '../storage/sql.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

/** Order a pack's tables so every link target is created before the field that
 * points at it. Templates list their tables in a sensible order already; this
 * makes that a guarantee rather than a convention someone could break by
 * appending a table to the wrong end of the array.
 *
 * Links to tables outside the pack are ignored here — they must already exist,
 * which `assertRequirements` is what checks. */
export function orderTablesByDependency(tables: TemplateTableSpec[]): TemplateTableSpec[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const placed = new Set<string>();
  const out: TemplateTableSpec[] = [];
  // A pack that somehow described a cycle would otherwise recurse forever;
  // breaking it leaves the link field to fail loudly at creation instead.
  const visiting = new Set<string>();

  const visit = (table: TemplateTableSpec) => {
    if (placed.has(table.name) || visiting.has(table.name)) return;
    visiting.add(table.name);
    for (const field of table.fields) {
      if (field.type !== 'link' || !field.linkTo || field.linkTo === table.name) continue;
      const target = byName.get(field.linkTo);
      if (target) visit(target);
    }
    visiting.delete(table.name);
    placed.add(table.name);
    out.push(table);
  };

  for (const table of tables) visit(table);
  return out;
}

/** Every table a pack links to that it does not itself define. */
function externalLinkTargets(template: ErpTemplate): string[] {
  const own = new Set(template.tables.map((table) => table.name));
  const external = new Set<string>();
  for (const table of template.tables) {
    for (const field of table.fields) {
      if (field.type === 'link' && field.linkTo && !own.has(field.linkTo)) {
        external.add(field.linkTo);
      }
    }
  }
  return [...external];
}

/** Refuse an install whose link targets are missing, naming what to install
 * first. Without this the failure surfaces as "table 'customers' not found"
 * from deep inside field creation, which tells the user nothing about what to
 * do next. */
function assertRequirements(recordsDb: RecordsDb, template: ErpTemplate): void {
  const existing = new Set(listTables(recordsDb).map((table) => table.name));
  const missing = externalLinkTargets(template).filter((name) => !existing.has(name));
  if (missing.length === 0) return;
  const packs = template.requires ?? [];
  throw new WorkspaceDataError(
    'TEMPLATE_REQUIREMENT_MISSING',
    409,
    `the ${template.displayName} pack links to ${missing.join(', ')}, which ${
      missing.length === 1 ? 'does' : 'do'
    } not exist yet${packs.length ? `; install the ${packs.join(' and ')} pack first` : ''}`,
    { missingTables: missing, requires: packs },
  );
}

/** Create one pack's tables and accounts. Idempotent.
 *
 * Takes either a built-in id or a whole template. The second form is what lets
 * a pack a customer wrote install through exactly this code path rather than a
 * parallel one — same ordering, same never-overwrite rule, same reporting. */
export async function installTemplate(
  recordsDb: RecordsDb,
  ledgerDb: SqlExecutor,
  orgId: string,
  templateOrId: ErpTemplateId | ErpTemplate,
  actor: WorkspaceActor,
): Promise<TemplateInstallResult> {
  const template =
    typeof templateOrId === 'string' ? findErpTemplate(templateOrId) : templateOrId;
  if (!template) {
    throw new WorkspaceDataError('TEMPLATE_NOT_FOUND', 404, `no template named '${templateOrId}'`);
  }
  const templateId = template.id;
  assertRequirements(recordsDb, template);

  const existing = new Set(listTables(recordsDb).map((table) => table.name));
  const created: string[] = [];
  const skipped: string[] = [];

  for (const spec of orderTablesByDependency(template.tables)) {
    if (existing.has(spec.name)) {
      skipped.push(spec.name);
      continue;
    }
    // A field that links to its own table cannot be created with the table:
    // the link needs a target id, and the target does not exist until the
    // CREATE returns. So the table is created without those fields and they
    // are added immediately afterwards. `employees.manager -> employees` is
    // the case that matters, and reporting lines are worth the extra step.
    const selfLinks = spec.fields.filter(
      (field) => field.type === 'link' && field.linkTo === spec.name,
    );
    const request = specToRequest(recordsDb, {
      ...spec,
      fields: spec.fields.filter((field) => !selfLinks.includes(field)),
    });
    const table = createTable(recordsDb, request, actor);

    for (const field of selfLinks) {
      const config: Record<string, unknown> = { targetTableId: table.id, onDelete: 'clear' };
      if (field.role) config.role = field.role;
      addFieldToTable(
        recordsDb,
        table.id,
        {
          name: field.name,
          displayName: field.displayName,
          type: field.type,
          ...(field.unique ? { unique: true } : {}),
          config,
        },
        actor,
      );
    }

    // Later tables in this pack may link to the one just created.
    existing.add(spec.name);
    created.push(spec.name);
  }

  const accountsCreated = template.accounts
    ? await seedChartOfAccounts(ledgerDb, orgId, template.accounts)
    : 0;

  return { templateId, created, skipped, accountsCreated };
}

/** Install a pack and everything it requires, dependencies first. */
export async function installTemplateWithRequirements(
  recordsDb: RecordsDb,
  ledgerDb: SqlExecutor,
  orgId: string,
  templateId: ErpTemplateId,
  actor: WorkspaceActor,
): Promise<TemplateInstallResult[]> {
  const results: TemplateInstallResult[] = [];
  for (const id of resolveTemplateOrder(templateId)) {
    results.push(await installTemplate(recordsDb, ledgerDb, orgId, id, actor));
  }
  return results;
}

/** Translate a template's table spec into the schema layer's create request.
 * The role and link resolution here is the one place a spec becomes real
 * columns, which is why both the hub and every future pack route through it. */
function specToRequest(recordsDb: RecordsDb, spec: TemplateTableSpec) {
  return {
    name: spec.name,
    displayName: spec.displayName,
    description: spec.description,
    fields: spec.fields.map((field) => {
      const config: Record<string, unknown> = {};
      if (field.role) config.role = field.role;
      if (field.options) config.options = field.options;
      if (field.linkTo) {
        const target = loadTableByName(recordsDb, field.linkTo);
        config.targetTableId = target.id;
        // Clearing rather than blocking: deleting a vendor should not be
        // impossible because a two-year-old purchase order mentions them.
        config.onDelete = 'clear';
      }
      if (field.type === 'money') config.currency = 'USD';
      return {
        name: field.name,
        displayName: field.displayName,
        type: field.type,
        ...(field.required ? { required: true } : {}),
        ...(field.unique ? { unique: true } : {}),
        ...(Object.keys(config).length ? { config } : {}),
      };
    }),
  };
}

/** What is installed, for the picker. Reports per-table presence rather than a
 * bare boolean so a pack that gained a table since it was installed shows up as
 * incomplete and can be topped up by installing again. */
export function templateStatuses(recordsDb: RecordsDb, templates: readonly ErpTemplate[]): TemplateStatus[] {
  const byName = new Map(listTables(recordsDb).map((table) => [table.name, table]));
  return templates.map((template) => {
    const tables = template.tables.map((spec) => {
      const table = byName.get(spec.name);
      return {
        name: spec.name,
        displayName: spec.displayName,
        present: Boolean(table),
        tableId: table?.id ?? null,
        recordCount: table ? queryRecords(recordsDb, table, { limit: 500 }).records.length : 0,
      };
    });
    return {
      templateId: template.id,
      displayName: template.displayName,
      description: template.description,
      installed: tables.every((table) => table.present),
      tables,
      requires: template.requires ?? [],
    };
  });
}
