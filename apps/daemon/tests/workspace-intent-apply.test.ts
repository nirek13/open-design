// Saying it, then having it happen.
//
// The parser is tested in isolation elsewhere. This covers the part that
// actually changes data: an interpreted sentence going through the proposal
// engine, and coming back out again via undo.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { setUpBusinessHub } from '../src/workspace-data/hub.js';
import { interpretIntent } from '../src/workspace-data/intent.js';
import { approveProposal, createProposal, undoProposal } from '../src/workspace-data/proposals.js';
import { loadTableByName } from '../src/workspace-data/schema.js';
import { queryRecords } from '../src/workspace-data/query.js';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

describe('applying what was said', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-apply-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const records = () => manager.openWorkspace(orgId);
  const db = () => manager.workspaceExecutor(orgId);

  /** The route's path: interpret, propose, approve. */
  async function say(text: string) {
    const interpreted = interpretIntent(records(), text, {});
    const proposal = await createProposal(db(), records(), orgId, {
      intent: text,
      operations: interpreted.operations,
      origin: 'user',
      createdBy: 'wsm-test',
    });
    const applied = await approveProposal(db(), orgId, proposal.id, 'wsm-test', {
      recordsDb: records(),
      ledgerDb: db(),
      actor,
    });
    return { interpreted, proposal: applied };
  }

  it('adds a column that then really exists', async () => {
    await say('add a website column to customers');

    const field = loadTableByName(records(), 'customers').fields.find(
      (candidate) => candidate.name === 'website',
    );
    expect(field).toBeTruthy();
    expect(field!.type).toBe('text');
  });

  it('adds a row that then really exists', async () => {
    await say('add a customer called Northwind');

    const table = loadTableByName(records(), 'customers');
    const rows = queryRecords(records(), table, { limit: 10 }).records;
    expect(rows.map((row) => row.data.name)).toContain('Northwind');
  });

  it('a new field arrives optional, so existing rows stay valid', async () => {
    const table = loadTableByName(records(), 'customers');
    const { createRecord } = await import('../src/workspace-data/records.js');
    createRecord(records(), table, actor, { name: 'Existing' } as never);

    await say('add a website column to customers');

    // Adding a required column would invalidate every row already stored.
    const field = loadTableByName(records(), 'customers').fields.find((f) => f.name === 'website');
    expect(field!.required).toBe(false);
    const rows = queryRecords(records(), loadTableByName(records(), 'customers'), { limit: 10 }).records;
    expect(rows).toHaveLength(1);
  });

  it('undoes an added row', async () => {
    const { proposal } = await say('add a customer called Undo Me');

    await undoProposal(db(), orgId, proposal.id, 'wsm-test', {
      recordsDb: records(),
      ledgerDb: db(),
      actor,
    });

    const table = loadTableByName(records(), 'customers');
    const rows = queryRecords(records(), table, { limit: 10 }).records;
    expect(rows.map((row) => row.data.name)).not.toContain('Undo Me');
  });

  it('keeps a column on undo, and says so rather than dropping data', async () => {
    const { proposal } = await say('add a website column to customers');

    const undone = await undoProposal(db(), orgId, proposal.id, 'wsm-test', {
      recordsDb: records(),
      ledgerDb: db(),
      actor,
    });

    // Dropping a column would destroy whatever anyone has since stored in it,
    // which is worse than leaving an unused one behind.
    expect(undone.status).toBe('undone');
    expect(
      loadTableByName(records(), 'customers').fields.some((field) => field.name === 'website'),
    ).toBe(true);
  });

  it('creates a whole table from one sentence', async () => {
    await say('create a table called suppliers with name, email, phone');

    const table = loadTableByName(records(), 'suppliers');
    expect(table.fields.map((field) => field.name).sort()).toEqual(['email', 'name', 'phone']);
  });

  it('records the sentence as the intent, in the person’s own words', async () => {
    const { proposal } = await say('add a customer called Wording Matters');

    // The proposal log should read back as what was asked, not as a machine
    // restatement of it.
    expect(proposal.intent).toBe('add a customer called Wording Matters');
  });

  it('leaves the workspace untouched when the sentence was a question', () => {
    const before = loadTableByName(records(), 'customers').fields.length;
    const interpreted = interpretIntent(records(), 'show customers', {});

    expect(interpreted.operations).toEqual([]);
    expect(loadTableByName(records(), 'customers').fields).toHaveLength(before);
  });
});
