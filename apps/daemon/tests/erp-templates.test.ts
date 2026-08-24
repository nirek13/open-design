// Template packs, the buy side, the deal pipeline, and team chat.
//
// Written the same way the ledger tests are: mostly as refusals. A template
// installer that overwrites, a payables report that double-counts, or a
// private channel that answers "403" instead of "404" are the failures that
// matter, and each one gets a test that would go red.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import {
  installTemplate,
  installTemplateWithRequirements,
  orderTablesByDependency,
  templateStatuses,
} from '../src/workspace-data/templates.js';
import {
  billEntryPlan,
  billPaymentEntryPlan,
  convertDocument,
  isPostableTable,
  nextDocumentNumber,
  postDocumentIfReady,
  setUpBusinessHub,
} from '../src/workspace-data/hub.js';
import { dealToQuote, loadPipeline, moveDealStage } from '../src/workspace-data/crm.js';
import { loadStock } from '../src/workspace-data/inventory.js';
import { loadProjects } from '../src/workspace-data/projects.js';
import { daysBetween, loadPayables } from '../src/workspace-data/payables.js';
import {
  createChannel,
  deleteMessage,
  editMessage,
  getChannel,
  joinChannel,
  listChannels,
  listMessages,
  markChannelRead,
  openDirectMessage,
  postMessage,
  postSystemMessage,
  searchMessages,
  setUpDefaultChannels,
  toggleReaction,
  totalUnread,
} from '../src/workspace-data/chat.js';
import { loadTableByName } from '../src/workspace-data/schema.js';
import { createRecord } from '../src/workspace-data/records.js';
import { listJournalEntries, trialBalance } from '../src/workspace-data/ledger.js';
import { ERP_TEMPLATES, resolveTemplateOrder } from '@open-design/contracts';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };
const other: WorkspaceActor = { kind: 'user', memberId: 'wsm-other' };

