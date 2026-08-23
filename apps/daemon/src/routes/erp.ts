// The business surface: hub setup, the books, proposals, questions, import.
//
// Everything here is organization-scoped and membership-checked the same way
// the data plane is. Two conventions worth stating once:
//
//   - Ledger posts stay a person's action. Documents can be drafted freely;
//     turning one into accounting requires an explicit call.
//   - Agents may import data, apply schema/record intents (as undoable
//     proposals), define and install custom packs, and edit wiki pages that
//     embed those tables. They still cannot post to a closed period.

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  ERP_TEMPLATES,
  INTENT_EXAMPLES,
  MIN_APPLY_CONFIDENCE,
  createApiError,
  isErpTemplateId,
  type ApplyIntentRequest,
  type CreateCustomPackRequest,
  type ErpTemplateId,
  type CreateJournalEntryRequest,
  type CreateLedgerAccountRequest,
  type CreateProposalRequest,
  type CreateSavedQuestionRequest,
  type ImportFromUrlRequest,
} from '@open-design/contracts';
import { getProject } from '../db.js';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
  listOrganizations,
} from '../workspace-data/tenancy.js';
import {
  closeLedgerPeriod,
  createLedgerAccount,
  getJournalEntry,
  listJournalEntries,
  listLedgerAccounts,
  listLedgerPeriods,
  postJournalEntry,
  reverseJournalEntry,
  trialBalance,
} from '../workspace-data/ledger.js';
import {
  POSTABLE_TABLES,
  businessHubStatus,
  convertDocument,
  isPostableTable,
  nextDocumentNumber,
  postDocumentIfReady,
  setUpBusinessHub,
  unpostDocument,
} from '../workspace-data/hub.js';
import {
  approveProposal,
  buildPreview,
  createProposal,
  getProposal,
  listProposals,
  rejectProposal,
  undoProposal,
} from '../workspace-data/proposals.js';
import {
  answerQuestion,
  createSavedQuestion,
  deleteSavedQuestion,
  getSavedQuestion,
  homeWidgets,
  listSavedQuestions,
  setQuestionPinned,
} from '../workspace-data/questions.js';
import { buildImportPlan, commitImport } from '../workspace-data/import.js';
import { fetchImportSource } from '../workspace-data/import-url.js';
import { recentRecords, searchWorkspace } from '../workspace-data/search.js';
import {
  installTemplate,
  installTemplateWithRequirements,
  templateStatuses,
} from '../workspace-data/templates.js';
import {
  createCustomPack,
  deleteCustomPack,
  getCustomPack,
  listCustomPacks,
  packAsTemplate,
  updateCustomPack,
} from '../workspace-data/packs.js';
import { dealToQuote, loadPipeline, moveDealStage } from '../workspace-data/crm.js';
import { loadPayables } from '../workspace-data/payables.js';
import { loadReceivables } from '../workspace-data/receivables.js';
import { loadStock } from '../workspace-data/inventory.js';
import { interpretIntent } from '../workspace-data/intent.js';
import { applyFormulas } from '../workspace-data/formula.js';
import { buildRecordDetail } from '../workspace-data/related.js';
import { recordHistory, restoreRecordVersion } from '../workspace-data/versions.js';
import { getRecord } from '../workspace-data/records.js';
import {
  blastRadius,
  removeField,
  renameField,
  reorderFields,
  restoreField,
  retypeField,
  updateFieldConfig,
} from '../workspace-data/schema-changes.js';
import {
  createView,
  deleteView,
  ensureDefaultView,
  getView,
  groupRecords,
  listViews,
  updateView,
} from '../workspace-data/views.js';
import { resolveTable } from '../workspace-data/schema.js';
import { queryRecords } from '../workspace-data/query.js';
import { loadProjects } from '../workspace-data/projects.js';
import type { WorkspaceActor } from '../workspace-data/types.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

/** Numbering prefix per document table — QUO-1001, PO-1001. Unknown tables get
 * DOC, which is right for a document type someone added themselves. */
const DOCUMENT_PREFIXES: Record<string, string> = {
  quotes: 'QUO',
  orders: 'ORD',
  invoices: 'INV',
  payments: 'PAY',
  purchase_orders: 'PO',
  bills: 'BILL',
  bill_payments: 'BP',
  stock_movements: 'STK',
  expense_claims: 'EXP',
  time_entries: 'TIME',
  projects: 'PRJ',
  time_off: 'TO',
  tickets: 'TKT',
};

function documentPrefix(table: string): string {
  return DOCUMENT_PREFIXES[table] ?? 'DOC';
}

/** The document flows the hub knows how to walk. An allowlist rather than a
 * free from/to pair: converting an invoice into a vendor bill would silently
 * copy a customer into a vendor field and produce nonsense on both sides. */
const CONVERSIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'quotes', to: 'orders' },
  { from: 'quotes', to: 'invoices' },
  { from: 'orders', to: 'invoices' },
  { from: 'purchase_orders', to: 'bills' },
];

