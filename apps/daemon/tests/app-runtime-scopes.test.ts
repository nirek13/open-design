// What an app is allowed to ask for.
//
// `scopeAllows` is the single gate between untrusted app code and an
// organization's data, so these tests are written as an attacker would: every
// way to get at a table the app never declared.

import { describe, expect, it } from 'vitest';
import {
  APP_BRIDGE_PROTOCOL,
  appRequestsTableWrites,
  describeAppScopes,
  normalizeAppScopes,
  publicFacingScopes,
  publicScopeAllows,
  scopeAllows,
  type AppDataScope,
} from '@open-design/contracts';

const READ_INVOICES: AppDataScope[] = [{ table: 'invoices', mode: 'read' }];
const WRITE_DEALS: AppDataScope[] = [{ table: 'deals', mode: 'write' }];

describe('app data scopes', () => {
  it('allows a read the app declared', () => {
    expect(scopeAllows(READ_INVOICES, { kind: 'query', table: 'invoices' }).allowed).toBe(true);
    expect(scopeAllows(READ_INVOICES, { kind: 'describe', table: 'invoices' }).allowed).toBe(true);
  });

  it('refuses a table the app never asked for', () => {
    const decision = scopeAllows(READ_INVOICES, { kind: 'query', table: 'employees' });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/did not ask for access/i);
  });

  it('refuses a write when only read was declared', () => {
    // The most important single case: a read-only app must not be able to
    // change anything.
    expect(scopeAllows(READ_INVOICES, { kind: 'create', table: 'invoices' }).allowed).toBe(false);
    expect(
      scopeAllows(READ_INVOICES, { kind: 'update', table: 'invoices' }).allowed,
    ).toBe(false);
  });

  it('lets a write scope read the table it writes to', () => {
    // Otherwise an app could not read back what it just wrote.
    expect(scopeAllows(WRITE_DEALS, { kind: 'query', table: 'deals' }).allowed).toBe(true);
    expect(scopeAllows(WRITE_DEALS, { kind: 'create', table: 'deals' }).allowed).toBe(true);
  });

  it('does not let a write scope on one table reach another', () => {
    expect(scopeAllows(WRITE_DEALS, { kind: 'create', table: 'invoices' }).allowed).toBe(false);
  });

  it('refuses an empty scope list outright', () => {
    for (const kind of ['query', 'describe', 'create', 'update']) {
      expect(scopeAllows([], { kind, table: 'invoices' }).allowed).toBe(false);
    }
  });

  it('refuses a request that names no table', () => {
    expect(scopeAllows(READ_INVOICES, { kind: 'query' }).allowed).toBe(false);
    expect(scopeAllows(READ_INVOICES, { kind: 'query', table: '   ' }).allowed).toBe(false);
  });

  it('refuses a request kind it does not recognise', () => {
    // A new kind added to the union but not to the gate must be refused, not
    // silently permitted.
    expect(scopeAllows(WRITE_DEALS, { kind: 'delete', table: 'deals' }).allowed).toBe(false);
    expect(scopeAllows(WRITE_DEALS, { kind: 'drop-table', table: 'deals' }).allowed).toBe(false);
    expect(scopeAllows(WRITE_DEALS, { kind: '__proto__', table: 'deals' }).allowed).toBe(false);
  });

  it('does not match a table by prefix or case', () => {
    const scopes: AppDataScope[] = [{ table: 'invoices', mode: 'read' }];

    expect(scopeAllows(scopes, { kind: 'query', table: 'invoices_secret' }).allowed).toBe(false);
    expect(scopeAllows(scopes, { kind: 'query', table: 'INVOICES' }).allowed).toBe(false);
    expect(scopeAllows(scopes, { kind: 'query', table: 'invoice' }).allowed).toBe(false);
  });

  it('always answers the scopes question, so an app can adapt', () => {
    expect(scopeAllows([], { kind: 'scopes' }).allowed).toBe(true);
  });

  // --- Declaring ----------------------------------------------------------

  it('drops malformed scope entries rather than failing a publish', () => {
    const scopes = normalizeAppScopes([
      { table: 'invoices', mode: 'read' },
      { table: '', mode: 'read' },
      { table: 'deals', mode: 'sideways' },
      { table: 'deals', mode: 'write' },
      null,
      'invoices',
    ]);

    expect(scopes).toEqual([
      { table: 'invoices', mode: 'read' },
      { table: 'deals', mode: 'write' },
    ]);
  });

  it('deduplicates and bounds a declared list', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ table: `t${i}`, mode: 'read' as const }));
    expect(normalizeAppScopes([...READ_INVOICES, ...READ_INVOICES])).toHaveLength(1);
    expect(normalizeAppScopes(many).length).toBeLessThanOrEqual(64);
  });

  it('treats a non-array declaration as no access', () => {
    for (const input of [null, undefined, 'invoices', 42, {}]) {
      expect(normalizeAppScopes(input)).toEqual([]);
    }
  });

  it('says in plain words what an app can do', () => {
    expect(describeAppScopes([])).toMatch(/does not read or change/i);
    expect(describeAppScopes(READ_INVOICES)).toMatch(/read invoices/i);

    const mixed = describeAppScopes([
      { table: 'invoices', mode: 'read' },
      { table: 'deals', mode: 'write' },
    ]);
    expect(mixed).toMatch(/read invoices/);
    expect(mixed).toMatch(/read and change deals/);
  });

  it('allows mail.send only with a gmail write scope', () => {
    expect(scopeAllows(READ_INVOICES, { kind: 'mail.send' }).allowed).toBe(false);
    expect(scopeAllows([{ table: 'gmail', mode: 'read' }], { kind: 'mail.send' }).allowed).toBe(false);
    expect(
      scopeAllows([{ table: 'gmail', mode: 'write' }], { kind: 'mail.send' }).allowed,
    ).toBe(true);
  });

  it('describes gmail as sending from the connected account, not as a table', () => {
    expect(describeAppScopes([{ table: 'gmail', mode: 'write' }])).toMatch(
      /send Gmail from the connected account/,
    );
    expect(describeAppScopes([{ table: 'gmail', mode: 'write' }])).not.toMatch(/gmail/);
  });

  it('does not list a table twice when it is both read and written', () => {
    const described = describeAppScopes([
      { table: 'deals', mode: 'read' },
      { table: 'deals', mode: 'write' },
    ]);

    expect(described.match(/deals/g)).toHaveLength(1);
    expect(described).toMatch(/read and change deals/);
  });

  it('pins the protocol version so a shape change is a deliberate break', () => {
    expect(APP_BRIDGE_PROTOCOL).toBe(1);
  });
});