describe('ERP templates', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-tmpl-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const records = () => manager.openWorkspace(orgId);
  const db = () => manager.workspaceExecutor(orgId);

  // --- Installing ---------------------------------------------------------

  it('installs a pack and reports what it created', async () => {
    const result = await installTemplate(records(), db(), orgId, 'sales', actor);
    expect(result.created).toContain('customers');
    expect(result.created).toContain('invoices');
    expect(result.skipped).toEqual([]);
  });

  it('never overwrites a table the organization already has', async () => {
    await installTemplate(records(), db(), orgId, 'sales', actor);
    const first = loadTableByName(records(), 'customers');

    const again = await installTemplate(records(), db(), orgId, 'sales', actor);

    expect(again.created).toEqual([]);
    expect(again.skipped).toContain('customers');
    // Same table, not a replacement wearing the same name.
    expect(loadTableByName(records(), 'customers').id).toBe(first.id);
  });

  it('installs a pack requirement before the pack that needs it', async () => {
    // CRM links deals to customers, which the sales pack owns.
    const installed = await installTemplateWithRequirements(records(), db(), orgId, 'crm', actor);

    expect(installed.map((r) => r.templateId)).toEqual(['sales', 'crm']);
    expect(loadTableByName(records(), 'deals')).toBeTruthy();
  });

  it('refuses a pack whose link target does not exist, naming what to install', async () => {
    // CRM alone, with no sales pack underneath it.
    await expect(installTemplate(records(), db(), orgId, 'crm', actor)).rejects.toMatchObject({
      code: 'TEMPLATE_REQUIREMENT_MISSING',
      status: 409,
    });
  });

  it('orders tables so a link target is created before the field pointing at it', () => {
    const purchasing = ERP_TEMPLATES.find((t) => t.id === 'purchasing')!;
    const ordered = orderTablesByDependency(purchasing.tables).map((t) => t.name);

    expect(ordered.indexOf('vendors')).toBeLessThan(ordered.indexOf('purchase_orders'));
    expect(ordered.indexOf('purchase_orders')).toBeLessThan(ordered.indexOf('bills'));
    expect(ordered.indexOf('bills')).toBeLessThan(ordered.indexOf('bill_payments'));
  });

  it('reports a pack as installed only when every table is present', async () => {
    const before = templateStatuses(records(), ERP_TEMPLATES);
    expect(before.find((t) => t.templateId === 'purchasing')!.installed).toBe(false);

    await installTemplate(records(), db(), orgId, 'purchasing', actor);

    const after = templateStatuses(records(), ERP_TEMPLATES);
    expect(after.find((t) => t.templateId === 'purchasing')!.installed).toBe(true);
  });

  it('resolves requirements into a dependency-first order without repeats', () => {
    expect(resolveTemplateOrder('crm')).toEqual(['sales', 'crm']);
    expect(resolveTemplateOrder('purchasing')).toEqual(['purchasing']);
  });

  it('leaves the hub setup path working through the shared installer', async () => {
    const setup = await setUpBusinessHub(records(), db(), orgId, actor);
    expect(setup.created).toContain('customers');
    expect(setup.accountsCreated).toBeGreaterThan(0);
  });

  // --- Purchasing ---------------------------------------------------------

  describe('the buy side', () => {
    beforeEach(async () => {
      await setUpBusinessHub(records(), db(), orgId, actor);
      await installTemplate(records(), db(), orgId, 'purchasing', actor);
    });

    const newVendor = (name: string) =>
      createRecord(records(), loadTableByName(records(), 'vendors'), actor, { name }).id;

    const newBill = (fields: Record<string, unknown>) =>
      createRecord(records(), loadTableByName(records(), 'bills'), actor, {
        bill_number: 'BILL-1001',
        issue_date: '2026-03-01',
        status: 'approved',
        total: 12_000,
        ...fields,
      } as never);

    it('posts an approved bill as expense and payable', async () => {
      const vendor = newVendor('Acme Supply');
      const bill = newBill({ vendor, total: 12_000, tax: 2_000 });

      const result = await postDocumentIfReady(records(), db(), orgId, 'wsm-test', 'bills', bill.id);

      expect(result.skipped).toBeNull();
      const lines = result.entry!.lines;
      // We owe the full amount; the cost is the amount net of recoverable tax.
      expect(lines.find((l) => l.accountCode === '2000')).toMatchObject({
        direction: 'credit',
        amount: 12_000,
      });
      expect(lines.find((l) => l.accountCode === '6000')).toMatchObject({
        direction: 'debit',
        amount: 10_000,
      });
      // Input tax is an asset, not a cost — we get it back.
      expect(lines.find((l) => l.accountCode === '2110')).toMatchObject({
        direction: 'debit',
        amount: 2_000,
      });
    });

    it('refuses to post a draft bill, because owing has not happened yet', async () => {
      const bill = newBill({ vendor: newVendor('Acme'), status: 'draft' });

      const result = await postDocumentIfReady(records(), db(), orgId, 'wsm-test', 'bills', bill.id);

      expect(result.entry).toBeNull();
      expect(result.skipped).toBe('bill is draft');
    });

    it('never posts the same bill twice', async () => {
      const bill = newBill({ vendor: newVendor('Acme') });
      await postDocumentIfReady(records(), db(), orgId, 'wsm-test', 'bills', bill.id);

      const second = await postDocumentIfReady(records(), db(), orgId, 'wsm-test', 'bills', bill.id);

      expect(second.entry).toBeNull();
      expect(second.skipped).toBe('already posted');
      expect(await listJournalEntries(db(), orgId, {})).toHaveLength(1);
    });

    it('sends a bill payment to the coded expense account when one is set', async () => {
      const bill = newBill({ vendor: newVendor('Acme'), expense_account: '5000', tax: 0 });

      const result = await postDocumentIfReady(records(), db(), orgId, 'wsm-test', 'bills', bill.id);

      expect(result.entry!.lines.find((l) => l.accountCode === '5000')).toMatchObject({
        direction: 'debit',
        amount: 12_000,
      });
    });

    it('paying a vendor clears the payable rather than touching the cost', async () => {
      const vendor = newVendor('Acme');
      const bill = newBill({ vendor, tax: 0 });
      await postDocumentIfReady(records(), db(), orgId, 'wsm-test', 'bills', bill.id);

      const payment = createRecord(records(), loadTableByName(records(), 'bill_payments'), actor, {
        reference: 'BP-1001',
        vendor,
        bill: bill.id,
        paid_date: '2026-03-15',
        amount: 12_000,
      } as never);
      await postDocumentIfReady(records(), db(), orgId, 'wsm-test', 'bill_payments', payment.id);

      const balance = await trialBalance(db(), orgId, { asOf: '2026-12-31' });
      const payable = balance.rows.find((row) => row.code === '2000')!;
      // Bill created the liability, payment cleared it.
      expect(payable.balance).toBe(0);
      expect(balance.balanced).toBe(true);
    });

    it('converts a purchase order into a bill that points back at it', async () => {
      const vendor = newVendor('Acme');
      const po = createRecord(records(), loadTableByName(records(), 'purchase_orders'), actor, {
        po_number: 'PO-1001',
        vendor,
        issue_date: '2026-03-01',
        status: 'sent',
        total: 5_000,
      } as never);

      const converted = convertDocument(records(), actor, 'purchase_orders', 'bills', po.id, {
        number: 'BILL-1002',
        date: '2026-03-05',
      });

      expect(converted.data.vendor).toBe(vendor);
      expect(converted.data.total).toBe(5_000);
      expect(converted.data.status).toBe('draft');
      // The link back is what makes "which PO is this against?" answerable.
      expect(converted.data.purchase_order).toBe(po.id);
    });

    it('numbers purchase orders from the highest existing one', () => {
      createRecord(records(), loadTableByName(records(), 'purchase_orders'), actor, {
        po_number: 'PO-1042',
        vendor: newVendor('Acme'),
        issue_date: '2026-03-01',
        status: 'draft',
        total: 100,
      } as never);

      expect(nextDocumentNumber(records(), 'purchase_orders', 'PO')).toBe('PO-1043');
    });

    it('knows which tables post to the books', () => {
      expect(isPostableTable('bills')).toBe(true);
      expect(isPostableTable('bill_payments')).toBe(true);
      // A purchase order is a commitment, not an accounting event.
      expect(isPostableTable('purchase_orders')).toBe(false);
      expect(isPostableTable('vendors')).toBe(false);
    });

    it('builds a bill plan that balances', () => {
      const table = loadTableByName(records(), 'bills');
      const bill = newBill({ vendor: newVendor('Acme'), total: 10_000, tax: 1_500 });
      const plan = billEntryPlan(table, bill);

      const debit = plan.lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0);
      const credit = plan.lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amount, 0);
      expect(debit).toBe(credit);
    });

    it('builds a bill payment plan that balances', () => {
      const table = loadTableByName(records(), 'bill_payments');
      const payment = createRecord(records(), table, actor, {
        reference: 'BP-2001',
        paid_date: '2026-04-01',
        amount: 7_500,
      } as never);
      const plan = billPaymentEntryPlan(table, payment);

      expect(plan.lines).toHaveLength(2);
      expect(plan.lines[0]!.amount).toBe(plan.lines[1]!.amount);
    });

    // --- Payables ---------------------------------------------------------

    it('reports outstanding as billed minus paid, not as a stored balance', () => {
      const vendor = newVendor('Acme');
      const bill = newBill({ vendor, bill_number: 'BILL-2001', due_date: '2026-03-31', total: 10_000 });
      createRecord(records(), loadTableByName(records(), 'bill_payments'), actor, {
        reference: 'BP-3001',
        bill: bill.id,
        paid_date: '2026-03-10',
        amount: 4_000,
      } as never);

      const payables = loadPayables(records(), { asOf: '2026-04-10' });

      const row = payables.rows.find((r) => r.billNumber === 'BILL-2001')!;
      expect(row.total).toBe(10_000);
      expect(row.paid).toBe(4_000);
      expect(row.outstanding).toBe(6_000);
      expect(row.daysOverdue).toBe(10);
      expect(payables.totalOverdue).toBe(6_000);
    });

    it('leaves fully paid and draft bills out of payables', () => {
      const vendor = newVendor('Acme');
      const paid = newBill({ vendor, bill_number: 'BILL-3001', total: 5_000 });
      createRecord(records(), loadTableByName(records(), 'bill_payments'), actor, {
        reference: 'BP-4001',
        bill: paid.id,
        paid_date: '2026-03-10',
        amount: 5_000,
      } as never);
      newBill({ vendor, bill_number: 'BILL-3002', status: 'draft', total: 9_000 });

      const payables = loadPayables(records(), { asOf: '2026-04-10' });

      expect(payables.rows).toHaveLength(0);
      expect(payables.totalOutstanding).toBe(0);
    });

    it('counts overdue days in calendar days from the due date', () => {
      expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
      // Not yet due reads negative rather than clamping to zero.
      expect(daysBetween('2026-04-30', '2026-04-20')).toBe(-10);
    });
  });

  // --- CRM ----------------------------------------------------------------

  describe('the deal pipeline', () => {
    beforeEach(async () => {
      await installTemplateWithRequirements(records(), db(), orgId, 'crm', actor);
    });

    const newCustomer = (name: string) =>
      createRecord(records(), loadTableByName(records(), 'customers'), actor, { name }).id;

    const newDeal = (fields: Record<string, unknown>) =>
      createRecord(records(), loadTableByName(records(), 'deals'), actor, {
        title: 'Deal',
        stage: 'new',
        ...fields,
      } as never);

    it('groups deals by stage with totals already summed', () => {
      const customer = newCustomer('Northwind');
      newDeal({ title: 'Big one', customer, stage: 'proposal', value: 100_000, probability: 50 });
      newDeal({ title: 'Small one', customer, stage: 'proposal', value: 20_000, probability: 25 });

      const pipeline = loadPipeline(records());

      const proposal = pipeline.stages.find((s) => s.stage === 'proposal')!;
      expect(proposal.dealCount).toBe(2);
      expect(proposal.totalValue).toBe(120_000);
      // 50% of 100k plus 25% of 20k.
      expect(proposal.weightedValue).toBe(55_000);
      expect(proposal.deals[0]!.customerName).toBe('Northwind');
    });

    it('counts a deal with no probability at face value rather than at zero', () => {
      newDeal({ customer: newCustomer('Acme'), stage: 'qualified', value: 50_000 });

      const stage = loadPipeline(records()).stages.find((s) => s.stage === 'qualified')!;

      expect(stage.weightedValue).toBe(50_000);
    });

    it('keeps won and lost out of the open forecast', () => {
      const customer = newCustomer('Acme');
      newDeal({ customer, stage: 'negotiation', value: 30_000, probability: 100 });
      newDeal({ customer, stage: 'won', value: 80_000 });
      newDeal({ customer, stage: 'lost', value: 40_000 });

      const pipeline = loadPipeline(records());

      expect(pipeline.openValue).toBe(30_000);
      expect(pipeline.weightedValue).toBe(30_000);
      expect(pipeline.wonValue).toBe(80_000);
      expect(pipeline.lostValue).toBe(40_000);
    });

    it('moves a deal between stages', () => {
      const deal = newDeal({ customer: newCustomer('Acme'), stage: 'new', value: 1_000 });

      moveDealStage(records(), actor, deal.id, 'qualified');

      const pipeline = loadPipeline(records());
      expect(pipeline.stages.find((s) => s.stage === 'new')!.dealCount).toBe(0);
      expect(pipeline.stages.find((s) => s.stage === 'qualified')!.dealCount).toBe(1);
    });

    it('refuses a stage that is not on the board', () => {
      const deal = newDeal({ customer: newCustomer('Acme') });

      expect(() => moveDealStage(records(), actor, deal.id, 'nearly-there')).toThrowError(
        /stage must be one of/,
      );
    });

    it('turns a won deal into a draft quote carrying the customer and value', () => {
      const customer = newCustomer('Northwind');
      const deal = newDeal({ title: 'Renewal', customer, stage: 'won', value: 64_000 });

      const quote = dealToQuote(records(), deal.id, { number: 'QUO-1001', date: '2026-05-01' });

      expect(quote.table).toBe('quotes');
      expect(quote.data.customer).toBe(customer);
      expect(quote.data.total).toBe(64_000);
      expect(quote.data.status).toBe('draft');
      expect(quote.data.quote_number).toBe('QUO-1001');
    });
  });

  // --- Team chat ----------------------------------------------------------

  describe('team chat', () => {
    it('creates the starting channels once, and is safe to call twice', async () => {
      const first = await setUpDefaultChannels(db(), orgId, 'wsm-test');
      const second = await setUpDefaultChannels(db(), orgId, 'wsm-test');

      expect(first.map((c) => c.slug)).toContain('general');
      expect(second).toEqual([]);
      expect(await listChannels(db(), orgId, 'wsm-test')).toHaveLength(first.length);
    });

    it('refuses a second channel with the same name', async () => {
      await createChannel(db(), orgId, 'wsm-test', { displayName: 'Deals' });

      await expect(
        createChannel(db(), orgId, 'wsm-test', { displayName: 'Deals' }),
      ).rejects.toMatchObject({ code: 'CHANNEL_SLUG_TAKEN', status: 409 });
    });

    it('derives a channel slug from its display name', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'Q3 Planning!' });

      expect(channel.slug).toBe('q3-planning');
    });

    it('hides a private channel from a non-member as missing, not as forbidden', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', {
        displayName: 'Board comp',
        visibility: 'private',
      });

      // A 403 here would confirm the channel exists, which is the leak.
      await expect(getChannel(db(), orgId, channel.slug, 'wsm-other')).rejects.toMatchObject({
        code: 'CHANNEL_NOT_FOUND',
        status: 404,
      });
      expect(await listChannels(db(), orgId, 'wsm-other')).toHaveLength(0);
    });

    it('lists public channels to everyone, joined or not', async () => {
      await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });

      const [channel] = await listChannels(db(), orgId, 'wsm-other');

      expect(channel!.slug).toBe('general');
      expect(channel!.joined).toBe(false);
    });

    it('treats posting as joining', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });

      await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'hello' });

      expect((await getChannel(db(), orgId, channel.slug, 'wsm-other')).joined).toBe(true);
    });

    it('counts unread messages from others, but never your own', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      await joinChannel(db(), orgId, channel.slug, 'wsm-other');

      await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'one' });
      await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'two' });
      await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'mine' });

      expect((await getChannel(db(), orgId, channel.slug, 'wsm-other')).unreadCount).toBe(2);
      // Their own two messages do not count against them, but the reply from
      // the other person does — posting is not the same as having read.
      expect((await getChannel(db(), orgId, channel.slug, 'wsm-test')).unreadCount).toBe(1);
      expect(await totalUnread(db(), orgId, 'wsm-other')).toBe(2);
    });

    it('clears unread when the channel is marked read', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      await joinChannel(db(), orgId, channel.slug, 'wsm-other');
      await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'hello' });

      const after = await markChannelRead(db(), orgId, channel.slug, 'wsm-other');

      expect(after.unreadCount).toBe(0);
    });

    it('reads a transcript oldest first', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'first' });
      await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'second' });

      const { messages } = await listMessages(db(), orgId, channel.slug, 'wsm-test');

      expect(messages.map((m) => m.body)).toEqual(['first', 'second']);
    });

    it('keeps replies out of the channel view and under their parent', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      const parent = await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'question?' });
      await postMessage(db(), orgId, channel.slug, 'wsm-other', {
        body: 'answer',
        parentMessageId: parent.id,
      });

      const channelView = await listMessages(db(), orgId, channel.slug, 'wsm-test');
      const thread = await listMessages(db(), orgId, channel.slug, 'wsm-test', {
        parentMessageId: parent.id,
      });

      expect(channelView.messages).toHaveLength(1);
      expect(channelView.messages[0]!.replyCount).toBe(1);
      expect(thread.messages.map((m) => m.body)).toEqual(['answer']);
    });

    it('flattens a reply to a reply onto the same thread', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      const parent = await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'root' });
      const reply = await postMessage(db(), orgId, channel.slug, 'wsm-test', {
        body: 'reply',
        parentMessageId: parent.id,
      });

      const nested = await postMessage(db(), orgId, channel.slug, 'wsm-test', {
        body: 'reply to reply',
        parentMessageId: reply.id,
      });

      expect(nested.parentMessageId).toBe(parent.id);
    });

    it('refuses an empty message', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });

      await expect(
        postMessage(db(), orgId, channel.slug, 'wsm-test', { body: '   ' }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_VALIDATION_FAILED' });
    });

    it('lets a file-only message through', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      const message = await postMessage(db(), orgId, channel.slug, 'wsm-test', {
        body: '',
        attachments: [
          {
            kind: 'file',
            id: 'file-1',
            label: 'brief.pdf',
            url: `/api/orgs/${orgId}/chat/files/file-1`,
            mimeType: 'application/pdf',
            fileName: 'brief.pdf',
            byteSize: 1200,
          },
        ],
      });
      expect(message.body).toBe('');
      expect(message.attachments[0]?.kind).toBe('file');
      expect(message.attachments[0]?.fileName).toBe('brief.pdf');
    });

    it('lets a person edit only their own message', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      const message = await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'mine' });

      await expect(
        editMessage(db(), orgId, message.id, 'wsm-other', 'not mine'),
      ).rejects.toMatchObject({ code: 'CHANNEL_ACCESS_DENIED', status: 403 });

      const edited = await editMessage(db(), orgId, message.id, 'wsm-test', 'mine, revised');
      expect(edited.body).toBe('mine, revised');
      expect(edited.editedAt).not.toBeNull();
    });

    it('lets an admin remove someone else’s message when forced', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      const message = await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'oops' });

      await deleteMessage(db(), orgId, message.id, 'wsm-test', { force: true });

      const { messages } = await listMessages(db(), orgId, channel.slug, 'wsm-test');
      expect(messages).toHaveLength(0);
    });

    it('carries a record link on a message so chat points back at the data', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });

      const message = await postMessage(db(), orgId, channel.slug, 'wsm-test', {
        body: 'this one is late',
        attachments: [{ kind: 'record', id: 'rec-1', tableName: 'invoices', label: 'INV-1042' }],
      });

      expect(message.attachments[0]).toMatchObject({ kind: 'record', label: 'INV-1042' });
    });

    it('writes a system message with no author', async () => {
      await setUpDefaultChannels(db(), orgId, 'wsm-test');

      const message = await postSystemMessage(db(), orgId, 'general', 'Purchasing pack installed');

      expect(message!.system).toBe(true);
      expect(message!.authorMemberId).toBeNull();
    });

    it('does not fail an operation because its announcement channel is gone', async () => {
      expect(await postSystemMessage(db(), orgId, 'nonexistent', 'something happened')).toBeNull();
    });

    it('pages backwards through history', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      for (let i = 0; i < 5; i += 1) {
        await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: `msg ${i}` });
      }

      const page = await listMessages(db(), orgId, channel.slug, 'wsm-test', { limit: 2 });

      expect(page.messages).toHaveLength(2);
      expect(page.nextBefore).not.toBeNull();
      const older = await listMessages(db(), orgId, channel.slug, 'wsm-test', {
        limit: 2,
        before: page.nextBefore!,
      });
      expect(older.messages.map((m) => m.body)).not.toEqual(page.messages.map((m) => m.body));
    });

    it('reuses a direct message between the same two people', async () => {
      const first = await openDirectMessage(db(), orgId, 'wsm-test', ['wsm-other']);
      const second = await openDirectMessage(db(), orgId, 'wsm-other', ['wsm-test']);

      expect(first.kind).toBe('dm');
      expect(first.visibility).toBe('private');
      expect(second.id).toBe(first.id);
    });

    it('toggles a reaction on a message', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      const message = await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'ship it' });

      const reacted = await toggleReaction(db(), orgId, message.id, 'wsm-test', '👍');
      expect(reacted.reactions).toEqual([
        expect.objectContaining({ emoji: '👍', count: 1, me: true }),
      ]);

      const cleared = await toggleReaction(db(), orgId, message.id, 'wsm-test', '👍');
      expect(cleared.reactions).toEqual([]);
    });

    it('searches messages the caller can see, and hides private ones', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
      await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'invoice INV-1042 is late' });
      const secret = await createChannel(db(), orgId, 'wsm-test', {
        displayName: 'Board comp',
        visibility: 'private',
      });
      await postMessage(db(), orgId, secret.slug, 'wsm-test', { body: 'secret-token-xyz' });

      const visible = await searchMessages(db(), orgId, 'wsm-test', 'INV-1042');
      expect(visible[0]?.message.body).toContain('INV-1042');

      const hidden = await searchMessages(db(), orgId, 'wsm-other', 'secret-token-xyz');
      expect(hidden).toEqual([]);
    });
  });

  // --- Inventory ----------------------------------------------------------

  describe('stock', () => {
    beforeEach(async () => {
      await installTemplate(records(), db(), orgId, 'inventory', actor);
    });

    const newProduct = (fields: Record<string, unknown>) =>
      createRecord(records(), loadTableByName(records(), 'products'), actor, {
        sku: 'SKU-1',
        name: 'Widget',
        ...fields,
      } as never);

    const move = (fields: Record<string, unknown>) =>
      createRecord(records(), loadTableByName(records(), 'stock_movements'), actor, {
        reference: `STK-${Math.round(Math.random() * 1e9)}`,
        movement_kind: 'receipt',
        quantity: 1,
        moved_at: '2026-05-01',
        ...fields,
      } as never);

    it('sums on hand from movements rather than storing a count', () => {
      const product = newProduct({ sku: 'SKU-A', unit_cost: 250 });
      move({ product: product.id, movement_kind: 'receipt', quantity: 100 });
      move({ product: product.id, movement_kind: 'shipment', quantity: 30 });

      const stock = loadStock(records());

      const level = stock.levels.find((l) => l.sku === 'SKU-A')!;
      expect(level.onHand).toBe(70);
      expect(level.stockValue).toBe(70 * 250);
      expect(stock.totalValue).toBe(70 * 250);
    });

    it('takes the direction from the movement kind, not from a signed quantity', () => {
      const product = newProduct({ sku: 'SKU-B' });
      // Recorded positive, as the schema requires — the kind makes it a loss.
      move({ product: product.id, movement_kind: 'write-off', quantity: 5 });

      expect(loadStock(records()).levels.find((l) => l.sku === 'SKU-B')!.onHand).toBe(-5);
    });

    it('flags a product at or below its reorder point', () => {
      const product = newProduct({ sku: 'SKU-C', reorder_point: 10 });
      move({ product: product.id, movement_kind: 'receipt', quantity: 10 });

      const stock = loadStock(records());

      // At the reorder point counts as needing a reorder, not just below it.
      expect(stock.levels.find((l) => l.sku === 'SKU-C')!.belowReorderPoint).toBe(true);
      expect(stock.needsReorder).toBe(1);
    });

    it('leaves a product with no reorder point unflagged', () => {
      newProduct({ sku: 'SKU-D' });

      const level = loadStock(records()).levels.find((l) => l.sku === 'SKU-D')!;
      expect(level.reorderPoint).toBeNull();
      expect(level.belowReorderPoint).toBe(false);
    });

    it('posts a write-off as a cost against the stock asset', async () => {
      await setUpBusinessHub(records(), db(), orgId, actor);
      const product = newProduct({ sku: 'SKU-E', unit_cost: 500 });
      const writeOff = move({
        product: product.id,
        movement_kind: 'write-off',
        quantity: 4,
        unit_cost: 500,
        reference: 'STK-9001',
      });

      const result = await postDocumentIfReady(
        records(),
        db(),
        orgId,
        'wsm-test',
        'stock_movements',
        writeOff.id,
      );

      expect(result.skipped).toBeNull();
      expect(result.entry!.lines.find((l) => l.accountCode === '5000')).toMatchObject({
        direction: 'debit',
        amount: 2_000,
      });
      expect(result.entry!.lines.find((l) => l.accountCode === '1300')).toMatchObject({
        direction: 'credit',
        amount: 2_000,
      });
    });

    it('does not post a receipt or a shipment, which would double-count', async () => {
      await setUpBusinessHub(records(), db(), orgId, actor);
      const product = newProduct({ sku: 'SKU-F', unit_cost: 100 });
      const receipt = move({
        product: product.id,
        movement_kind: 'receipt',
        quantity: 10,
        reference: 'STK-9002',
      });

      const result = await postDocumentIfReady(
        records(),
        db(),
        orgId,
        'wsm-test',
        'stock_movements',
        receipt.id,
      );

      expect(result.entry).toBeNull();
      // A receipt is paid for through its bill; posting here too would count
      // the same cost twice.
      expect(result.skipped).toBe('a receipt movement does not post to the books');
    });
  });

  // --- Expenses -----------------------------------------------------------

  describe('expense claims', () => {
    beforeEach(async () => {
      await setUpBusinessHub(records(), db(), orgId, actor);
      await installTemplate(records(), db(), orgId, 'expenses', actor);
    });

    const newClaim = (fields: Record<string, unknown>) =>
      createRecord(records(), loadTableByName(records(), 'expense_claims'), actor, {
        reference: 'EXP-1001',
        person: 'Nirek',
        spent_on: '2026-05-02',
        category: 'travel',
        status: 'approved',
        total: 9_000,
        ...fields,
      } as never);

    it('owes the claimant when a claim is approved', async () => {
      const claim = newClaim({ total: 9_000, tax: 1_000 });

      const result = await postDocumentIfReady(
        records(),
        db(),
        orgId,
        'wsm-test',
        'expense_claims',
        claim.id,
      );

      expect(result.skipped).toBeNull();
      // Owed to the person, not to a vendor — its own liability account.
      expect(result.entry!.lines.find((l) => l.accountCode === '2200')).toMatchObject({
        direction: 'credit',
        amount: 9_000,
      });
      expect(result.entry!.lines.find((l) => l.accountCode === '6000')).toMatchObject({
        direction: 'debit',
        amount: 8_000,
      });
    });

    it('does not post a claim that is only submitted', async () => {
      const claim = newClaim({ status: 'submitted' });

      const result = await postDocumentIfReady(
        records(),
        db(),
        orgId,
        'wsm-test',
        'expense_claims',
        claim.id,
      );

      expect(result.entry).toBeNull();
      expect(result.skipped).toBe('expense claim is submitted');
    });

    it('does not post a rejected claim', async () => {
      const claim = newClaim({ status: 'rejected', reference: 'EXP-1002' });

      const result = await postDocumentIfReady(
        records(),
        db(),
        orgId,
        'wsm-test',
        'expense_claims',
        claim.id,
      );

      expect(result.skipped).toBe('expense claim is rejected');
    });
  });

  // --- Projects -----------------------------------------------------------

  describe('projects', () => {
    beforeEach(async () => {
      await installTemplateWithRequirements(records(), db(), orgId, 'projects', actor);
    });

    const newProject = (fields: Record<string, unknown>) =>
      createRecord(records(), loadTableByName(records(), 'projects'), actor, {
        name: 'Rebuild',
        status: 'active',
        ...fields,
      } as never);

    const logTime = (fields: Record<string, unknown>) =>
      createRecord(records(), loadTableByName(records(), 'time_entries'), actor, {
        reference: `TIME-${Math.round(Math.random() * 1e9)}`,
        person: 'Nirek',
        worked_on: '2026-05-03',
        hours: 1,
        ...fields,
      } as never);

    it('prices billable hours at each entry’s own rate, not an average', () => {
      const project = newProject({ name: 'Rebuild', budget: 1_000_000 });
      logTime({ project: project.id, hours: 10, billable: true, rate: 15_000 });
      logTime({ project: project.id, hours: 5, billable: true, rate: 25_000 });
      logTime({ project: project.id, hours: 3, billable: false, rate: 15_000 });

      const summary = loadProjects(records());

      const row = summary.projects.find((p) => p.name === 'Rebuild')!;
      expect(row.hours).toBe(18);
      expect(row.billableHours).toBe(15);
      // 10 × 150.00 plus 5 × 250.00 — an average rate would give 15 × 200.00.
      expect(row.billableValue).toBe(10 * 15_000 + 5 * 25_000);
      expect(row.budgetRemaining).toBe(1_000_000 - row.billableValue);
    });

    it('counts a task as finished from either the tick or the status', () => {
      const project = newProject({ name: 'Tasks' });
      const tasks = loadTableByName(records(), 'project_tasks');
      createRecord(records(), tasks, actor, {
        title: 'a',
        project: project.id,
        status: 'done',
      } as never);
      createRecord(records(), tasks, actor, {
        title: 'b',
        project: project.id,
        status: 'todo',
        done: true,
      } as never);
      createRecord(records(), tasks, actor, {
        title: 'c',
        project: project.id,
        status: 'todo',
      } as never);

      const row = loadProjects(records()).projects.find((p) => p.name === 'Tasks')!;

      expect(row.taskCount).toBe(3);
      expect(row.openTaskCount).toBe(1);
    });

    it('sorts the projects that are over budget to the top', () => {
      const over = newProject({ name: 'Over', budget: 10_000 });
      newProject({ name: 'Under', budget: 1_000_000 });
      logTime({ project: over.id, hours: 10, billable: true, rate: 20_000 });

      expect(loadProjects(records()).projects[0]!.name).toBe('Over');
    });
  });

  // --- The wider registry -------------------------------------------------

  it('installs support on top of the packs it needs', async () => {
    const installed = await installTemplateWithRequirements(records(), db(), orgId, 'support', actor);

    // support -> crm -> sales, dependencies first and each exactly once.
    expect(installed.map((r) => r.templateId)).toEqual(['sales', 'crm', 'support']);
    expect(loadTableByName(records(), 'tickets')).toBeTruthy();
  });

  it('installs every pack in the registry without conflict', async () => {
    for (const template of ERP_TEMPLATES) {
      await installTemplateWithRequirements(records(), db(), orgId, template.id, actor);
    }

    const statuses = templateStatuses(records(), ERP_TEMPLATES);
    expect(statuses.every((status) => status.installed)).toBe(true);
  });

  it('gives every pack a unique table name across the whole registry', () => {
    const seen = new Map<string, string>();
    for (const template of ERP_TEMPLATES) {
      for (const table of template.tables) {
        // Two packs owning the same table name would make install order
        // decide the schema, which is exactly the kind of quiet ambiguity a
        // registry is supposed to remove.
        expect(seen.has(table.name)).toBe(false);
        seen.set(table.name, template.id);
      }
    }
    expect(seen.size).toBeGreaterThan(15);
  });

  it('points every link at a table some pack actually defines', () => {
    const known = new Set(ERP_TEMPLATES.flatMap((t) => t.tables.map((table) => table.name)));
    for (const template of ERP_TEMPLATES) {
      for (const table of template.tables) {
        for (const field of table.fields) {
          if (field.type !== 'link' || !field.linkTo) continue;
          expect(known.has(field.linkTo)).toBe(true);
        }
      }
    }
  });

  it('declares a requirement for every pack that links outside itself', () => {
    for (const template of ERP_TEMPLATES) {
      const own = new Set(template.tables.map((table) => table.name));
      const external = template.tables
        .flatMap((table) => table.fields)
        .filter((field) => field.type === 'link' && field.linkTo && !own.has(field.linkTo));
      if (external.length === 0) continue;
      // Otherwise installing it alone fails with a confusing error instead of
      // pulling in what it needs.
      expect(template.requires?.length ?? 0).toBeGreaterThan(0);
    }
  });

  void other;
});
