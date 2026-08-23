// The business layer: books that balance, changes that need a yes, and
// spreadsheets that become tables.
//
// The accounting tests are written as refusals rather than happy paths,
// because the value of a ledger is entirely in what it will not let you do.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import {
  checkBalance,
  closeLedgerPeriod,
  createLedgerAccount,
  getJournalEntry,
  listJournalEntries,
  listLedgerAccounts,
  postJournalEntry,
  reverseJournalEntry,
  seedChartOfAccounts,
  trialBalance,
} from '../src/workspace-data/ledger.js';
import {
  businessHubStatus,
  convertDocument,
  nextDocumentNumber,
  postDocumentIfReady,
  setUpBusinessHub,
  unpostDocument,
} from '../src/workspace-data/hub.js';
import {
  approveProposal,
  buildPreview,
  createProposal,
  rejectProposal,
  undoProposal,
} from '../src/workspace-data/proposals.js';
import {
  answerQuestion,
  createSavedQuestion,
  homeWidgets,
  setQuestionPinned,
} from '../src/workspace-data/questions.js';
import {
  buildImportPlan,
  coerceCell,
  commitImport,
  guessColumnType,
  parseDelimited,
} from '../src/workspace-data/import.js';
import { loadTableByName } from '../src/workspace-data/schema.js';
import { createRecord, getRecord } from '../src/workspace-data/records.js';
import { queryRecords } from '../src/workspace-data/query.js';
import { DEFAULT_CHART_OF_ACCOUNTS } from '@open-design/contracts';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

