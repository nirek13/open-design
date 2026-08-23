// Packs an organization wrote itself.
//
// These specs arrive over HTTP, possibly composed by a model, and become real
// tables. So the tests are mostly about what gets refused — a pack that stores
// cleanly but cannot install has moved the failure to after someone pressed a
// button expecting it to work.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { setUpBusinessHub } from '../src/workspace-data/hub.js';
import {
  createCustomPack,
  deleteCustomPack,
  getCustomPack,
  listCustomPacks,
  packAsTemplate,
  packSlug,
  updateCustomPack,
  validatePackSpec,
} from '../src/workspace-data/packs.js';
import { installTemplate } from '../src/workspace-data/templates.js';
import { loadTableByName, listTables } from '../src/workspace-data/schema.js';
import type { CustomTemplatePackSpec } from '@open-design/contracts';
import type { WorkspaceActor } from '../src/workspace-data/types.js';

const actor: WorkspaceActor = { kind: 'user', memberId: 'wsm-test' };

/** A small, valid pack: two tables, one linking to the other. */
const FLEET: CustomTemplatePackSpec = {
  displayName: 'Fleet',
  description: 'Vehicles and the trips they make.',
  tables: [
    {
      name: 'vehicles',
      displayName: 'Vehicles',
      description: 'What you drive.',
      fields: [
        { name: 'registration', displayName: 'Registration', type: 'text', required: true },
        { name: 'model', displayName: 'Model', type: 'text' },
        {
          name: 'status',
          displayName: 'Status',
          type: 'select',
          options: ['active', 'servicing', 'retired'],
        },
      ],
    },
    {
      name: 'trips',
      displayName: 'Trips',
      description: 'Where they went.',
      fields: [
        { name: 'reference', displayName: 'Reference', type: 'text', required: true },
        { name: 'vehicle', displayName: 'Vehicle', type: 'link', linkTo: 'vehicles' },
        { name: 'distance_km', displayName: 'Distance (km)', type: 'number' },
      ],
    },
  ],
};