describe('public form scopes', () => {
  it('lets a public visitor append only when the app has write and the table is public-write', () => {
    const publicWrite = new Set(['leads']);
    expect(
      publicScopeAllows(WRITE_DEALS, publicWrite, { kind: 'create', table: 'deals' }).allowed,
    ).toBe(false);
    expect(
      publicScopeAllows([{ table: 'leads', mode: 'write' }], publicWrite, {
        kind: 'create',
        table: 'leads',
      }).allowed,
    ).toBe(true);
  });

  it('refuses query, update, and mail even on a public-write table', () => {
    const scopes: AppDataScope[] = [
      { table: 'leads', mode: 'write' },
      { table: 'gmail', mode: 'write' },
    ];
    const publicWrite = new Set(['leads']);
    expect(publicScopeAllows(scopes, publicWrite, { kind: 'query', table: 'leads' }).allowed).toBe(
      false,
    );
    expect(
      publicScopeAllows(scopes, publicWrite, { kind: 'update', table: 'leads' }).allowed,
    ).toBe(false);
    expect(publicScopeAllows(scopes, publicWrite, { kind: 'mail.send' }).allowed).toBe(false);
  });

  it('lets describe through so a form can learn the columns', () => {
    expect(
      publicScopeAllows([{ table: 'leads', mode: 'write' }], new Set(['leads']), {
        kind: 'describe',
        table: 'leads',
      }).allowed,
    ).toBe(true);
  });

  it('names only the public write tables when describing facing scopes', () => {
    expect(
      publicFacingScopes(
        [
          { table: 'leads', mode: 'write' },
          { table: 'invoices', mode: 'write' },
          { table: 'gmail', mode: 'write' },
        ],
        new Set(['leads']),
      ),
    ).toEqual([{ table: 'leads', mode: 'write' }]);
  });

  it('marks an app as needing a public host when it asked to write tables', () => {
    expect(appRequestsTableWrites([])).toBe(false);
    expect(appRequestsTableWrites([{ table: 'gmail', mode: 'write' }])).toBe(false);
    expect(appRequestsTableWrites([{ table: 'leads', mode: 'write' }])).toBe(true);
  });
});
