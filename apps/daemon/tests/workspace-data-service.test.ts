import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization, listOrganizations, createOrganization, ensureLocalOwnerUser, listOrgMembers } from '../src/workspace-data/tenancy.js';
import { createTable, validateRecordData, loadTable } from '../src/workspace-data/schema.js';
import { createRecord, getRecord, listRecordRevisions, restoreRecord, softDeleteRecord, updateRecord } from '../src/workspace-data/records.js';
import { queryRecords } from '../src/workspace-data/query.js';
import { listAuditEvents } from '../src/workspace-data/audit.js';
import { WorkspaceDataError } from '../src/workspace-data/errors.js';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

describe('workspace data service', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-workspace-data-'));
    manager = new WorkspaceDbManager(tempDir);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function bootWorkspace() {
    const workspace = await ensureDefaultOrganization(manager.directoryExecutor);
    return { workspace, db: manager.openWorkspace(workspace.id) };
  }

  function employeesTable(db: ReturnType<WorkspaceDbManager['openWorkspace']>) {
    return createTable(
      db,
      {
        name: 'employees',
        displayName: 'Employees',
        fields: [
          { name: 'full_name', type: 'text', required: true },
          { name: 'email', type: 'text', required: true, unique: true },
          { name: 'salary', type: 'money', config: { currency: 'USD' } },
          { name: 'level', type: 'select', config: { options: ['junior', 'senior'] } },
          { name: 'active', type: 'boolean' },
        ],
      },
      actor,
    );
  }

  it('bootstraps a default workspace with a local owner member', async () => {
    const workspace = await ensureDefaultOrganization(manager.directoryExecutor);
    expect(await listOrganizations(manager.directoryExecutor)).toHaveLength(1);
    const members = await listOrgMembers(manager.directoryExecutor, workspace.id);
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe('owner');
    // Idempotent: a second call reuses the existing workspace.
    expect((await ensureDefaultOrganization(manager.directoryExecutor)).id).toBe(workspace.id);
  });

  it('creates additional workspaces with isolated data files', async () => {
    const { db } = await bootWorkspace();
    employeesTable(db);
    const ownerUserId = await ensureLocalOwnerUser(manager.directoryExecutor);
    const second = await createOrganization(manager.directoryExecutor, { name: 'Second', ownerUserId });
    const secondDb = manager.openWorkspace(second.id);
    expect(() => loadTable(secondDb, 'tbl-anything')).toThrow(WorkspaceDataError);
    expect((secondDb.prepare('SELECT COUNT(*) AS n FROM od_tables').get() as any).n).toBe(0);
  });

  it('rejects invalid schemas with per-field validation issues', async () => {
    const { db } = await bootWorkspace();
    expect(() =>
      createTable(
        db,
        {
          name: 'Bad Name',
          fields: [
            { name: 'id', type: 'text' },
            { name: 'dup', type: 'text' },
            { name: 'dup', type: 'text' },
            { name: 'choice', type: 'select' },
            { name: 'flag', type: 'boolean', unique: true },
          ],
        },
        actor,
      ),
    ).toThrowError(/name|reserved|duplicate|options|unique/);
  });

  it('validates record payloads against the schema', async () => {
    const { db } = await bootWorkspace();
    const table = employeesTable(db);
    const cases: Array<Record<string, unknown>> = [
      { email: 'a@b.c' }, // missing required full_name
      { full_name: 'A', email: 'a@b.c', level: 'principal' }, // bad select
      { full_name: 'A', email: 'a@b.c', salary: 10.5 }, // money float
      { full_name: 'A', email: 'a@b.c', unknown_field: 1 }, // unknown field
      { full_name: 42, email: 'a@b.c' }, // wrong type
    ];
    for (const data of cases) {
      expect(() => validateRecordData(table, data as any)).toThrowError(WorkspaceDataError);
    }
    expect(() =>
      validateRecordData(table, { full_name: 'A', email: 'a@b.c', salary: 120000_00, level: 'senior', active: true }),
    ).not.toThrow();
  });

  it('enforces uniqueness via the engine, including the soft-delete/restore interplay', async () => {
    const { db } = await bootWorkspace();
    const table = employeesTable(db);
    const first = createRecord(db, table, actor, { full_name: 'Ada', email: 'ada@co.com' });
    expect(() => createRecord(db, table, actor, { full_name: 'Ada 2', email: 'ada@co.com' })).toThrowError(
      /collides/,
    );
    // Soft-deleting frees the unique value for new records...
    softDeleteRecord(db, table, actor, first.id);
    const replacement = createRecord(db, table, actor, { full_name: 'Ada 3', email: 'ada@co.com' });
    expect(replacement.id).not.toBe(first.id);
    // ...and restoring the original then collides atomically.
    expect(() => restoreRecord(db, table, actor, first.id)).toThrowError(/collides/);
  });

  it('writes a revision and an audit event for every mutation', async () => {
    const { db } = await bootWorkspace();
    const table = employeesTable(db);
    const record = createRecord(db, table, actor, { full_name: 'Ada', email: 'ada@co.com' });
    updateRecord(db, table, actor, record.id, { full_name: 'Ada L.' });
    softDeleteRecord(db, table, actor, record.id);
    restoreRecord(db, table, actor, record.id);

    const revisions = listRecordRevisions(db, record.id);
    expect(revisions.map((revision) => revision.op)).toEqual(['create', 'update', 'soft-delete', 'restore']);
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2, 3, 4]);
    expect(revisions[1]?.data.full_name).toBe('Ada L.');

    const audit = listAuditEvents(db, { subjectId: record.id });
    expect(audit.events.map((event) => event.op)).toEqual([
      'record.restore',
      'record.soft-delete',
      'record.update',
      'record.create',
    ]);
    expect(audit.events.every((event) => event.actorKind === 'user' && event.actorMemberId === 'wsm-test')).toBe(true);
  });

  it('orders the audit trail by insertion, not by a millisecond timestamp', async () => {
    // Several events routinely land in the same millisecond — a single
    // transaction can clear referrer links while soft-deleting their target.
    // Ordering must still report causes before effects, so it keys off the
    // insertion sequence rather than created_at plus a random uuid.
    const { db } = await bootWorkspace();
    const table = employeesTable(db);
    const record = createRecord(db, table, actor, { full_name: 'Ada', email: 'ada@co.com' });
    for (let index = 0; index < 6; index += 1) {
      updateRecord(db, table, actor, record.id, { full_name: `Ada ${index}` });
    }
    const stamps = new Set(
      (db.prepare('SELECT created_at AS t FROM od_audit_events').all() as Array<{ t: number }>).map(
        (row) => row.t,
      ),
    );
    expect(stamps.size).toBeLessThan(8); // proves the timestamps collide

    const page = listAuditEvents(db, { subjectId: record.id });
    expect(page.events[page.events.length - 1]?.op).toBe('record.create');
    expect(page.events.slice(0, -1).every((event) => event.op === 'record.update')).toBe(true);

    // Paging must not drop or duplicate rows when timestamps tie either.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const chunk = listAuditEvents(db, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...chunk.events.map((event) => event.id));
      cursor = chunk.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(8); // table.create + record.create + 6 updates
  });

  it('makes audit events and revisions append-only below the app layer', async () => {
    const { db } = await bootWorkspace();
    const table = employeesTable(db);
    const record = createRecord(db, table, actor, { full_name: 'Ada', email: 'ada@co.com' });
    expect(() => db.prepare("UPDATE od_audit_events SET op = 'tampered'").run()).toThrowError(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM od_audit_events').run()).toThrowError(/append-only/);
    expect(() => db.prepare("UPDATE od_record_revisions SET op = 'tampered'").run()).toThrowError(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM od_record_revisions').run()).toThrowError(/append-only/);
    void record;
  });

  it('enforces optimistic concurrency via expectedRevision', async () => {
    const { db } = await bootWorkspace();
    const table = employeesTable(db);
    const record = createRecord(db, table, actor, { full_name: 'Ada', email: 'ada@co.com' });
    updateRecord(db, table, actor, record.id, { full_name: 'Ada L.' }, 1);
    expect(() => updateRecord(db, table, actor, record.id, { full_name: 'Stale' }, 1)).toThrowError(
      /revision 2, expected 1/,
    );
  });

  it('blocks writes against soft-deleted records', async () => {
    const { db } = await bootWorkspace();
    const table = employeesTable(db);
    const record = createRecord(db, table, actor, { full_name: 'Ada', email: 'ada@co.com' });
    softDeleteRecord(db, table, actor, record.id);
    expect(() => updateRecord(db, table, actor, record.id, { full_name: 'X' })).toThrowError(/deleted/);
  });

  describe('link integrity', () => {
    function withLinkedTables(
      db: ReturnType<WorkspaceDbManager['openWorkspace']>,
      onDelete: 'restrict' | 'clear',
    ) {
      const employees = employeesTable(db);
      const timesheets = createTable(
        db,
        {
          name: 'timesheets',
          fields: [
            { name: 'employee', type: 'link', config: { targetTableId: employees.id, onDelete } },
            { name: 'hours', type: 'number', required: true },
          ],
        },
        actor,
      );
      return { employees, timesheets };
    }

    it('rejects links to missing or soft-deleted targets', async () => {
      const { db } = await bootWorkspace();
      const { employees, timesheets } = withLinkedTables(db, 'restrict');
      expect(() => createRecord(db, timesheets, actor, { employee: 'rec-nope', hours: 8 })).toThrowError(
        /linked record/,
      );
      const employee = createRecord(db, employees, actor, { full_name: 'Ada', email: 'ada@co.com' });
      const sheet = createRecord(db, timesheets, actor, { employee: employee.id, hours: 8 });
      expect(sheet.data.employee).toBe(employee.id);
    });

    it("blocks soft-delete while active referrers exist (onDelete 'restrict')", async () => {
      const { db } = await bootWorkspace();
      const { employees, timesheets } = withLinkedTables(db, 'restrict');
      const employee = createRecord(db, employees, actor, { full_name: 'Ada', email: 'ada@co.com' });
      const sheet = createRecord(db, timesheets, actor, { employee: employee.id, hours: 8 });
      expect(() => softDeleteRecord(db, employees, actor, employee.id)).toThrowError(/still link/);
      softDeleteRecord(db, timesheets, actor, sheet.id);
      expect(softDeleteRecord(db, employees, actor, employee.id).deletedAt).not.toBeNull();
    });

    it("clears referrer links with their own audited revisions (onDelete 'clear')", async () => {
      const { db } = await bootWorkspace();
      const { employees, timesheets } = withLinkedTables(db, 'clear');
      const employee = createRecord(db, employees, actor, { full_name: 'Ada', email: 'ada@co.com' });
      const sheet = createRecord(db, timesheets, actor, { employee: employee.id, hours: 8 });
      softDeleteRecord(db, employees, actor, employee.id);
      const cleared = getRecord(db, sheet.id);
      expect(cleared.data.employee).toBeUndefined();
      expect(cleared.revision).toBe(2);
      const revisions = listRecordRevisions(db, sheet.id);
      expect(revisions.map((revision) => revision.op)).toEqual(['create', 'update']);
    });
  });

  describe('queries', () => {
    it('filters, sorts, and paginates with a stable cursor', async () => {
      const { db } = await bootWorkspace();
      const table = employeesTable(db);
      for (let index = 0; index < 7; index += 1) {
        createRecord(db, table, actor, {
          full_name: `Person ${index}`,
          email: `p${index}@co.com`,
          salary: index * 1000_00,
          level: index % 2 === 0 ? 'junior' : 'senior',
        });
      }
      const seniors = queryRecords(db, table, {
        filters: [{ field: 'level', op: 'eq', value: 'senior' }],
      });
      expect(seniors.records).toHaveLength(3);

      const contains = queryRecords(db, table, {
        filters: [{ field: 'full_name', op: 'contains', value: 'Person 3' }],
      });
      expect(contains.records).toHaveLength(1);

      const highPaid = queryRecords(db, table, {
        filters: [{ field: 'salary', op: 'gte', value: 4000_00 }],
        sort: { field: 'salary', direction: 'desc' },
      });
      expect(highPaid.records.map((record) => record.data.salary)).toEqual([6000_00, 5000_00, 4000_00]);

      const all: string[] = [];
      let cursor: string | null | undefined;
      do {
        const page = queryRecords(db, table, {
          sort: { field: 'salary', direction: 'asc' },
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...page.records.map((record) => String(record.data.email)));
        cursor = page.nextCursor;
      } while (cursor);
      expect(all).toEqual(['p0@co.com', 'p1@co.com', 'p2@co.com', 'p3@co.com', 'p4@co.com', 'p5@co.com', 'p6@co.com']);
    });

    it('excludes soft-deleted records unless includeDeleted is set', async () => {
      const { db } = await bootWorkspace();
      const table = employeesTable(db);
      const record = createRecord(db, table, actor, { full_name: 'Ada', email: 'ada@co.com' });
      softDeleteRecord(db, table, actor, record.id);
      expect(queryRecords(db, table).records).toHaveLength(0);
      expect(queryRecords(db, table, { includeDeleted: true }).records).toHaveLength(1);
    });

    it('rejects filters on unknown fields', async () => {
      const { db } = await bootWorkspace();
      const table = employeesTable(db);
      expect(() =>
        queryRecords(db, table, { filters: [{ field: 'nope', op: 'eq', value: 1 }] }),
      ).toThrowError(/unknown field/);
    });
  });
});
