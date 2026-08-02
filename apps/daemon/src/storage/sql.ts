// One async SQL surface over two very different engines.
//
// The organization layer has to run in two places that share nothing:
//
//   sqlite   — the packaged desktop app and the local dev loop. Offline,
//              zero setup, one file per organization.
//   postgres — Supabase (or any Postgres). The source of truth when people
//              in different places belong to the same organization, because
//              a file on someone's laptop cannot be shared.
//
// Everything above this module is written once against `SqlExecutor` and does
// not know which engine it is talking to. The two dialects genuinely differ,
// so rather than pretend otherwise, callers write SQL with `?` placeholders
// and this layer rewrites them to `$1, $2, …` for Postgres. Where the dialects
// diverge beyond placeholders (JSON access, upsert syntax), callers branch on
// `dialect` explicitly — a visible branch is safer than a leaky abstraction
// that silently does the wrong thing on one engine.
//
// better-sqlite3 is synchronous; its methods are wrapped in resolved promises
// so there is exactly one calling convention. That costs a microtask and buys
// a single code path.

import type Database from 'better-sqlite3';

export type SqlDialect = 'sqlite' | 'postgres';

export interface SqlExecutor {
  readonly dialect: SqlDialect;
  /** Rows from a SELECT. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** First row, or null. */
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** A write. `changes` is the affected row count. */
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** Run `fn` atomically. The executor passed to `fn` is the transaction;
   * using the outer executor inside would escape it. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Rewrite `?` placeholders to Postgres `$n`, leaving `?` inside string
 * literals alone. Callers write one dialect of placeholder and this is the
 * only place that knows the difference. */
export function toPostgresPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  for (let position = 0; position < sql.length; position += 1) {
    const char = sql[position]!;
    if (char === "'" && !inDouble) {
      // Doubled quotes ('') are an escaped quote, not a close-then-open.
      if (inSingle && sql[position + 1] === "'") {
        out += "''";
        position += 1;
        continue;
      }
      inSingle = !inSingle;
      out += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      out += char;
      continue;
    }
    if (char === '?' && !inSingle && !inDouble) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}

// --- SQLite ---------------------------------------------------------------

export class SqliteExecutor implements SqlExecutor {
  readonly dialect = 'sqlite' as const;
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /** Escape hatch for the few places that legitimately need the raw handle
   * (DDL that only exists on SQLite, PRAGMA reads). Postgres callers must not
   * reach for this. */
  get raw(): Database.Database {
    return this.#db;
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.#db.prepare(sql).all(...(params as unknown[])) as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    return (this.#db.prepare(sql).get(...(params as unknown[])) as T | undefined) ?? null;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const info = this.#db.prepare(sql).run(...(params as unknown[]));
    return { changes: info.changes };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // better-sqlite3's own `transaction()` helper cannot wrap an async
    // callback — it commits when the synchronous function returns, which
    // would be before any awaited work finished. Drive the statements
    // directly instead so the boundary actually covers the async body.
    this.#db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    }
  }
}

// --- Postgres / Supabase --------------------------------------------------

/** The slice of `pg`'s Client/Pool that this module uses, so the executor can
 * be unit-tested without a live database. */
export interface PgQueryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
}

export interface PgClientLike extends PgQueryable {
  release(): void;
}

export class PostgresExecutor implements SqlExecutor {
  readonly dialect = 'postgres' as const;
  readonly #queryable: PgQueryable;
  readonly #pool: PgPoolLike | null;

  constructor(queryable: PgQueryable, pool: PgPoolLike | null = null) {
    this.#queryable = queryable;
    this.#pool = pool;
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.#queryable.query(toPostgresPlaceholders(sql), params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const result = await this.#queryable.query(toPostgresPlaceholders(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (!this.#pool) {
      // Already inside a transaction (or handed a single client) — nesting
      // BEGIN would be a no-op with a warning, so run inline and let the
      // outermost transaction own the boundary.
      return fn(this);
    }
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresExecutor(client, null));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