export interface ErpRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
}

export interface RegisterErpRoutesDeps extends RouteDeps<'db' | 'auth'> {
  erp: ErpRouteServices;
}

/** Which pack owns each module report, so a missing table reports "install
 * purchasing" instead of a raw `table 'bills' not found` that tells the caller
 * nothing about what to do next. */
const MODULE_PACKS: Record<string, ErpTemplateId> = {
  crm: 'crm',
  purchasing: 'purchasing',
  inventory: 'inventory',
  projects: 'projects',
};

/** Run a module report, translating a missing table into an actionable error. */
function moduleReport<T>(module: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof WorkspaceDataError && err.code === 'WORKSPACE_TABLE_NOT_FOUND') {
      const pack = MODULE_PACKS[module];
      throw new WorkspaceDataError(
        'TEMPLATE_REQUIREMENT_MISSING',
        409,
        pack
          ? `the ${pack} pack is not installed in this organization yet`
          : err.message,
        pack ? { templateId: pack } : {},
      );
    }
    throw err;
  }
}

export function registerErpRoutes(app: Express, ctx: RegisterErpRoutesDeps) {
  const { manager, identity } = ctx.erp;
  const { authorizeToolRequest } = ctx.auth;
  const directory = () => manager.directoryExecutor;
  const appDb = ctx.db;

  function fail(res: Response, err: unknown): void {
    if (err instanceof WorkspaceDataError) {
      sendApiError(
        res,
        err.status,
        createApiError(err.code, err.message, err.details === undefined ? {} : { details: err.details }),
      );
      return;
    }
    sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as any)?.message ?? err)));
  }

  const handle =
    (fn: (req: Request, res: Response) => void | Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        fail(res, err);
      }
    };

  /** Resolve caller, organization, and both stores in one place. `recordsDb`
   * is the synchronous record engine; `orgDb` is the executor the ledger and
   * proposals use. */
  async function scope(req: Request, minimum: 'member' | 'admin' | 'owner' = 'member') {
    const orgId = param(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    await getOrganization(directory(), orgId);
    const member = assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      minimum,
      orgId,
    );
    return {
      orgId,
      member,
      recordsDb: manager.openWorkspace(orgId),
      orgDb: manager.workspaceExecutor(orgId),
      actor: { kind: 'user', memberId: member.id } as WorkspaceActor,
    };
  }

  // --- Business hub -------------------------------------------------------

  app.get('/api/orgs/:orgId/hub/status', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb } = await scope(req);
    res.json({ status: await businessHubStatus(recordsDb, orgDb, orgId) });
  }));

  app.post('/api/orgs/:orgId/hub/setup', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb, actor } = await scope(req, 'admin');
    res.status(201).json({ setup: await setUpBusinessHub(recordsDb, orgDb, orgId, actor) });
  }));

  /** Next number for a document type, so the UI can show it before saving. */
  app.get('/api/orgs/:orgId/hub/next-number/:table', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const table = param(req, 'table');
    res.json({ number: nextDocumentNumber(recordsDb, table, documentPrefix(table)) });
  }));

  // --- Templates ----------------------------------------------------------

  /** What packs exist and which are installed. The install picker reads this. */
  app.get('/api/orgs/:orgId/templates', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb } = await scope(req);
    // Built-in and custom packs are listed together and look identical, which
    // is what makes a pack a customer wrote a first-class part of the product
    // rather than a second-tier extension.
    const custom = (await listCustomPacks(orgDb, orgId)).map(packAsTemplate);
    res.json({ templates: templateStatuses(recordsDb, [...ERP_TEMPLATES, ...custom]) });
  }));

  /** Install a pack and anything it requires. Never overwrites an existing
   * table, so this is safe to call twice and is how an organization picks up
   * tables a pack has gained since they installed it. */
  app.post('/api/orgs/:orgId/templates/:templateId/install', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb, actor } = await scope(req, 'admin');
    const templateId = param(req, 'templateId');
    if (!isErpTemplateId(templateId)) {
      throw new WorkspaceDataError('TEMPLATE_NOT_FOUND', 404, `no template named '${templateId}'`);
    }
    const installed = await installTemplateWithRequirements(
      recordsDb,
      orgDb,
      orgId,
      templateId,
      actor,
    );
    res.status(201).json({ installed });
  }));

  // --- Packs an organization wrote itself ----------------------------------

  app.get('/api/orgs/:orgId/packs', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ packs: await listCustomPacks(orgDb, orgId) });
  }));

  app.get('/api/orgs/:orgId/packs/:packRef', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ pack: await getCustomPack(orgDb, orgId, param(req, 'packRef')) });
  }));

  /** Define a pack. Validated fully here rather than at install time, so a
   * spec that would not install is rejected while it is still being written. */
  app.post('/api/orgs/:orgId/packs', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb, member } = await scope(req, 'admin');
    const body = (req.body ?? {}) as CreateCustomPackRequest;
    const pack = await createCustomPack(orgDb, recordsDb, orgId, member.id, {
      spec: body.spec,
      ...(body.slug ? { slug: body.slug } : {}),
    });
    res.status(201).json({ pack });
  }));

  app.patch('/api/orgs/:orgId/packs/:packRef', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb } = await scope(req, 'admin');
    const pack = await updateCustomPack(
      orgDb,
      recordsDb,
      orgId,
      param(req, 'packRef'),
      (req.body ?? {}).spec,
    );
    res.json({ pack });
  }));

  /** Deleting the definition never touches the tables it created. A pack is a
   * recipe; throwing away the recipe does not throw away the meal. */
  app.delete('/api/orgs/:orgId/packs/:packRef', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req, 'admin');
    await deleteCustomPack(orgDb, orgId, param(req, 'packRef'));
    res.status(204).end();
  }));

  /** Install a custom pack through the same installer the built-ins use. */
  app.post('/api/orgs/:orgId/packs/:packRef/install', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb, actor } = await scope(req, 'admin');
    const pack = await getCustomPack(orgDb, orgId, param(req, 'packRef'));
    const installed = await installTemplate(
      recordsDb,
      orgDb,
      orgId,
      packAsTemplate(pack),
      actor,
    );
    res.status(201).json({ installed: [installed] });
  }));

  /** The assistant's way to draft a pack. Definitions are inert until
   * installed; records `origin: 'agent'` so a reviewer can tell who wrote it. */
  app.post('/api/tools/erp/pack', handle(async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'erp:pack');
    if (!grant) return;
    const orgId = await orgForGrant(grant, req.body?.orgId);
    const pack = await createCustomPack(
      manager.workspaceExecutor(orgId),
      manager.openWorkspace(orgId),
      orgId,
      grant.runId,
      { spec: req.body?.spec, ...(req.body?.slug ? { slug: String(req.body.slug) } : {}), origin: 'agent' },
    );
    res.status(201).json({ pack });
  }));

  // --- CRM ----------------------------------------------------------------

  /** The deal board, grouped by stage with totals already summed. */
  app.get('/api/orgs/:orgId/crm/pipeline', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;
    res.json({ pipeline: moduleReport('crm', () => loadPipeline(recordsDb, currency)) });
  }));

  /** Move a deal between stages — the drag-and-drop on the board. */
  app.post('/api/orgs/:orgId/crm/deals/:recordId/stage', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req);
    const record = moveDealStage(recordsDb, actor, param(req, 'recordId'), String(req.body?.stage ?? ''));
    res.json({ record });
  }));

  /** Turn a won deal into a quote. Returns the prepared row rather than
   * writing it, matching how quote → order → invoice already behaves. */
  app.post('/api/orgs/:orgId/crm/deals/:recordId/to-quote', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    res.json(
      dealToQuote(recordsDb, param(req, 'recordId'), {
        number: nextDocumentNumber(recordsDb, 'quotes', 'QUO'),
        date: new Date().toISOString().slice(0, 10),
      }),
    );
  }));

  // --- Purchasing ---------------------------------------------------------

  // --- Saying what you want -----------------------------------------------

  /** Read a sentence and say what it would do. Pure: nothing is written, so a
   * misread instruction costs a glance rather than a recovery. */
  app.post('/api/orgs/:orgId/assist/interpret', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const body = req.body ?? {};
    const result = interpretIntent(recordsDb, String(body.text ?? ''), {
      ...(body.tableRef ? { tableRef: String(body.tableRef) } : {}),
    });
    // The preview comes from the same builder the approval queue uses, so what
    // this screen shows and what the proposal shows cannot disagree.
    res.json({
      ...result,
      preview: result.operations.length ? buildPreview(recordsDb, result.operations) : null,
    });
  }));

  /** Apply what was interpreted. Goes through the proposal engine either way —
   * `applyNow` decides whether it waits in the approval queue or is applied
   * and recorded immediately, and both paths are undoable. */
  app.post('/api/orgs/:orgId/assist/apply', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb, member, actor } = await scope(req);
    const body = (req.body ?? {}) as ApplyIntentRequest;
    const operations = Array.isArray(body.operations) ? body.operations : [];
    if (operations.length === 0) {
      throw new WorkspaceDataError('BAD_REQUEST', 400, 'nothing to apply');
    }

    // Re-interpret rather than trusting the operations the client sent back.
    // A client that has been tampered with could otherwise post any change it
    // liked under the cover of a harmless-looking sentence.
    const rechecked = interpretIntent(recordsDb, String(body.text ?? ''), {});
    if (rechecked.confidence < MIN_APPLY_CONFIDENCE) {
      throw new WorkspaceDataError(
        'BAD_REQUEST',
        422,
        `not confident enough about "${body.text}" to apply it; ask the assistant instead`,
      );
    }

    const proposal = await createProposal(orgDb, recordsDb, orgId, {
      intent: String(body.text ?? '').trim() || rechecked.summary,
      operations,
      origin: 'user',
      createdBy: member.id,
    });

    if (!body.applyNow) {
      res.status(201).json({ proposal, applied: false });
      return;
    }
    const applied = await approveProposal(orgDb, orgId, proposal.id, member.id, {
      recordsDb,
      ledgerDb: orgDb,
      actor,
    });
    res.status(201).json({ proposal: applied, applied: true });
  }));

  /** The phrasings the local parser understands. The help panel and the CLI
   * both read this rather than keeping their own copies. */
  app.get('/api/orgs/:orgId/assist/examples', handle(async (req, res) => {
    await scope(req);
    res.json({ examples: INTENT_EXAMPLES });
  }));

  // --- Record pages -------------------------------------------------------

  /** One record with everything hanging off it: what it points at, what points
   * back, the totals of those, and which document actions are valid now. */
  app.get('/api/orgs/:orgId/records/:recordId/detail', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    res.json({ detail: buildRecordDetail(recordsDb, param(req, 'recordId')) });
  }));

  /** Everything that ever happened to this record, newest first. */
  app.get('/api/orgs/:orgId/records/:recordId/history', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const recordId = param(req, 'recordId');
    const table = resolveTable(recordsDb, getRecord(recordsDb, recordId).tableId);
    res.json({ history: recordHistory(recordsDb, table, recordId) });
  }));

  /** Put a record back to how it looked at a revision. Writes a new revision
   * rather than rewinding, so the history only ever grows. */
  app.post('/api/orgs/:orgId/records/:recordId/restore-version', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req);
    const recordId = param(req, 'recordId');
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision)) {
      throw new WorkspaceDataError('BAD_REQUEST', 400, 'which revision should it go back to?');
    }
    const table = resolveTable(recordsDb, getRecord(recordsDb, recordId).tableId);
    res.json({ record: restoreRecordVersion(recordsDb, table, actor, recordId, revision) });
  }));

  // --- Shaping a table ----------------------------------------------------

  /** What a change would cost, computed without making it. */
  app.get('/api/orgs/:orgId/tables/:tableRef/fields/:fieldName/impact', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const to = typeof req.query.to === 'string' ? req.query.to : '';
    const kind = req.query.kind === 'retype' ? 'retype' : req.query.kind === 'delete' ? 'delete' : 'rename';
    const change =
      kind === 'retype'
        ? ({ kind: 'retype', to: to as never } as const)
        : kind === 'delete'
          ? ({ kind: 'delete' } as const)
          : ({ kind: 'rename', to } as const);
    res.json({
      impact: blastRadius(recordsDb, param(req, 'tableRef'), param(req, 'fieldName'), change),
    });
  }));

  app.post('/api/orgs/:orgId/tables/:tableRef/fields/:fieldName/rename', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req, 'admin');
    const table = renameField(
      recordsDb,
      actor,
      param(req, 'tableRef'),
      param(req, 'fieldName'),
      String(req.body?.to ?? ''),
    );
    res.json({ table });
  }));

  app.post('/api/orgs/:orgId/tables/:tableRef/fields/:fieldName/retype', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req, 'admin');
    const table = retypeField(
      recordsDb,
      actor,
      param(req, 'tableRef'),
      param(req, 'fieldName'),
      req.body?.to,
      { acceptDataLoss: req.body?.acceptDataLoss === true },
    );
    res.json({ table });
  }));

  app.patch('/api/orgs/:orgId/tables/:tableRef/fields/:fieldName', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req, 'admin');
    const table = updateFieldConfig(
      recordsDb,
      actor,
      param(req, 'tableRef'),
      param(req, 'fieldName'),
      req.body ?? {},
    );
    res.json({ table });
  }));

  /** Removing keeps the values, so this is undoable by restoring. */
  app.delete('/api/orgs/:orgId/tables/:tableRef/fields/:fieldName', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req, 'admin');
    res.json({
      table: removeField(recordsDb, actor, param(req, 'tableRef'), param(req, 'fieldName')),
    });
  }));

  app.post('/api/orgs/:orgId/tables/:tableRef/fields/:fieldName/restore', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req, 'admin');
    res.json({
      table: restoreField(recordsDb, actor, param(req, 'tableRef'), param(req, 'fieldName')),
    });
  }));

  app.post('/api/orgs/:orgId/tables/:tableRef/fields/reorder', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req, 'admin');
    const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
    res.json({ table: reorderFields(recordsDb, actor, param(req, 'tableRef'), order) });
  }));

  // --- Saved views --------------------------------------------------------

  app.get('/api/orgs/:orgId/tables/:tableRef/views', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb, member } = await scope(req);
    const table = resolveTable(recordsDb, param(req, 'tableRef'));
    // Every table has at least one view, created on first read, so the UI
    // never has to handle "a table with nowhere to open".
    await ensureDefaultView(orgDb, orgId, table, member.id);
    res.json({ views: await listViews(orgDb, orgId, table.id) });
  }));

  app.post('/api/orgs/:orgId/tables/:tableRef/views', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb, member } = await scope(req);
    const table = resolveTable(recordsDb, param(req, 'tableRef'));
    const view = await createView(orgDb, orgId, table.id, member.id, req.body ?? {});
    res.status(201).json({ view });
  }));

  app.patch('/api/orgs/:orgId/views/:viewId', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ view: await updateView(orgDb, orgId, param(req, 'viewId'), req.body ?? {}) });
  }));

  app.delete('/api/orgs/:orgId/views/:viewId', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    await deleteView(orgDb, orgId, param(req, 'viewId'));
    res.status(204).end();
  }));

  /** Run a view: its filters and sorts applied, its grouping computed, and any
   * formula fields filled in. */
  app.get('/api/orgs/:orgId/views/:viewId/records', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb } = await scope(req);
    const view = await getView(orgDb, orgId, param(req, 'viewId'));
    const table = resolveTable(recordsDb, view.tableId);
    const result = queryRecords(recordsDb, table, {
      filters: view.filters,
      ...(view.sorts[0] ? { sort: view.sorts[0] } : {}),
      limit: req.query.limit ? Number(req.query.limit) : 200,
      ...(typeof req.query.cursor === 'string' ? { cursor: req.query.cursor } : {}),
    });
    const records = result.records.map((record) => applyFormulas(table, record));
    res.json({
      view,
      records,
      groups: view.groupBy ? groupRecords(records, table, view.groupBy) : null,
      nextCursor: result.nextCursor ?? null,
    });
  }));

  // --- Inventory ----------------------------------------------------------

  /** Stock on hand, summed from movements. Short stock sorts first. */
  app.get('/api/orgs/:orgId/inventory/stock', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    res.json({
      stock: moduleReport('inventory', () => loadStock(recordsDb, {
        ...(typeof req.query.currency === 'string' ? { currency: req.query.currency } : {}),
        ...(typeof req.query.warehouseId === 'string' ? { warehouseId: req.query.warehouseId } : {}),
      })),
    });
  }));

  // --- Projects -----------------------------------------------------------

  /** Hours, billable value, and budget per project. Over-budget first. */
  app.get('/api/orgs/:orgId/projects/summary', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;
    res.json({ projects: moduleReport('projects', () => loadProjects(recordsDb, currency)) });
  }));

  /** What we owe vendors, most overdue first. */
  app.get('/api/orgs/:orgId/purchasing/payables', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    res.json({
      payables: moduleReport('purchasing', () =>
        loadPayables(recordsDb, {
          ...(typeof req.query.asOf === 'string' ? { asOf: req.query.asOf } : {}),
          ...(typeof req.query.currency === 'string' ? { currency: req.query.currency } : {}),
        }),
      ),
    });
  }));

  /** What customers owe us — aged receivables from invoices + payments. */
  app.get('/api/orgs/:orgId/sales/receivables', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    try {
      res.json({
        receivables: loadReceivables(recordsDb, {
          ...(typeof req.query.asOf === 'string' ? { asOf: req.query.asOf } : {}),
          ...(typeof req.query.currency === 'string' ? { currency: req.query.currency } : {}),
        }),
      });
    } catch (err) {
      if (err instanceof WorkspaceDataError && err.code === 'WORKSPACE_TABLE_NOT_FOUND') {
        throw new WorkspaceDataError(
          'TEMPLATE_REQUIREMENT_MISSING',
          409,
          'the business hub is not set up yet — run hub setup first',
          { templateId: 'hub' },
        );
      }
      throw err;
    }
  }));

  /** Quote → order → invoice. Returns the prepared row rather than writing
   * it, so the person sees what they are about to create. */
  app.post('/api/orgs/:orgId/hub/convert', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req);
    const body = req.body ?? {};
    const from = String(body.from ?? '');
    const to = String(body.to ?? '');
    if (!CONVERSIONS.some((pair) => pair.from === from && pair.to === to)) {
      throw new WorkspaceDataError(
        'BAD_REQUEST',
        400,
        `cannot convert ${from || '(nothing)'} to ${to || '(nothing)'}; supported: ${CONVERSIONS.map(
          (pair) => `${pair.from} → ${pair.to}`,
        ).join(', ')}`,
      );
    }
    const converted = convertDocument(recordsDb, actor, from, to, String(body.recordId ?? ''), {
      number: nextDocumentNumber(recordsDb, to, documentPrefix(to)),
      date: new Date().toISOString().slice(0, 10),
    });
    res.json({ table: converted.targetTable.name, data: converted.data });
  }));

  /** Turn a document into accounting. Separate from saving it, because
   * drafting an invoice and committing to it are different decisions. */
  app.post('/api/orgs/:orgId/hub/post/:table/:recordId', handle(async (req, res) => {
    const { orgId, recordsDb, orgDb, member } = await scope(req);
    const table = param(req, 'table');
    if (!isPostableTable(table)) {
      throw new WorkspaceDataError(
        'BAD_REQUEST',
        400,
        `${table} does not post to the books; postable documents are ${Object.keys(POSTABLE_TABLES).join(', ')}`,
      );
    }
    const result = await postDocumentIfReady(
      recordsDb,
      orgDb,
      orgId,
      member.id,
      table,
      param(req, 'recordId'),
    );
    res.json(result);
  }));

  app.post('/api/orgs/:orgId/hub/unpost/:recordId', handle(async (req, res) => {
    const { orgId, orgDb, member } = await scope(req, 'admin');
    res.json({ reversals: await unpostDocument(orgDb, orgId, member.id, param(req, 'recordId')) });
  }));

  // --- The books ----------------------------------------------------------

  app.get('/api/orgs/:orgId/ledger/accounts', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ accounts: await listLedgerAccounts(orgDb, orgId) });
  }));

  app.post('/api/orgs/:orgId/ledger/accounts', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req, 'admin');
    const account = await createLedgerAccount(orgDb, orgId, (req.body ?? {}) as CreateLedgerAccountRequest);
    res.status(201).json({ account });
  }));

  app.get('/api/orgs/:orgId/ledger/entries', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({
      entries: await listJournalEntries(orgDb, orgId, {
        ...(typeof req.query.status === 'string' ? { status: req.query.status as never } : {}),
        ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      }),
    });
  }));

  app.get('/api/orgs/:orgId/ledger/entries/:entryId', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ entry: await getJournalEntry(orgDb, orgId, param(req, 'entryId')) });
  }));

  app.post('/api/orgs/:orgId/ledger/entries', handle(async (req, res) => {
    const { orgId, orgDb, member } = await scope(req);
    const entry = await postJournalEntry(
      orgDb,
      orgId,
      member.id,
      (req.body ?? {}) as CreateJournalEntryRequest,
    );
    res.status(201).json({ entry });
  }));

  app.post('/api/orgs/:orgId/ledger/entries/:entryId/reverse', handle(async (req, res) => {
    const { orgId, orgDb, member } = await scope(req);
    const result = await reverseJournalEntry(orgDb, orgId, param(req, 'entryId'), member.id, req.body ?? {});
    res.json(result);
  }));

  app.get('/api/orgs/:orgId/ledger/trial-balance', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({
      trialBalance: await trialBalance(orgDb, orgId, {
        ...(typeof req.query.asOf === 'string' ? { asOf: req.query.asOf } : {}),
        ...(typeof req.query.currency === 'string' ? { currency: req.query.currency } : {}),
      }),
    });
  }));

  app.get('/api/orgs/:orgId/ledger/periods', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ periods: await listLedgerPeriods(orgDb, orgId) });
  }));

  app.post('/api/orgs/:orgId/ledger/periods/close', handle(async (req, res) => {
    const { orgId, orgDb, member } = await scope(req, 'owner');
    const body = req.body ?? {};
    res.status(201).json({
      period: await closeLedgerPeriod(orgDb, orgId, {
        startDate: String(body.startDate ?? ''),
        endDate: String(body.endDate ?? ''),
        closedBy: member.id,
      }),
    });
  }));

  // --- Proposals ----------------------------------------------------------

  app.get('/api/orgs/:orgId/proposals', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({
      proposals: await listProposals(orgDb, orgId, {
        ...(typeof req.query.status === 'string' ? { status: req.query.status as never } : {}),
      }),
    });
  }));

  app.get('/api/orgs/:orgId/proposals/:proposalId', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ proposal: await getProposal(orgDb, orgId, param(req, 'proposalId')) });
  }));

  app.post('/api/orgs/:orgId/proposals', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb, member } = await scope(req);
    const body = (req.body ?? {}) as CreateProposalRequest;
    const proposal = await createProposal(orgDb, recordsDb, orgId, {
      ...body,
      origin: 'user',
      createdBy: member.id,
    });
    res.status(201).json({ proposal });
  }));

  app.post('/api/orgs/:orgId/proposals/:proposalId/approve', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb, member, actor } = await scope(req);
    const proposal = await approveProposal(orgDb, orgId, param(req, 'proposalId'), member.id, {
      recordsDb,
      ledgerDb: orgDb,
      actor,
    });
    res.json({ proposal });
  }));

  app.post('/api/orgs/:orgId/proposals/:proposalId/reject', handle(async (req, res) => {
    const { orgId, orgDb, member } = await scope(req);
    res.json({ proposal: await rejectProposal(orgDb, orgId, param(req, 'proposalId'), member.id) });
  }));

  app.post('/api/orgs/:orgId/proposals/:proposalId/undo', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb, member, actor } = await scope(req);
    const proposal = await undoProposal(orgDb, orgId, param(req, 'proposalId'), member.id, {
      recordsDb,
      ledgerDb: orgDb,
      actor,
    });
    res.json({ proposal });
  }));

  // --- Questions and widgets ----------------------------------------------

  app.get('/api/orgs/:orgId/questions', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    res.json({ questions: await listSavedQuestions(orgDb, orgId) });
  }));

  app.post('/api/orgs/:orgId/questions', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb, member } = await scope(req);
    const question = await createSavedQuestion(
      orgDb,
      recordsDb,
      orgId,
      member.id,
      (req.body ?? {}) as CreateSavedQuestionRequest,
    );
    res.status(201).json({ question, answer: answerQuestion(recordsDb, question) });
  }));

  app.get('/api/orgs/:orgId/questions/:questionId/answer', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb } = await scope(req);
    const question = await getSavedQuestion(orgDb, orgId, param(req, 'questionId'));
    res.json({ answer: answerQuestion(recordsDb, question) });
  }));

  app.post('/api/orgs/:orgId/questions/:questionId/pin', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    const pinned = req.body?.pinned !== false;
    res.json({ question: await setQuestionPinned(orgDb, orgId, param(req, 'questionId'), pinned) });
  }));

  app.delete('/api/orgs/:orgId/questions/:questionId', handle(async (req, res) => {
    const { orgId, orgDb } = await scope(req);
    await deleteSavedQuestion(orgDb, orgId, param(req, 'questionId'));
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/home-widgets', handle(async (req, res) => {
    const { orgId, orgDb, recordsDb } = await scope(req);
    res.json({ widgets: await homeWidgets(orgDb, recordsDb, orgId) });
  }));

  // --- Search -------------------------------------------------------------

  // One box over everything. People think "Northwind" or "INV-1042", not
  // "which table is that in".
  app.get('/api/orgs/:orgId/search', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({
      query,
      groups: searchWorkspace(recordsDb, query, {
        ...(req.query.perTable ? { perTable: Number(req.query.perTable) } : {}),
      }),
    });
  }));

  /** What to show before anyone has typed. */
  app.get('/api/orgs/:orgId/recent', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    res.json({
      records: recentRecords(recordsDb, req.query.limit ? Number(req.query.limit) : 12),
    });
  }));

  // --- Spreadsheet import -------------------------------------------------

  app.post('/api/orgs/:orgId/import/plan', handle(async (req, res) => {
    const { recordsDb } = await scope(req);
    const body = req.body ?? {};
    res.json({
      plan: buildImportPlan(recordsDb, {
        content: String(body.content ?? ''),
        ...(body.tableName ? { tableName: String(body.tableName) } : {}),
        ...(body.fileName ? { fileName: String(body.fileName) } : {}),
      }),
    });
  }));

  app.post('/api/orgs/:orgId/import/commit', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req);
    const body = req.body ?? {};
    if (!body.plan) {
      throw new WorkspaceDataError('BAD_REQUEST', 400, 'commit needs the plan you were shown');
    }
    res.status(201).json(commitImport(recordsDb, actor, body.plan, String(body.content ?? '')));
  }));

  /** Magic import: fetch a public spreadsheet / JSON / HTML table / Google
   * Sheet and show (or commit) the same plan a file drop would. */
  app.post('/api/orgs/:orgId/import/from-url', handle(async (req, res) => {
    const { recordsDb, actor } = await scope(req);
    const body = (req.body ?? {}) as ImportFromUrlRequest;
    const url = String(body.url ?? '').trim();
    if (!url) throw new WorkspaceDataError('BAD_REQUEST', 400, 'paste the link to import');
    const source = await fetchImportSource(url);
    const plan = buildImportPlan(recordsDb, {
      content: source.content,
      fileName: source.fileName,
      ...(body.tableName ? { tableName: String(body.tableName) } : {}),
    });
    const sourceMeta = {
      url: source.url,
      finalUrl: source.finalUrl,
      kind: source.kind,
      fileName: source.fileName,
    };
    if (!body.commit) {
      res.json({ source: sourceMeta, plan, content: source.content });
      return;
    }
    const result = commitImport(recordsDb, actor, plan, source.content);
    res.status(201).json({ source: sourceMeta, plan, ...result });
  }));

  // --- Agent surface ------------------------------------------------------

  async function orgForGrant(grant: { projectId: string; runId: string }, bodyOrgId?: unknown): Promise<string> {
    if (typeof bodyOrgId === 'string' && bodyOrgId) {
      await getOrganization(directory(), bodyOrgId);
      return bodyOrgId;
    }
    try {
      const metadata = getProject(appDb, grant.projectId)?.metadata;
      const pinned = (metadata as { workspaceId?: string } | null)?.workspaceId;
      if (typeof pinned === 'string' && pinned) {
        await getOrganization(directory(), pinned);
        return pinned;
      }
    } catch {
      /* fall through */
    }
    const first = (await listOrganizations(directory()))[0];
    if (!first) throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'no organization to act in');
    return first.id;
  }

  function agentActor(grant: { runId: string; projectId: string }): WorkspaceActor {
    return { kind: 'agent', runId: grant.runId, projectId: grant.projectId };
  }

  /** Describe a change. With `apply: true` it is stored as a proposal and
   * applied immediately so the agent can actually reshape tables — still
   * undoable from the approvals queue. Queries run immediately (they read). */
  app.post('/api/tools/erp/ask', handle(async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'erp:ask');
    if (!grant) return;
    const orgId = await orgForGrant(grant, req.body?.orgId);
    const recordsDb = manager.openWorkspace(orgId);
    const orgDb = manager.workspaceExecutor(orgId);
    const text = String(req.body?.text ?? req.body?.intent ?? '').trim();
    if (!text) throw new WorkspaceDataError('BAD_REQUEST', 400, 'say what you want to change or find');
    const interpreted = interpretIntent(recordsDb, text, {
      ...(req.body?.tableRef ? { tableRef: String(req.body.tableRef) } : {}),
    });
    const preview = interpreted.operations.length ? buildPreview(recordsDb, interpreted.operations) : null;
    if (interpreted.kind === 'query' && interpreted.query) {
      const table = resolveTable(recordsDb, interpreted.query.tableRef);
      const page = queryRecords(recordsDb, table, {
        filters: interpreted.query.filters,
        ...(interpreted.query.sort ? { sort: interpreted.query.sort } : {}),
        limit: 50,
      });
      res.json({ ...interpreted, preview, records: page.records });
      return;
    }
    if (!req.body?.apply || interpreted.operations.length === 0) {
      res.json({ ...interpreted, preview, applied: false });
      return;
    }
    if (interpreted.confidence < MIN_APPLY_CONFIDENCE) {
      throw new WorkspaceDataError(
        'BAD_REQUEST',
        422,
        `not confident enough about "${text}" to apply it; create a table or pack explicitly instead`,
      );
    }
    const proposal = await createProposal(orgDb, recordsDb, orgId, {
      intent: text,
      operations: interpreted.operations,
      origin: 'agent',
      runId: grant.runId,
      createdBy: grant.runId,
    });
    const applied = await approveProposal(orgDb, orgId, proposal.id, grant.runId, {
      recordsDb,
      ledgerDb: orgDb,
      actor: agentActor(grant),
    });
    res.status(201).json({ ...interpreted, preview, proposal: applied, applied: true });
  }));

  app.post('/api/tools/erp/import-url', handle(async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'erp:import-url');
    if (!grant) return;
    const orgId = await orgForGrant(grant, req.body?.orgId);
    const recordsDb = manager.openWorkspace(orgId);
    const url = String(req.body?.url ?? '').trim();
    if (!url) throw new WorkspaceDataError('BAD_REQUEST', 400, 'pass the link to import');
    const source = await fetchImportSource(url);
    const plan = buildImportPlan(recordsDb, {
      content: source.content,
      fileName: source.fileName,
      ...(req.body?.tableName ? { tableName: String(req.body.tableName) } : {}),
    });
    const sourceMeta = {
      url: source.url,
      finalUrl: source.finalUrl,
      kind: source.kind,
      fileName: source.fileName,
    };
    if (req.body?.commit === false) {
      res.json({ source: sourceMeta, plan, content: source.content });
      return;
    }
    const result = commitImport(recordsDb, agentActor(grant), plan, source.content);
    res.status(201).json({ source: sourceMeta, plan, ...result });
  }));

  app.post('/api/tools/erp/pack-install', handle(async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'erp:pack-install');
    if (!grant) return;
    const orgId = await orgForGrant(grant, req.body?.orgId);
    const orgDb = manager.workspaceExecutor(orgId);
    const recordsDb = manager.openWorkspace(orgId);
    const ref = String(req.body?.pack ?? req.body?.slug ?? '').trim();
    if (!ref) throw new WorkspaceDataError('BAD_REQUEST', 400, 'which pack should be installed?');
    const pack = await getCustomPack(orgDb, orgId, ref);
    const installed = await installTemplate(recordsDb, orgDb, orgId, packAsTemplate(pack), agentActor(grant));
    res.status(201).json({ installed: [installed] });
  }));

  /** Queue a change for a person to approve. Prefer `ask` with apply when the
   * user asked the agent to make the change. */
  app.post('/api/tools/erp/propose', handle(async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'erp:propose');
    if (!grant) return;
    const orgId = await orgForGrant(grant, req.body?.orgId);
    const proposal = await createProposal(
      manager.workspaceExecutor(orgId),
      manager.openWorkspace(orgId),
      orgId,
      {
        intent: String(req.body?.intent ?? ''),
        operations: req.body?.operations ?? [],
        origin: 'agent',
        runId: grant.runId,
        createdBy: grant.runId,
      },
    );
    res.status(201).json({ proposal });
  }));

  /** Dry-run a set of operations without storing a proposal, so the assistant
   * can check its own work before offering it. */
  app.post('/api/tools/erp/preview', handle(async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'erp:preview');
    if (!grant) return;
    const orgId = await orgForGrant(grant, req.body?.orgId);
    res.json({ preview: buildPreview(manager.openWorkspace(orgId), req.body?.operations ?? []) });
  }));
}
