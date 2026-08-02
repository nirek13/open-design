// Opening (and closing) the Postgres/Supabase connection.
//
// `pg` is imported lazily so an install that never configures Postgres — the
// packaged desktop app, every existing test — pays nothing for it and does
// not fail if the optional native bits are unavailable.

import type { DaemonDbConfig } from './daemon-db.js';
import { PostgresExecutor, type PgPoolLike } from './sql.js';
import { migratePostgres } from './postgres-schema.js';

export interface PostgresConnection {
  executor: PostgresExecutor;
  close: () => Promise<void>;
}

export class PostgresConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PostgresConnectionError';
  }
}

/** Supabase's pooler terminates TLS with a certificate chain Node does not
 * ship a root for, which is why `rejectUnauthorized: false` appears in every
 * Supabase example. Keep it narrow: only when SSL is on, and never a blanket
 * NODE_TLS_REJECT_UNAUTHORIZED. */
function sslFor(config: DaemonDbConfig): false | { rejectUnauthorized: boolean } {
  const mode = config.postgres?.sslMode ?? 'require';
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

export async function openPostgres(config: DaemonDbConfig): Promise<PostgresConnection> {
  if (config.kind !== 'postgres' || !config.postgres) {
    throw new PostgresConnectionError('openPostgres called without a postgres configuration');
  }

  let PoolCtor: new (options: Record<string, unknown>) => PgPoolLike & { end: () => Promise<void> };
  try {
    const pg = (await import('pg')) as unknown as {
      default?: { Pool: typeof PoolCtor };
      Pool?: typeof PoolCtor;
    };
    const resolved = pg.Pool ?? pg.default?.Pool;
    if (!resolved) throw new Error('pg module did not export Pool');
    PoolCtor = resolved;
  } catch (error) {
    throw new PostgresConnectionError(
      'the "pg" package is required for OD_DAEMON_DB=postgres but could not be loaded',
      { cause: error },
    );
  }

  const settings = config.postgres;
  const pool = new PoolCtor(
    settings.connectionString
      ? { connectionString: settings.connectionString, ssl: sslFor(config) }
      : {
          host: settings.host,
          port: settings.port,
          database: settings.database,
          user: settings.user,
          // Password comes from the environment only in the discrete-field
          // form; the connection-string form carries it inline.
          password: process.env.OD_PG_PASSWORD,
          ssl: sslFor(config),
        },
  );

  const executor = new PostgresExecutor(pool, pool);
  try {
    await migratePostgres(executor);
  } catch (error) {
    await pool.end().catch(() => {});
    throw new PostgresConnectionError(
      `could not prepare the Postgres schema at ${settings.host}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  return {
    executor,
    close: async () => {
      await pool.end();
    },
  };
}