describe('business layer', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-erp-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const records = () => manager.openWorkspace(orgId);
  const ledger = () => manager.workspaceExecutor(orgId);

  async function withAccounts() {
    await seedChartOfAccounts(ledger(), orgId, DEFAULT_CHART_OF_ACCOUNTS);
  }

  describe('double-entry ledger', () => {
    it('posts a balanced entry and numbers it', async () => {
      await withAccounts();
      const entry = await postJournalEntry(ledger(), orgId, 'wsm-test', {
        date: '2026-03-01',
        memo: 'Opening balance',
        lines: [
          { accountCode: '1000', direction: 'debit', amount: 500_00 },
          { accountCode: '3000', direction: 'credit', amount: 500_00 },
        ],
      });
      expect(entry.status).toBe('posted');
      expect(entry.number).toBe(1);
      expect(entry.lines).toHaveLength(2);
      expect(entry.lines[0]!.accountCode).toBe('1000');
    });

    it('refuses an entry whose debits do not equal its credits', async () => {
      await withAccounts();
      await expect(
        postJournalEntry(ledger(), orgId, 'wsm-test', {
          date: '2026-03-01',
          lines: [
            { accountCode: '1000', direction: 'debit', amount: 500_00 },
            { accountCode: '3000', direction: 'credit', amount: 400_00 },
          ],
        }),
      ).rejects.toThrow(/do not equal/);
    });

    it('refuses a float amount so rounding error cannot enter the books', async () => {
      await withAccounts();
      await expect(
        postJournalEntry(ledger(), orgId, 'wsm-test', {
          date: '2026-03-01',
          lines: [
            { accountCode: '1000', direction: 'debit', amount: 10.5 },
            { accountCode: '3000', direction: 'credit', amount: 10.5 },
          ],
        }),
      ).rejects.toThrow(/integer minor units/);
    });

    it('refuses a one-sided entry', async () => {
      await withAccounts();
      await expect(
        postJournalEntry(ledger(), orgId, 'wsm-test', {
          date: '2026-03-01',
          lines: [{ accountCode: '1000', direction: 'debit', amount: 100 }],
        }),
      ).rejects.toThrow(/at least two lines/);
    });

    it('refuses to mix currencies in one entry', async () => {
      await withAccounts();
      await createLedgerAccount(ledger(), orgId, {
        code: '1050',
        name: 'Euro Cash',
        type: 'asset',
        currency: 'EUR',
      });
      await expect(
        postJournalEntry(ledger(), orgId, 'wsm-test', {
          date: '2026-03-01',
          lines: [
            { accountCode: '1050', direction: 'debit', amount: 100 },
            { accountCode: '3000', direction: 'credit', amount: 100 },
          ],
        }),
      ).rejects.toThrow(/cannot mix currencies/);
    });

    it('will not let a posted entry be edited or deleted, even by raw SQL', async () => {
      await withAccounts();
      const entry = await postJournalEntry(ledger(), orgId, 'wsm-test', {
        date: '2026-03-01',
        lines: [
          { accountCode: '1000', direction: 'debit', amount: 100 },
          { accountCode: '3000', direction: 'credit', amount: 100 },
        ],
      });
      const raw = records();
      expect(() =>
        raw.prepare("UPDATE od_journal_entries SET date = '2020-01-01' WHERE id = ?").run(entry.id),
      ).toThrow(/immutable/);
      expect(() => raw.prepare('DELETE FROM od_journal_entries WHERE id = ?').run(entry.id)).toThrow(
        /cannot be deleted/,
      );
      expect(() =>
        raw.prepare('UPDATE od_journal_lines SET amount = 1 WHERE entry_id = ?').run(entry.id),
      ).toThrow(/immutable/);
      expect(() => raw.prepare('DELETE FROM od_journal_lines WHERE entry_id = ?').run(entry.id)).toThrow(
        /cannot be deleted/,
      );
    });

    it('corrects a mistake with a reversing entry that links both ways', async () => {
      await withAccounts();
      const original = await postJournalEntry(ledger(), orgId, 'wsm-test', {
        date: '2026-03-01',
        memo: 'Wrong amount',
        lines: [
          { accountCode: '1100', direction: 'debit', amount: 250_00 },
          { accountCode: '4000', direction: 'credit', amount: 250_00 },
        ],
      });
      const { original: after, reversal } = await reverseJournalEntry(
        ledger(),
        orgId,
        original.id,
        'wsm-test',
      );
      expect(after.status).toBe('reversed');
      expect(after.reversedByEntryId).toBe(reversal.id);
      expect(reversal.reversesEntryId).toBe(original.id);
      // The mirror image: every debit became a credit.
      expect(reversal.lines.find((l) => l.accountCode === '1100')!.direction).toBe('credit');
      // And the net effect on the books is nothing.
      const tb = await trialBalance(ledger(), orgId, { asOf: '2026-12-31' });
      expect(tb.rows.find((r) => r.code === '1100')!.balance).toBe(0);
    });

    it('refuses to post into a closed period', async () => {
      await withAccounts();
      await closeLedgerPeriod(ledger(), orgId, {
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        closedBy: 'wsm-test',
      });
      await expect(
        postJournalEntry(ledger(), orgId, 'wsm-test', {
          date: '2026-01-15',
          lines: [
            { accountCode: '1000', direction: 'debit', amount: 100 },
            { accountCode: '3000', direction: 'credit', amount: 100 },
          ],
        }),
      ).rejects.toThrow(/closed period/);
      // A date outside the closed period is still fine.
      await expect(
        postJournalEntry(ledger(), orgId, 'wsm-test', {
          date: '2026-02-15',
          lines: [
            { accountCode: '1000', direction: 'debit', amount: 100 },
            { accountCode: '3000', direction: 'credit', amount: 100 },
          ],
        }),
      ).resolves.toBeTruthy();
    });

    it('reports a trial balance that balances, in each account’s normal direction', async () => {
      await withAccounts();
      await postJournalEntry(ledger(), orgId, 'wsm-test', {
        date: '2026-03-01',
        lines: [
          { accountCode: '1100', direction: 'debit', amount: 1_000_00 },
          { accountCode: '4000', direction: 'credit', amount: 1_000_00 },
        ],
      });
      const tb = await trialBalance(ledger(), orgId, { asOf: '2026-12-31' });
      expect(tb.balanced).toBe(true);
      expect(tb.totalDebit).toBe(tb.totalCredit);
      // Receivable is debit-normal, revenue is credit-normal — both read positive.
      expect(tb.rows.find((r) => r.code === '1100')!.balance).toBe(1_000_00);
      expect(tb.rows.find((r) => r.code === '4000')!.balance).toBe(1_000_00);
    });

    it('checkBalance is the whole rule, in one function', () => {
      expect(checkBalance([{ direction: 'debit', amount: 5 }, { direction: 'credit', amount: 5 }]).balanced).toBe(true);
      expect(checkBalance([{ direction: 'debit', amount: 5 }, { direction: 'credit', amount: 4 }]).balanced).toBe(false);
    });
  });

  describe('business hub', () => {
    async function setup() {
      return setUpBusinessHub(records(), ledger(), orgId, actor);
    }

    it('sets up the hub and is safe to run twice', async () => {
      const first = await setup();
      expect(first.created).toEqual(
        expect.arrayContaining(['customers', 'quotes', 'orders', 'invoices', 'payments']),
      );
      expect(first.accountsCreated).toBe(DEFAULT_CHART_OF_ACCOUNTS.length);

      const second = await setup();
      expect(second.created).toEqual([]);
      expect(second.skipped).toHaveLength(5);
      expect(second.accountsCreated).toBe(0);

      const status = await businessHubStatus(records(), ledger(), orgId);
      expect(status.ready).toBe(true);
    });

    it('posts an invoice to the books, once, traceable to the document', async () => {
      await setup();
      const customers = loadTableByName(records(), 'customers');
      const customer = createRecord(records(), customers, actor, { name: 'Acme Ltd' });
      const invoices = loadTableByName(records(), 'invoices');
      const invoice = createRecord(records(), invoices, actor, {
        invoice_number: 'INV-1001',
        customer: customer.id,
        issue_date: '2026-03-10',
        status: 'sent',
        subtotal: 1_000_00,
        tax: 200_00,
        total: 1_200_00,
      });

      const posted = await postDocumentIfReady(records(), ledger(), orgId, 'wsm-test', 'invoices', invoice.id);
      expect(posted.skipped).toBeNull();
      const entry = posted.entry!;
      // Receivable takes the full total; revenue only what we earned; the tax
      // is a liability because it was never ours.
      expect(entry.lines.find((l) => l.accountCode === '1100')!.amount).toBe(1_200_00);
      expect(entry.lines.find((l) => l.accountCode === '4000')!.amount).toBe(1_000_00);
      expect(entry.lines.find((l) => l.accountCode === '2100')!.amount).toBe(200_00);
      expect(entry.source).toMatchObject({ kind: 'invoice', recordId: invoice.id });

      // Posting again is a no-op rather than a double-count.
      const again = await postDocumentIfReady(records(), ledger(), orgId, 'wsm-test', 'invoices', invoice.id);
      expect(again.entry).toBeNull();
      expect(again.skipped).toBe('already posted');
    });

    it('does not post a draft invoice', async () => {
      await setup();
      const invoices = loadTableByName(records(), 'invoices');
      const customers = loadTableByName(records(), 'customers');
      const customer = createRecord(records(), customers, actor, { name: 'Acme' });
      const draft = createRecord(records(), invoices, actor, {
        invoice_number: 'INV-1002',
        customer: customer.id,
        issue_date: '2026-03-10',
        status: 'draft',
        total: 500_00,
      });
      const result = await postDocumentIfReady(records(), ledger(), orgId, 'wsm-test', 'invoices', draft.id);
      expect(result.entry).toBeNull();
      expect(result.skipped).toBe('invoice is draft');
    });

    it('records a payment as cash in, receivable down — not new revenue', async () => {
      await setup();
      const payments = loadTableByName(records(), 'payments');
      const payment = createRecord(records(), payments, actor, {
        reference: 'PAY-1001',
        received_date: '2026-03-20',
        amount: 1_200_00,
      });
      const result = await postDocumentIfReady(records(), ledger(), orgId, 'wsm-test', 'payments', payment.id);
      const entry = result.entry!;
      expect(entry.lines.find((l) => l.accountCode === '1000')!.direction).toBe('debit');
      expect(entry.lines.find((l) => l.accountCode === '1100')!.direction).toBe('credit');
      expect(entry.lines.some((l) => l.accountCode === '4000')).toBe(false);
    });

    it('unposting reverses rather than erases', async () => {
      await setup();
      const invoices = loadTableByName(records(), 'invoices');
      const customers = loadTableByName(records(), 'customers');
      const customer = createRecord(records(), customers, actor, { name: 'Acme' });
      const invoice = createRecord(records(), invoices, actor, {
        invoice_number: 'INV-1003',
        customer: customer.id,
        issue_date: '2026-03-10',
        status: 'sent',
        total: 300_00,
      });
      await postDocumentIfReady(records(), ledger(), orgId, 'wsm-test', 'invoices', invoice.id);
      const reversals = await unpostDocument(ledger(), orgId, 'wsm-test', invoice.id);
      expect(reversals).toHaveLength(1);
      const all = await listJournalEntries(ledger(), orgId, {});
      // Both the original and its reversal remain on the record.
      expect(all).toHaveLength(2);
      const tb = await trialBalance(ledger(), orgId, { asOf: '2026-12-31' });
      expect(tb.rows.find((r) => r.code === '1100')!.balance).toBe(0);
    });

    it('carries a quote through to an invoice, keeping the customer and totals', async () => {
      await setup();
      const customers = loadTableByName(records(), 'customers');
      const customer = createRecord(records(), customers, actor, { name: 'Acme' });
      const quotes = loadTableByName(records(), 'quotes');
      const quote = createRecord(records(), quotes, actor, {
        quote_number: 'QUO-1001',
        customer: customer.id,
        issue_date: '2026-03-01',
        status: 'accepted',
        total: 900_00,
      });
      const { data, targetTable } = convertDocument(records(), actor, 'quotes', 'invoices', quote.id, {
        number: 'INV-2001',
        date: '2026-03-05',
      });
      expect(targetTable.name).toBe('invoices');
      expect(data.customer).toBe(customer.id);
      expect(data.total).toBe(900_00);
      expect(data.status).toBe('draft');
    });

    it('numbers documents by looking at what already exists', async () => {
      await setup();
      expect(nextDocumentNumber(records(), 'invoices', 'INV')).toBe('INV-1001');
      const invoices = loadTableByName(records(), 'invoices');
      const customers = loadTableByName(records(), 'customers');
      const customer = createRecord(records(), customers, actor, { name: 'Acme' });
      createRecord(records(), invoices, actor, {
        invoice_number: 'INV-1042',
        customer: customer.id,
        issue_date: '2026-03-01',
        status: 'draft',
        total: 1,
      });
      expect(nextDocumentNumber(records(), 'invoices', 'INV')).toBe('INV-1043');
    });
  });

  describe('proposals', () => {
    async function hubReady() {
      await setUpBusinessHub(records(), ledger(), orgId, actor);
      const customers = loadTableByName(records(), 'customers');
      return createRecord(records(), customers, actor, { name: 'Acme' });
    }

    it('previews a change in plain language before anyone approves it', async () => {
      await hubReady();
      const preview = buildPreview(records(), [
        { kind: 'create-record', tableRef: 'customers', data: { name: 'New Co' } },
        { kind: 'add-field', tableRef: 'orders', field: { name: 'po_number', type: 'text' } },
      ]);
      expect(preview.warnings).toEqual([]);
      expect(preview.lines[0]!.summary).toContain('Add a row to Customers');
      expect(preview.lines[1]!.summary).toContain('Add "po_number" to Orders');
    });

    it('warns instead of throwing when an operation cannot be previewed', async () => {
      await hubReady();
      const preview = buildPreview(records(), [
        { kind: 'update-record', tableRef: 'customers', recordId: 'rec-nope', data: { name: 'x' } },
      ]);
      expect(preview.warnings).toHaveLength(1);
      expect(preview.warnings[0]).toMatch(/not found/);
    });

    it('reports a missing table reference as a validation problem, not an internal error', async () => {
      await hubReady();
      // Agents author these operations, so a field left off is an expected
      // input. It must read as "you left out the table", never as a leaked
      // TypeError from somewhere deep in the resolver.
      const preview = buildPreview(records(), [
        { kind: 'add-field', field: { name: 'po_number', type: 'text' } } as never,
      ]);
      expect(preview.warnings).toHaveLength(1);
      expect(preview.warnings[0]).toMatch(/table name or id is required/);
      expect(preview.warnings[0]).not.toMatch(/undefined|startsWith|Cannot read/);
    });

    it('changes nothing until approved, then applies everything', async () => {
      const customer = await hubReady();
      const proposal = await createProposal(ledger(), records(), orgId, {
        intent: 'Rename the customer',
        operations: [
          { kind: 'update-record', tableRef: 'customers', recordId: customer.id, data: { name: 'Acme Industries' } },
        ],
        createdBy: 'wsm-test',
      });
      expect(proposal.status).toBe('pending');
      // Still untouched while pending.
      expect(getRecord(records(), customer.id).data.name).toBe('Acme');

      const applied = await approveProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });
      expect(applied.status).toBe('applied');
      expect(getRecord(records(), customer.id).data.name).toBe('Acme Industries');
    });

    it('rejecting leaves the data alone', async () => {
      const customer = await hubReady();
      const proposal = await createProposal(ledger(), records(), orgId, {
        intent: 'Delete the customer',
        operations: [{ kind: 'delete-record', tableRef: 'customers', recordId: customer.id }],
        createdBy: 'wsm-test',
      });
      const rejected = await rejectProposal(ledger(), orgId, proposal.id, 'wsm-test');
      expect(rejected.status).toBe('rejected');
      expect(getRecord(records(), customer.id).deletedAt).toBeNull();
    });

    it('undoes an applied change, restoring the previous values', async () => {
      const customer = await hubReady();
      const proposal = await createProposal(ledger(), records(), orgId, {
        intent: 'Set a phone number',
        operations: [
          { kind: 'update-record', tableRef: 'customers', recordId: customer.id, data: { phone: '555-0100' } },
        ],
        createdBy: 'wsm-test',
      });
      await approveProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });
      expect(getRecord(records(), customer.id).data.phone).toBe('555-0100');

      const undone = await undoProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });
      expect(undone.status).toBe('undone');
      expect(getRecord(records(), customer.id).data.phone).toBeUndefined();
    });

    it('undoes a created record by removing it, keeping its history', async () => {
      await hubReady();
      const proposal = await createProposal(ledger(), records(), orgId, {
        intent: 'Add a customer',
        operations: [{ kind: 'create-record', tableRef: 'customers', data: { name: 'Temporary Co' } }],
        createdBy: 'wsm-test',
      });
      const applied = await approveProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });
      const created = applied.appliedEffects.find((e) => e.kind === 'record-created')!;
      await undoProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });
      const record = getRecord(records(), (created as { recordId: string }).recordId);
      expect(record.deletedAt).not.toBeNull();
    });

    it('undoing a posted entry reverses it rather than deleting it', async () => {
      await hubReady();
      const proposal = await createProposal(ledger(), records(), orgId, {
        intent: 'Record an opening balance',
        operations: [
          {
            kind: 'post-journal-entry',
            entry: {
              date: '2026-03-01',
              memo: 'Opening balance',
              lines: [
                { accountCode: '1000', direction: 'debit', amount: 100_00 },
                { accountCode: '3000', direction: 'credit', amount: 100_00 },
              ],
            },
          },
        ],
        createdBy: 'wsm-test',
      });
      await approveProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });
      await undoProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });
      const entries = await listJournalEntries(ledger(), orgId, {});
      expect(entries).toHaveLength(2);
      const tb = await trialBalance(ledger(), orgId, { asOf: '2026-12-31' });
      expect(tb.rows.find((r) => r.code === '1000')!.balance).toBe(0);
    });

    it('applies all-or-nothing when one operation fails', async () => {
      const customer = await hubReady();
      const proposal = await createProposal(ledger(), records(), orgId, {
        intent: 'One good change and one impossible one',
        operations: [
          { kind: 'update-record', tableRef: 'customers', recordId: customer.id, data: { name: 'Changed' } },
          { kind: 'update-record', tableRef: 'customers', recordId: 'rec-nope', data: { name: 'x' } },
        ],
        createdBy: 'wsm-test',
      });
      await expect(
        approveProposal(ledger(), orgId, proposal.id, 'wsm-test', {
          recordsDb: records(),
          ledgerDb: ledger(),
          actor,
        }),
      ).rejects.toThrow(/could not apply/);
      // The first operation was rolled back with the second.
      expect(getRecord(records(), customer.id).data.name).toBe('Acme');
    });

    it('adds a field on request, leaving existing rows valid', async () => {
      await hubReady();
      const orders = loadTableByName(records(), 'orders');
      const customers = loadTableByName(records(), 'customers');
      const customer = createRecord(records(), customers, actor, { name: 'Acme' });
      const order = createRecord(records(), orders, actor, {
        order_number: 'ORD-1001',
        customer: customer.id,
        issue_date: '2026-03-01',
        status: 'draft',
        total: 100,
      });

      const proposal = await createProposal(ledger(), records(), orgId, {
        intent: 'Add PO numbers to orders',
        operations: [
          { kind: 'add-field', tableRef: 'orders', field: { name: 'po_number', displayName: 'PO number', type: 'text' } },
        ],
        createdBy: 'wsm-test',
      });
      await approveProposal(ledger(), orgId, proposal.id, 'wsm-test', {
        recordsDb: records(),
        ledgerDb: ledger(),
        actor,
      });

      const updated = loadTableByName(records(), 'orders');
      expect(updated.fields.some((f) => f.name === 'po_number')).toBe(true);
      expect(updated.schemaVersion).toBe(2);
      // The pre-existing row is still readable and still valid.
      expect(getRecord(records(), order.id).data.order_number).toBe('ORD-1001');
      // And the new field accepts a value.
      const withPo = createRecord(records(), updated, actor, {
        order_number: 'ORD-1002',
        customer: customer.id,
        issue_date: '2026-03-02',
        status: 'draft',
        total: 200,
        po_number: 'PO-77',
      });
      expect(withPo.data.po_number).toBe('PO-77');
    });
  });

  describe('saved questions', () => {
    it('answers a metric question and pins it to the home screen', async () => {
      await setUpBusinessHub(records(), ledger(), orgId, actor);
      const customers = loadTableByName(records(), 'customers');
      const customer = createRecord(records(), customers, actor, { name: 'Acme' });
      const invoices = loadTableByName(records(), 'invoices');
      for (const [index, total] of [100_00, 250_00, 400_00].entries()) {
        createRecord(records(), invoices, actor, {
          invoice_number: `INV-90${index}`,
          customer: customer.id,
          issue_date: '2026-03-01',
          status: index === 0 ? 'paid' : 'sent',
          total,
        });
      }

      const question = await createSavedQuestion(ledger(), records(), orgId, 'wsm-test', {
        question: 'How much is outstanding?',
        tableRef: 'invoices',
        filters: [{ field: 'status', op: 'eq', value: 'sent' }],
        aggregate: { op: 'sum', field: 'total' },
        pin: true,
      });
      const answer = answerQuestion(records(), question);
      expect(answer.value).toBe(650_00);
      expect(answer.count).toBe(2);

      const widgets = await homeWidgets(ledger(), records(), orgId);
      expect(widgets).toHaveLength(1);
      expect(widgets[0]!.question.question).toBe('How much is outstanding?');

      await setQuestionPinned(ledger(), orgId, question.id, false);
      expect(await homeWidgets(ledger(), records(), orgId)).toHaveLength(0);
    });

    it('reports nothing rather than zero when there is no data to average', async () => {
      await setUpBusinessHub(records(), ledger(), orgId, actor);
      const question = await createSavedQuestion(ledger(), records(), orgId, 'wsm-test', {
        question: 'Average invoice',
        tableRef: 'invoices',
        aggregate: { op: 'avg', field: 'total' },
      });
      expect(answerQuestion(records(), question).value).toBeNull();
    });

    it('refuses a question aggregating a field that does not exist', async () => {
      await setUpBusinessHub(records(), ledger(), orgId, actor);
      await expect(
        createSavedQuestion(ledger(), records(), orgId, 'wsm-test', {
          question: 'Sum of nothing',
          tableRef: 'invoices',
          aggregate: { op: 'sum', field: 'not_a_field' },
        }),
      ).rejects.toThrow(/not a field/);
    });
  });

  describe('spreadsheet import', () => {
    it('parses quoted fields containing commas and newlines', () => {
      const rows = parseDelimited('a,b\n"one, two",three\n"line\nbreak",four');
      expect(rows[1]).toEqual(['one, two', 'three']);
      expect(rows[2]).toEqual(['line\nbreak', 'four']);
    });

    it('treats a doubled quote as an escaped quote', () => {
      expect(parseDelimited('a\n"say ""hi"""')[1]).toEqual(['say "hi"']);
    });

    it('guesses types and says why', () => {
      expect(guessColumnType('Issue Date', ['2026-01-01', '2026-02-02']).type).toBe('date');
      expect(guessColumnType('Total', ['$1,200.00', '$3.50']).type).toBe('money');
      expect(guessColumnType('Active', ['yes', 'no']).type).toBe('boolean');
      expect(guessColumnType('Count', ['1', '2']).type).toBe('integer');
      const zip = guessColumnType('Zip', ['02134', '01890']);
      // Leading zeros are data; reading these as numbers would destroy them.
      expect(zip.type).toBe('text');
      expect(zip.reason).toMatch(/zero-padded/);
    });

    it('converts money to integer minor units exactly once', () => {
      expect(coerceCell('$1,200.00', 'money')).toBe(120000);
      expect(coerceCell('3.5', 'money')).toBe(350);
      expect(coerceCell('', 'money')).toBeNull();
    });

    it('plans an import, then commits it', async () => {
      const csv = [
        'Name,Email,Total Due,Signed Up',
        'Acme Ltd,acme@example.com,"$1,200.00",2026-01-15',
        'Globex,globex@example.com,$450.50,2026-02-02',
      ].join('\n');

      const plan = buildImportPlan(records(), { content: csv, fileName: 'customers-export.csv' });
      expect(plan.rowCount).toBe(2);
      expect(plan.appendingToExisting).toBe(false);
      expect(plan.columns.map((c) => c.fieldName)).toEqual(['name', 'email', 'total_due', 'signed_up']);
      expect(plan.columns[2]!.type).toBe('money');
      expect(plan.columns[3]!.type).toBe('date');

      const result = commitImport(records(), actor, plan, csv);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);

      const table = loadTableByName(records(), plan.tableName);
      const { records: rows } = queryRecords(records(), table, {});
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.data.total_due as number).sort((a, b) => a - b)).toEqual([45050, 120000]);
    });

    it('refuses a file with no data rows rather than making an empty table', () => {
      expect(() => buildImportPlan(records(), { content: 'just,a,header' })).toThrow(/header row and at least one row/);
    });

    it('skips a malformed row instead of failing the whole import', () => {
      const csv = 'a,b\n1,2\n1,2,3,4\n5,6';
      const plan = buildImportPlan(records(), { content: csv, tableName: 'sample' });
      expect(plan.rowCount).toBe(2);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0]!.reason).toMatch(/but the header has/);
    });
  });
});
