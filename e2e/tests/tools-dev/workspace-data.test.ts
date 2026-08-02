// @vitest-environment node

// User-level check of the permanent workspace data plane through a real
// tools-dev daemon. The promises under test are the ones the product is sold
// on: a workspace exists with zero setup, schemas are actually enforced,
// records never hard-delete, and every write leaves an audit trail.

import type { CreateWorkspaceTableRequest } from '@open-design/contracts';
import { describe, expect, test } from 'vitest';

import { createSmokeSuite } from '@/vitest/suite';
import {
  createOrganization,
  createWorkspaceRecord,
  createWorkspaceTable,
  listOrganizations,
  listWorkspaceAuditEvents,
  listWorkspaceRecordRevisions,
  listWorkspaceTables,
  queryWorkspaceRecords,
  restoreWorkspaceRecord,
  softDeleteWorkspaceRecord,
  updateWorkspaceRecord,
} from '@/vitest/workspace-data';

const EMPLOYEES: CreateWorkspaceTableRequest = {
  displayName: 'Employees',
  fields: [
    { name: 'full_name', required: true, type: 'text' },
    { name: 'email', required: true, type: 'text', unique: true },
    { name: 'base_pay', type: 'money', config: { currency: 'USD' } },
  ],
  name: 'employees',
};

describe('tools-dev workspace database', () => {
  test('enforces the schema and keeps full history for every write', { timeout: 180_000 }, async () => {
    const suite = await createSmokeSuite('tools-dev-workspace-data');

    await suite.with.toolsDev(async ({ webUrl }) => {
      // A workspace exists from daemon startup — no setup step required.
      const workspaces = await listOrganizations(webUrl);
      expect(workspaces.length).toBeGreaterThan(0);
      const workspaceId = workspaces[0]!.id;

      const table = await createWorkspaceTable(webUrl, workspaceId, EMPLOYEES);
      expect(table.name).toBe('employees');
      expect(table.schemaVersion).toBe(1);
      expect(await listWorkspaceTables(webUrl, workspaceId)).toHaveLength(1);

      const record = await createWorkspaceRecord(webUrl, workspaceId, 'employees', {
        data: { base_pay: 120_000_00, email: 'ada@co.com', full_name: 'Ada Lovelace' },
      });
      expect(record.revision).toBe(1);
      expect(record.createdByKind).toBe('user');

      // Required fields, uniqueness, and integer-minor-unit money are all
      // rejected at the daemon, whatever UI submitted them.
      await expect(
        createWorkspaceRecord(webUrl, workspaceId, 'employees', { data: { email: 'x@co.com' } }),
      ).rejects.toThrow();
      await expect(
        createWorkspaceRecord(webUrl, workspaceId, 'employees', {
          data: { email: 'ada@co.com', full_name: 'Impostor' },
        }),
      ).rejects.toThrow();
      await expect(
        createWorkspaceRecord(webUrl, workspaceId, 'employees', {
          data: { base_pay: 120.55, email: 'bob@co.com', full_name: 'Bob' },
        }),
      ).rejects.toThrow();

      const updated = await updateWorkspaceRecord(webUrl, workspaceId, record.id, {
        data: { base_pay: 130_000_00 },
        expectedRevision: 1,
      });
      expect(updated.revision).toBe(2);
      // A second write at the same expected revision is a stale overwrite.
      await expect(
        updateWorkspaceRecord(webUrl, workspaceId, record.id, {
          data: { base_pay: 1 },
          expectedRevision: 1,
        }),
      ).rejects.toThrow();

      // Deleting hides the row from queries but never destroys it.
      await softDeleteWorkspaceRecord(webUrl, workspaceId, record.id);
      expect((await queryWorkspaceRecords(webUrl, workspaceId, 'employees')).records).toHaveLength(0);
      const withDeleted = await queryWorkspaceRecords(webUrl, workspaceId, 'employees', {
        includeDeleted: true,
      });
      expect(withDeleted.records).toHaveLength(1);
      await restoreWorkspaceRecord(webUrl, workspaceId, record.id);
      expect((await queryWorkspaceRecords(webUrl, workspaceId, 'employees')).records).toHaveLength(1);

      const revisions = await listWorkspaceRecordRevisions(webUrl, workspaceId, record.id);
      expect(revisions.map((revision) => revision.op)).toEqual([
        'create',
        'update',
        'soft-delete',
        'restore',
      ]);
      expect(revisions[0]!.data.base_pay).toBe(120_000_00);
      expect(revisions[1]!.data.base_pay).toBe(130_000_00);

      const audit = await listWorkspaceAuditEvents(webUrl, workspaceId, { tableId: table.id });
      const ops = audit.events.map((event) => event.op);
      expect(ops).toContain('table.create');
      expect(ops).toContain('record.create');
      expect(ops).toContain('record.soft-delete');
      expect(ops).toContain('record.restore');
      expect(audit.events.every((event) => typeof event.actorKind === 'string')).toBe(true);
    });
  });

  test('isolates data between workspaces', { timeout: 180_000 }, async () => {
    const suite = await createSmokeSuite('tools-dev-workspace-data-isolation');

    await suite.with.toolsDev(async ({ webUrl }) => {
      const first = (await listOrganizations(webUrl))[0]!;
      await createWorkspaceTable(webUrl, first.id, EMPLOYEES);

      const second = await createOrganization(webUrl, 'Finance');
      expect(second.id).not.toBe(first.id);
      // Tables live in the workspace that created them, never leaking across.
      expect(await listWorkspaceTables(webUrl, second.id)).toHaveLength(0);
      expect(await listWorkspaceTables(webUrl, first.id)).toHaveLength(1);
    });
  });
});
