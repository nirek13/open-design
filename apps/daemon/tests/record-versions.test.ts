// Never losing data.
//
// The promise being tested: every version of a record is still there, you can
// see what changed at each step, and you can go back — without the act of
// going back destroying anything.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { setUpBusinessHub } from '../src/workspace-data/hub.js';
import {
  diffSnapshots,
  getRevisionSnapshot,
  recordHistory,
  restoreRecordVersion,
} from '../src/workspace-data/versions.js';
import { loadTableByName } from '../src/workspace-data/schema.js';
import {
  createRecord,
  getRecord,
  listRecordRevisions,
  restoreRecord,
  softDeleteRecord,
  updateRecord,
} from '../src/workspace-data/records.js';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

describe('record versions', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-versions-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    await setUpBusinessHub(manager.openWorkspace(orgId), manager.workspaceExecutor(orgId), orgId, actor);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.openWorkspace(orgId);
  const customers = () => loadTableByName(db(), 'customers');

  /** A customer edited twice, so there are three revisions to work with. */
  function customerWithHistory() {
    const record = createRecord(db(), customers(), actor, { name: 'Acme' } as never);
    updateRecord(db(), customers(), actor, record.id, { name: 'Acme Ltd' } as never);
    updateRecord(db(), customers(), actor, record.id, {
      name: 'Acme Limited',
      email: 'hi@acme.com',
    } as never);
    return record.id;
  }

  it('keeps every version, newest first', () => {
    const id = customerWithHistory();

    const history = recordHistory(db(), customers(), id);

    expect(history).toHaveLength(3);
    expect(history[0]!.isCurrent).toBe(true);
    expect(history[0]!.revision).toBe(3);
    expect(history[2]!.revision).toBe(1);
  });

  it('says what changed at each step, and nothing that did not', () => {
    const id = customerWithHistory();

    const history = recordHistory(db(), customers(), id);

    const latest = history[0]!;
    expect(latest.changes.map((change) => change.field).sort()).toEqual(['email', 'name']);
    const nameChange = latest.changes.find((change) => change.field === 'name')!;
    expect(nameChange.from).toBe('Acme Ltd');
    expect(nameChange.to).toBe('Acme Limited');
    // Fields that did not move must not appear, or a diff becomes unreadable.
    expect(latest.changes.some((change) => change.field === 'phone')).toBe(false);
  });

  it('goes back to an earlier version', () => {
    const id = customerWithHistory();

    restoreRecordVersion(db(), customers(), actor, id, 1);

    expect(getRecord(db(), id).data.name).toBe('Acme');
  });

  it('clears a field that was added after the version restored to', () => {
    const id = customerWithHistory();

    restoreRecordVersion(db(), customers(), actor, id, 1);

    // "Back to how it was" has to mean all of it — leaving the later email
    // behind would produce a record that never existed.
    expect(getRecord(db(), id).data.email ?? null).toBeNull();
  });

  it('restoring adds a version rather than rewinding the log', () => {
    const id = customerWithHistory();
    const before = listRecordRevisions(db(), id).length;

    restoreRecordVersion(db(), customers(), actor, id, 1);

    const after = listRecordRevisions(db(), id);
    // An undo that erases the fact it happened is how people lose the thing
    // they were recovering.
    expect(after).toHaveLength(before + 1);
    expect(after.some((revision) => revision.revision === 1)).toBe(true);
    expect(after.some((revision) => revision.revision === 3)).toBe(true);
  });

  it('can go back again after going back — history never traps you', () => {
    const id = customerWithHistory();
    restoreRecordVersion(db(), customers(), actor, id, 1);

    // Revision 3 is still in the log, so returning to it is possible.
    restoreRecordVersion(db(), customers(), actor, id, 3);

    expect(getRecord(db(), id).data.name).toBe('Acme Limited');
    expect(getRecord(db(), id).data.email).toBe('hi@acme.com');
  });

  it('does not write a version when restoring to where it already is', () => {
    const id = customerWithHistory();
    const before = listRecordRevisions(db(), id).length;

    restoreRecordVersion(db(), customers(), actor, id, 3);

    expect(listRecordRevisions(db(), id)).toHaveLength(before);
  });

  it('refuses an unknown revision rather than silently doing nothing', () => {
    const id = customerWithHistory();

    expect(() => restoreRecordVersion(db(), customers(), actor, id, 99)).toThrowError(
      /no revision 99/i,
    );
  });

  it('will not restore a version of a deleted record without undeleting first', () => {
    const id = customerWithHistory();
    softDeleteRecord(db(), customers(), actor, id);

    expect(() => restoreRecordVersion(db(), customers(), actor, id, 1)).toThrowError(
      /restore the record itself/i,
    );

    // And once undeleted, it works — the history survived the delete.
    restoreRecord(db(), customers(), actor, id);
    restoreRecordVersion(db(), customers(), actor, id, 1);
    expect(getRecord(db(), id).data.name).toBe('Acme');
  });

  it('keeps the whole history through a delete and undelete', () => {
    const id = customerWithHistory();
    softDeleteRecord(db(), customers(), actor, id);
    restoreRecord(db(), customers(), actor, id);

    // Deleting is soft; nothing about the past is thrown away.
    expect(listRecordRevisions(db(), id).length).toBeGreaterThanOrEqual(3);
    expect(getRevisionSnapshot(db(), id, 1).data.name).toBe('Acme');
  });

  it('reads a snapshot exactly as it was', () => {
    const id = customerWithHistory();

    expect(getRevisionSnapshot(db(), id, 1).data).toEqual({ name: 'Acme' });
    expect(getRevisionSnapshot(db(), id, 2).data.name).toBe('Acme Ltd');
  });

  it('shows a value from a field that no longer exists rather than hiding it', () => {
    const table = customers();
    const diffs = diffSnapshots(
      table,
      { name: 'Acme', legacy_code: 'X-1' } as never,
      { name: 'Acme' } as never,
    );

    // Hiding it would make the diff of an old revision lie about what changed.
    const legacy = diffs.find((diff) => diff.field === 'legacy_code');
    expect(legacy).toBeTruthy();
    expect(legacy!.from).toBe('X-1');
    expect(legacy!.to).toBeNull();
  });

  it('does not report a change between the different spellings of blank', () => {
    const diffs = diffSnapshots(customers(), { name: 'A', notes: '' } as never, {
      name: 'A',
      notes: null,
    } as never);

    expect(diffs).toEqual([]);
  });

  it('records the creating revision with no changes listed', () => {
    const record = createRecord(db(), customers(), actor, { name: 'Fresh' } as never);

    const history = recordHistory(db(), customers(), record.id);

    expect(history).toHaveLength(1);
    expect(history[0]!.op).toBe('create');
  });
});