describe('custom packs', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-packs-'));
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

  const spec = (overrides: Partial<CustomTemplatePackSpec> = {}): CustomTemplatePackSpec => ({
    ...FLEET,
    ...overrides,
    tables: overrides.tables ?? JSON.parse(JSON.stringify(FLEET.tables)),
  });

  // --- Storing ------------------------------------------------------------

  it('stores a valid pack and reads it back', async () => {
    const pack = await createCustomPack(db(), records(), orgId, 'wsm-test', { spec: spec() });

    expect(pack.slug).toBe('fleet');
    expect(pack.spec.tables).toHaveLength(2);
    expect((await listCustomPacks(db(), orgId))).toHaveLength(1);
    expect((await getCustomPack(db(), orgId, 'fleet')).id).toBe(pack.id);
  });

  it('records that the assistant wrote one, so a reviewer can tell', async () => {
    const pack = await createCustomPack(db(), records(), orgId, 'run-1', {
      spec: spec(),
      origin: 'agent',
    });

    expect(pack.origin).toBe('agent');
  });

  it('refuses two packs with the same name', async () => {
    await createCustomPack(db(), records(), orgId, 'wsm-test', { spec: spec() });

    await expect(
      createCustomPack(db(), records(), orgId, 'wsm-test', { spec: spec() }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  // --- Refusing -----------------------------------------------------------

  it('refuses a pack with no tables', () => {
    expect(() => validatePackSpec(records(), spec({ tables: [] }))).toThrowError(
      /at least one table/i,
    );
  });

  it('refuses a table name that collides with one already installed', () => {
    // Installing never overwrites, so this would silently do nothing.
    const bad = spec({
      tables: [{ ...FLEET.tables[0]!, name: 'customers' }],
    });

    expect(() => validatePackSpec(records(), bad)).toThrowError(/already exists/i);
  });

  it('refuses an illegal table or field name', () => {
    expect(() =>
      validatePackSpec(records(), spec({ tables: [{ ...FLEET.tables[0]!, name: 'Not Legal' }] })),
    ).toThrowError(/not a usable table name/i);

    expect(() =>
      validatePackSpec(
        records(),
        spec({
          tables: [
            {
              ...FLEET.tables[0]!,
              fields: [{ name: 'Bad Name', displayName: 'x', type: 'text' }],
            },
          ],
        }),
      ),
    ).toThrowError(/not a usable field name/i);
  });

  it('refuses a field name the record engine owns', () => {
    const bad = spec({
      tables: [
        {
          ...FLEET.tables[0]!,
          fields: [{ name: 'revision', displayName: 'Revision', type: 'text' }],
        },
      ],
    });

    expect(() => validatePackSpec(records(), bad)).toThrowError(/reserved/i);
  });

  it('refuses a type that does not exist', () => {
    const bad = spec({
      tables: [
        {
          ...FLEET.tables[0]!,
          fields: [{ name: 'thing', displayName: 'Thing', type: 'wormhole' as never }],
        },
      ],
    });

    expect(() => validatePackSpec(records(), bad)).toThrowError(/is not a field type/i);
  });

  it('refuses a select with no options', () => {
    // A select with no options is a text box that rejects everything typed
    // into it.
    const bad = spec({
      tables: [
        {
          ...FLEET.tables[0]!,
          fields: [{ name: 'state', displayName: 'State', type: 'select' }],
        },
      ],
    });

    expect(() => validatePackSpec(records(), bad)).toThrowError(/needs at least one option/i);
  });

  it('refuses a link that points nowhere', () => {
    const bad = spec({
      tables: [
        {
          ...FLEET.tables[1]!,
          fields: [{ name: 'ghost', displayName: 'Ghost', type: 'link', linkTo: 'nowhere' }],
        },
      ],
    });

    expect(() => validatePackSpec(records(), bad)).toThrowError(/not a table this pack defines/i);
  });

  it('allows a link to a table the organization already has', () => {
    const linked = spec({
      tables: [
        {
          name: 'site_visits',
          displayName: 'Site visits',
          description: '',
          fields: [
            { name: 'reference', displayName: 'Reference', type: 'text' },
            { name: 'customer', displayName: 'Customer', type: 'link', linkTo: 'customers' },
          ],
        },
      ],
    });

    expect(() => validatePackSpec(records(), linked)).not.toThrow();
  });

  it('refuses the same table twice within one pack', () => {
    const bad = spec({ tables: [FLEET.tables[0]!, { ...FLEET.tables[0]! }] });

    expect(() => validatePackSpec(records(), bad)).toThrowError(/twice/i);
  });

  it('reports every problem at once rather than one at a time', () => {
    const bad = spec({
      displayName: '',
      tables: [{ name: 'Bad Name', displayName: 'x', description: '', fields: [] }],
    });

    try {
      validatePackSpec(records(), bad);
      throw new Error('should have thrown');
    } catch (err) {
      const issues = (err as { details?: { issues?: unknown[] } }).details?.issues ?? [];
      // Fixing one error per round trip through an API is miserable.
      expect(issues.length).toBeGreaterThan(1);
    }
  });

  // --- Installing ---------------------------------------------------------

  it('installs through the same installer the built-in packs use', async () => {
    const pack = await createCustomPack(db(), records(), orgId, 'wsm-test', { spec: spec() });

    const result = await installTemplate(records(), db(), orgId, packAsTemplate(pack), actor);

    expect(result.created.sort()).toEqual(['trips', 'vehicles']);
    expect(loadTableByName(records(), 'vehicles')).toBeTruthy();
    // The link survived, pointing at the pack's own table.
    const trips = loadTableByName(records(), 'trips');
    const link = trips.fields.find((field) => field.name === 'vehicle')!;
    expect(link.type).toBe('link');
    expect((link.config as { targetTableId?: string }).targetTableId).toBe(
      loadTableByName(records(), 'vehicles').id,
    );
  });

  it('creates a link target before the table that points at it', async () => {
    // `trips` is listed after `vehicles`, but the installer must not rely on
    // the author having got the order right.
    const reversed = spec({ tables: [FLEET.tables[1]!, FLEET.tables[0]!] });
    const pack = await createCustomPack(db(), records(), orgId, 'wsm-test', {
      spec: reversed,
      slug: 'fleet-reversed',
    });

    await expect(
      installTemplate(records(), db(), orgId, packAsTemplate(pack), actor),
    ).resolves.toBeTruthy();
  });

  it('installing twice is harmless', async () => {
    const pack = await createCustomPack(db(), records(), orgId, 'wsm-test', { spec: spec() });
    await installTemplate(records(), db(), orgId, packAsTemplate(pack), actor);

    const again = await installTemplate(records(), db(), orgId, packAsTemplate(pack), actor);

    expect(again.created).toEqual([]);
    expect(again.skipped.sort()).toEqual(['trips', 'vehicles']);
  });

  it('seeds ledger accounts a pack declares', async () => {
    const withAccounts = spec({
      accounts: [{ code: '7000', name: 'Fleet Costs', type: 'expense' }],
    });
    const pack = await createCustomPack(db(), records(), orgId, 'wsm-test', {
      spec: withAccounts,
      slug: 'fleet-accounts',
    });

    const result = await installTemplate(records(), db(), orgId, packAsTemplate(pack), actor);

    expect(result.accountsCreated).toBe(1);
  });

  // --- Editing and deleting -----------------------------------------------

  it('can be edited after being installed without colliding with itself', async () => {
    const pack = await createCustomPack(db(), records(), orgId, 'wsm-test', { spec: spec() });
    await installTemplate(records(), db(), orgId, packAsTemplate(pack), actor);

    // Its own tables now exist; editing must not read them as collisions.
    const updated = await updateCustomPack(db(), records(), orgId, pack.slug, {
      ...pack.spec,
      description: 'Vehicles, trips, and mileage.',
    });

    expect(updated.description).toBe('Vehicles, trips, and mileage.');
  });

  it('deleting the definition leaves the tables it created alone', async () => {
    const pack = await createCustomPack(db(), records(), orgId, 'wsm-test', { spec: spec() });
    await installTemplate(records(), db(), orgId, packAsTemplate(pack), actor);

    await deleteCustomPack(db(), orgId, pack.slug);

    // A pack is a recipe; throwing away the recipe does not throw away the
    // meal — and the data in those tables is the customer's.
    expect(await listCustomPacks(db(), orgId)).toHaveLength(0);
    expect(listTables(records()).map((table) => table.name)).toContain('vehicles');
  });

  it('derives a usable slug from a display name', () => {
    expect(packSlug('Field Service Ops!')).toBe('field-service-ops');
    expect(packSlug('  Clinics  ')).toBe('clinics');
  });
});
