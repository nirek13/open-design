// The SQL layer that lets the organization code run on either a local SQLite
// file or Supabase Postgres. Everything here is verifiable without a live
// database: placeholder rewriting is pure, and the SQLite executor and the
// Postgres executor's control flow can both be exercised locally.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PostgresExecutor,
  SqliteExecutor,
  toPostgresPlaceholders,
  type PgClientLike,
  type PgPoolLike,
} from '../src/storage/sql.js';
import { resolveDaemonDbConfig, DaemonDbConfigError } from '../src/storage/daemon-db.js';

describe('toPostgresPlaceholders', () => {
  it('numbers placeholders in order', () => {
    expect(toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('leaves question marks inside string literals alone', () => {
    // A literal '?' is data, not a parameter. Rewriting it would corrupt the
    // value and silently shift every later placeholder by one.
    expect(toPostgresPlaceholders("SELECT ? WHERE label = 'why?'")).toBe(
      "SELECT $1 WHERE label = 'why?'",
    );
    expect(toPostgresPlaceholders(`SELECT ? , "col?name" FROM t`)).toBe(
      `SELECT $1 , "col?name" FROM t`,
    );
  });

  it('handles an escaped quote inside a literal', () => {
    expect(toPostgresPlaceholders("SELECT ? WHERE s = 'it''s ok?'")).toBe(
      "SELECT $1 WHERE s = 'it''s ok?'",
    );
  });

  it('is a no-op when there are no placeholders', () => {
    expect(toPostgresPlaceholders('SELECT 1')).toBe('SELECT 1');
  });
});

describe('SqliteExecutor', () => {
  let tempDir: string;
  let db: Database.Database;
  let executor: SqliteExecutor;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-sql-'));
    db = new Database(path.join(tempDir, 'test.sqlite'));
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT)');
    executor = new SqliteExecutor(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads and writes through the async surface', async () => {
    const write = await executor.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'Alpha']);
    expect(write.changes).toBe(1);
    expect(await executor.get('SELECT label FROM items WHERE id = ?', ['a'])).toEqual({
      label: 'Alpha',
    });
    expect(await executor.all('SELECT id FROM items')).toEqual([{ id: 'a' }]);
    expect(await executor.get('SELECT * FROM items WHERE id = ?', ['missing'])).toBeNull();
  });

  it('commits a transaction whose body awaits', async () => {
    await executor.transaction(async (tx) => {
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'Alpha']);
      // An await inside the boundary is the whole point: better-sqlite3's own
      // transaction() helper would have committed before this resumed.
      await Promise.resolve();
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['b', 'Beta']);
    });
    expect(await executor.all('SELECT id FROM items ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('rolls the whole transaction back when the body throws', async () => {
    await expect(
      executor.transaction(async (tx) => {
        await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'Alpha']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await executor.all('SELECT id FROM items')).toEqual([]);
  });

  it('rolls back when a later statement violates a constraint', async () => {
    await executor.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'Alpha']);
    await expect(
      executor.transaction(async (tx) => {
        await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['b', 'Beta']);
        await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'Duplicate']);
      }),
    ).rejects.toThrow();
    expect(await executor.all('SELECT id FROM items')).toEqual([{ id: 'a' }]);
  });
});

describe('PostgresExecutor', () => {
  function fakePool() {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const client: PgClientLike & { released: boolean } = {
      released: false,
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, ...(params === undefined ? {} : { params }) });
        if (sql === 'FAIL') throw new Error('boom');
        return { rows: [{ ok: true }], rowCount: 1 };
      },
      release() {
        this.released = true;
      },
    };
    const pool: PgPoolLike = {
      async query(sql: string, params?: readonly unknown[]) {
        return client.query(sql, params);
      },
      async connect() {
        return client;
      },
    };
    return { pool, client, calls };
  }

  it('rewrites placeholders before sending a query', async () => {
    const { pool, calls } = fakePool();
    const executor = new PostgresExecutor(pool, pool);
    await executor.all('SELECT * FROM t WHERE a = ? AND b = ?', [1, 2]);
    expect(calls[0]!.sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(calls[0]!.params).toEqual([1, 2]);
  });

  it('reports affected rows from rowCount', async () => {
    const { pool } = fakePool();
    const executor = new PostgresExecutor(pool, pool);
    expect(await executor.run('UPDATE t SET a = ?', [1])).toEqual({ changes: 1 });
  });

  it('wraps the body in BEGIN/COMMIT and always releases the client', async () => {
    const { pool, client, calls } = fakePool();
    const executor = new PostgresExecutor(pool, pool);
    await executor.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (?)', ['x']);
    });
    expect(calls.map((call) => call.sql)).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES ($1)',
      'COMMIT',
    ]);
    expect(client.released).toBe(true);
  });

  it('rolls back and still releases the client when the body throws', async () => {
    const { pool, client, calls } = fakePool();
    const executor = new PostgresExecutor(pool, pool);
    await expect(
      executor.transaction(async (tx) => {
        await tx.run('FAIL');
      }),
    ).rejects.toThrow('boom');
    expect(calls.map((call) => call.sql)).toEqual(['BEGIN', 'FAIL', 'ROLLBACK']);
    expect(client.released).toBe(true);
  });

  it('does not open a nested transaction when already inside one', async () => {
    const { pool, calls } = fakePool();
    const executor = new PostgresExecutor(pool, pool);
    await executor.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.run('INSERT INTO t VALUES (?)', ['x']);
      });
    });
    expect(calls.filter((call) => call.sql === 'BEGIN')).toHaveLength(1);
  });
});

