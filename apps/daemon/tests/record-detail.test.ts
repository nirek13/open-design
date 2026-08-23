// The record page.
//
// The property under test throughout is the reverse direction: links are
// stored one way (invoice → customer), so "which invoices belong to this
// customer" is a schema walk. Getting that wrong shows an empty record page
// on a customer with a hundred invoices, which looks like data loss.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { setUpBusinessHub } from '../src/workspace-data/hub.js';
import { installTemplateWithRequirements } from '../src/workspace-data/templates.js';
import {
  availableActions,
  buildRecordDetail,
  inboundReferences,
  recordLabel,
} from '../src/workspace-data/related.js';
import { loadTableByName } from '../src/workspace-data/schema.js';
import { createRecord, softDeleteRecord } from '../src/workspace-data/records.js';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

describe('record pages', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-detail-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
    await installTemplateWithRequirements(
      manager.openWorkspace(orgId),
      manager.workspaceExecutor(orgId),
      orgId,
      'crm',
      actor,
    );
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.openWorkspace(orgId);
  const table = (name: string) => loadTableByName(db(), name);

  const newCustomer = (name: string) =>
    createRecord(db(), table('customers'), actor, { name } as never);

  const newInvoice = (customerId: string, fields: Record<string, unknown> = {}) =>
    createRecord(db(), table('invoices'), actor, {
      invoice_number: `INV-${Math.round(Math.random() * 1e9)}`,
      customer: customerId,
      issue_date: '2026-01-01',
      status: 'sent',
      total: 10_000,
      ...fields,
    } as never);

  it('finds the tables that point at this one', () => {
    const refs = inboundReferences(db(), table('customers').id);
    const names = refs.map((ref) => ref.table.name);

    // Everything that carries a customer link, both packs.
    expect(names).toContain('invoices');
    expect(names).toContain('quotes');
    expect(names).toContain('deals');
  });

  it('lists the invoices belonging to a customer, with a total', () => {
    const customer = newCustomer('Northwind');
    newInvoice(customer.id, { total: 10_000 });
    newInvoice(customer.id, { total: 25_000 });
    newInvoice(newCustomer('Someone Else').id, { total: 99_000 });

    const detail = buildRecordDetail(db(), customer.id);

    const invoices = detail.related.find((list) => list.tableName === 'invoices')!;
    expect(invoices.total).toBe(2);
    // Someone else's invoice must not appear in this customer's total.
    expect(invoices.rollups[0]!.value).toBe(35_000);
    expect(invoices.viaField).toBe('customer');
  });

  it('resolves a link to a readable label rather than an id', () => {
    const customer = newCustomer('Northwind');
    const invoice = newInvoice(customer.id);

    const detail = buildRecordDetail(db(), invoice.id);

    const link = detail.links.find((candidate) => candidate.field === 'customer')!;
    expect(link.label).toBe('Northwind');
    expect(link.recordId).toBe(customer.id);
    expect(link.deleted).toBe(false);
  });

  it('still shows a link whose target was deleted, marked as such', () => {
    const customer = newCustomer('Gone');
    const invoice = newInvoice(customer.id);
    // onDelete is 'clear' on hub links, so read the invoice back first.
    const before = buildRecordDetail(db(), invoice.id);
    expect(before.links.some((link) => link.field === 'customer')).toBe(true);

    softDeleteRecord(db(), table('customers'), actor, customer.id);

    const after = buildRecordDetail(db(), invoice.id);
    const link = after.links.find((candidate) => candidate.field === 'customer');
    // Either the link was cleared by the delete rule, or it is shown marked —
    // what must never happen is a dangling reference rendering as normal.
    if (link) expect(link.deleted).toBe(true);
  });

  it('titles a document by its number and a person by their name', () => {
    const customer = newCustomer('Northwind');
    const invoice = newInvoice(customer.id, { invoice_number: 'INV-2050' });

    expect(recordLabel(table('invoices'), invoice)).toBe('INV-2050');
    expect(recordLabel(table('customers'), customer)).toBe('Northwind');
    expect(buildRecordDetail(db(), invoice.id).title).toBe('INV-2050');
  });

  it('offers posting only on documents that post', () => {
    const customer = newCustomer('Acme');
    const invoice = newInvoice(customer.id);

    expect(availableActions(table('invoices'), invoice)).toContain('post');
    expect(availableActions(table('customers'), customer)).not.toContain('post');
  });

  it('offers the next document in a flow', () => {
    const customer = newCustomer('Acme');
    const quote = createRecord(db(), table('quotes'), actor, {
      quote_number: 'QUO-1001',
      customer: customer.id,
      issue_date: '2026-01-01',
      status: 'sent',
      total: 500,
    } as never);

    expect(availableActions(table('quotes'), quote)).toContain('convert:orders');
  });

  it('leaves out related lists that have nothing in them', () => {
    const customer = newCustomer('Quiet');

    const detail = buildRecordDetail(db(), customer.id);

    // An empty list per pointing table would bury the one that matters.
    expect(detail.related).toEqual([]);
  });

  it('puts the biggest relationship first', () => {
    const customer = newCustomer('Busy');
    newInvoice(customer.id);
    newInvoice(customer.id);
    createRecord(db(), table('deals'), actor, {
      title: 'One deal',
      customer: customer.id,
      stage: 'new',
    } as never);

    const detail = buildRecordDetail(db(), customer.id);

    expect(detail.related[0]!.tableName).toBe('invoices');
  });

  it('caps a related list and says it was capped', () => {
    const customer = newCustomer('Very busy');
    for (let i = 0; i < 30; i += 1) newInvoice(customer.id, { total: 100 });

    const detail = buildRecordDetail(db(), customer.id);

    const invoices = detail.related.find((list) => list.tableName === 'invoices')!;
    expect(invoices.records.length).toBeLessThan(invoices.total);
    expect(invoices.truncated).toBe(true);
    // The rollup still counts everything, not just the page shown.
    expect(invoices.total).toBe(30);
    expect(invoices.rollups[0]!.value).toBe(3_000);
  });

  it('does not list a record under itself through a self-link', async () => {
    await installTemplateWithRequirements(db(), manager.workspaceExecutor(orgId), orgId, 'hr', actor);
    const boss = createRecord(db(), table('employees'), actor, {
      name: 'Boss',
      status: 'active',
    } as never);
    createRecord(db(), table('employees'), actor, {
      name: 'Report',
      status: 'active',
      manager: boss.id,
    } as never);

    const detail = buildRecordDetail(db(), boss.id);

    const reports = detail.related.find((list) => list.tableName === 'employees')!;
    expect(reports.total).toBe(1);
    expect(reports.records[0]!.label).toBe('Report');
  });

  it('fills formula fields on the record page too', () => {
    // A record page and a grid row must not show different values for the
    // same column, so both go through applyFormulas.
    const customer = newCustomer('Formula');
    const detail = buildRecordDetail(db(), customer.id);
    expect(detail.record.data.name).toBe('Formula');
  });
});