describe('resolveDaemonDbConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to sqlite so a local install needs no configuration', () => {
    expect(resolveDaemonDbConfig({})).toEqual({ kind: 'sqlite' });
  });

  it('selects postgres from a Supabase connection string alone', () => {
    // Pasting the URL from the Supabase dashboard should be enough; making
    // the operator also set OD_DAEMON_DB would be a papercut.
    const config = resolveDaemonDbConfig({
      OD_SUPABASE_DB_URL: 'postgresql://od_user:secret@db.abcdefg.supabase.co:5432/postgres',
    });
    expect(config.kind).toBe('postgres');
    expect(config.postgres).toMatchObject({
      host: 'db.abcdefg.supabase.co',
      port: 5432,
      database: 'postgres',
      user: 'od_user',
      sslMode: 'require',
    });
  });

  it('accepts the conventional DATABASE_URL name', () => {
    const config = resolveDaemonDbConfig({
      DATABASE_URL: 'postgres://u:p@example.com:6543/mydb',
    });
    expect(config.kind).toBe('postgres');
    expect(config.postgres).toMatchObject({ port: 6543, database: 'mydb', user: 'u' });
  });

  it('ignores a non-postgres URL rather than misreading it', () => {
    expect(resolveDaemonDbConfig({ DATABASE_URL: 'mysql://u:p@host/db' })).toEqual({
      kind: 'sqlite',
    });
  });

  it('still supports discrete connection fields', () => {
    const config = resolveDaemonDbConfig({
      OD_DAEMON_DB: 'postgres',
      OD_PG_HOST: 'db.internal',
      OD_PG_DATABASE: 'od',
      OD_PG_USER: 'od',
    });
    expect(config.postgres).toMatchObject({ host: 'db.internal', port: 5432, sslMode: 'require' });
  });

  it('explains what is missing instead of connecting to nothing', () => {
    expect(() => resolveDaemonDbConfig({ OD_DAEMON_DB: 'postgres' })).toThrow(DaemonDbConfigError);
    expect(() => resolveDaemonDbConfig({ OD_DAEMON_DB: 'postgres' })).toThrow(/OD_SUPABASE_DB_URL/);
  });

  it('rejects an unknown backend name', () => {
    expect(() => resolveDaemonDbConfig({ OD_DAEMON_DB: 'mongo' })).toThrow(/unknown OD_DAEMON_DB/);
  });
});

describe('buildPoolConfig', () => {
  it('always sets the search path as a startup option', async () => {
    // Regression: this was originally a `SET search_path` issued once after
    // connecting. A pool hands out a different connection per query, so the
    // setting silently vanished on rotation and every unqualified table name
    // started reporting "does not exist" mid-session. It has to be a startup
    // parameter so the pool applies it to every connection it opens.
    const { buildPoolConfig } = await import('../src/storage/postgres-connection.js');
    const fromUrl = buildPoolConfig({
      kind: 'postgres',
      postgres: {
        connectionString: 'postgresql://u:p@db.example.supabase.co:5432/postgres',
        host: 'db.example.supabase.co',
        port: 5432,
        database: 'postgres',
        user: 'u',
        sslMode: 'require',
      },
    });
    expect(fromUrl.options).toBe('-c search_path=open_design');
    expect(fromUrl.connectionString).toContain('supabase.co');

    const fromFields = buildPoolConfig({
      kind: 'postgres',
      postgres: { host: 'h', port: 5432, database: 'd', user: 'u', sslMode: 'require' },
    });
    expect(fromFields.options).toBe('-c search_path=open_design');
    expect(fromFields.host).toBe('h');
  });

  it('keeps TLS on unless explicitly disabled', async () => {
    const { buildPoolConfig } = await import('../src/storage/postgres-connection.js');
    const base = { host: 'h', port: 5432, database: 'd', user: 'u' } as const;
    // Supabase's pooler presents a chain Node has no root for, so `require`
    // encrypts without demanding verification; `verify-full` opts in.
    expect(buildPoolConfig({ kind: 'postgres', postgres: { ...base, sslMode: 'require' } }).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(
      buildPoolConfig({ kind: 'postgres', postgres: { ...base, sslMode: 'verify-full' } }).ssl,
    ).toEqual({ rejectUnauthorized: true });
    expect(buildPoolConfig({ kind: 'postgres', postgres: { ...base, sslMode: 'disable' } }).ssl).toBe(
      false,
    );
  });
});
